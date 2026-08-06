/**
 * Boundary evidence tap.
 *
 * These records are plugin-local EVIDENCE, not kernel-signed receipts. The
 * kernel owns DecisionRecord/Receipt/ExecutionBoundaryRecord semantics
 * (helm-ai-kernel core/pkg/contracts); this plugin mints receipt *requests*
 * and boundary observations that a kernel-side ingester (e.g. the
 * svc-high-risk-loop-bridge pattern, research/opencode-study/26 §2.9) can
 * later verify and project into ProofGraph. Record types are namespaced
 * `opencode.*` so they can never masquerade as kernel-signed artifacts.
 *
 * Hashing: deterministic JSON (recursively sorted keys) -> SHA-256. This is
 * deliberately NOT claimed as full RFC 8785 JCS (no number canonicalization);
 * the kernel re-canonicalizes on ingestion. The hash here is a tamper-evident
 * local binding between the record and the hook-time args/output.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { NormalizedVerdict } from "./verdict.js";

/**
 * Deterministic JSON stringify: object keys sorted recursively, over
 * STRICTLY JSON-finite trees only.
 *
 * Typing/losslessness honesty (P2 CANONICALIZE_BUILD_FAILURE, P1
 * LOSSY_ARGUMENT_AUTHORIZATION): `JSON.stringify` is lossy — it returns
 * `undefined` for top-level undefined/functions/symbols, silently DROPS
 * undefined object properties, converts undefined/NaN/Infinity array
 * members to null, stringifies Dates, and throws on BigInt/cycles.
 * Authorization that binds to a normalized copy while the tool executes
 * the original would authorize materially different arguments. So any
 * value outside the exact JSON data model — undefined anywhere, functions,
 * symbols, BigInt, non-finite numbers, -0, non-plain objects,
 * altered array prototypes, or repeated references — is a hard, typed error
 * (fail closed). A value that passes validation is
 * guaranteed to round-trip losslessly through JSON.parse(canonicalize(v)).
 */
export class EvidenceSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceSerializationError";
  }
}

function assertJsonFiniteTree(value: unknown, seen: Set<object>, path: string): void {
  if (value === null) {
    return;
  }
  switch (typeof value) {
    case "boolean":
    case "string":
      return;
    case "number":
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw new EvidenceSerializationError(
          `number at ${path} is not valid boundary material (would serialize lossily)`,
        );
      }
      return;
    case "object": {
      if (seen.has(value)) {
        throw new EvidenceSerializationError(`repeated object reference at ${path} is not valid boundary material`);
      }
      // Symbol-keyed and non-enumerable properties are invisible to
      // JSON.stringify but visible to the executing tool — the evaluated
      // copy would silently lack them (P1 LOSSY_ARGUMENT_VALIDATION_GAPS).
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new EvidenceSerializationError(`symbol-keyed property at ${path} is not valid boundary material`);
      }
      const isArray = Array.isArray(value);
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== (isArray ? Array.prototype : Object.prototype)) {
        throw new EvidenceSerializationError(
          `non-plain ${isArray ? "array" : "object"} at ${path} is not valid boundary material`,
        );
      }
      seen.add(value);
      if (!isArray) {
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
          if (!descriptor.enumerable) {
            throw new EvidenceSerializationError(`non-enumerable property at ${path}.${key} is not valid boundary material`);
          }
          if (descriptor.get !== undefined || descriptor.set !== undefined) {
            throw new EvidenceSerializationError(
              `accessor property at ${path}.${key} is not valid boundary material (value could change after validation)`,
            );
          }
          assertJsonFiniteTree(descriptor.value, seen, `${path}.${key}`);
        }
      } else {
        const array = value as unknown[];
        // Sparse holes serialize as null — a different value than the tool
        // sees; extra named properties are invisible to JSON but visible to
        // the tool. Both are rejected.
        for (const name of Object.getOwnPropertyNames(array)) {
          const index = Number(name);
          if (
            name !== "length"
            && (!Number.isSafeInteger(index) || index < 0 || String(index) !== name || index >= array.length)
          ) {
            throw new EvidenceSerializationError(`non-index property "${name}" on array at ${path} is not valid boundary material`);
          }
        }
        for (let index = 0; index < array.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(array, index);
          if (descriptor === undefined) {
            throw new EvidenceSerializationError(`sparse array hole at ${path}[${index}] is not valid boundary material`);
          }
          if (!descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
            throw new EvidenceSerializationError(`non-data array element at ${path}[${index}] is not valid boundary material`);
          }
          assertJsonFiniteTree(descriptor.value, seen, `${path}[${index}]`);
        }
      }
      return;
    }
    default:
      // undefined, function, symbol, bigint
      throw new EvidenceSerializationError(
        `unserializable boundary material of type ${typeof value} at ${path}`,
      );
  }
}

export function canonicalize(value: unknown): string {
  assertJsonFiniteTree(value, new Set(), "$");
  const serialized: string | undefined = JSON.stringify(sortKeys(value));
  if (serialized === undefined) {
    // Unreachable for validated trees; kept as a fail-closed guard.
    throw new EvidenceSerializationError(
      "boundary material failed JSON serialization after validation",
    );
  }
  return serialized;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    // A normal object treats an own "__proto__" key as a prototype setter;
    // use a null-prototype serialization container so the key is preserved.
    const sorted: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeys(record[key]);
    }
    return sorted;
  }
  return value;
}

export function sha256Hex(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function hashBoundaryValue(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

export const BOUNDARY_OPEN_RECORD = "opencode.boundary.open.v1";
export const BOUNDARY_CLOSE_RECORD = "opencode.boundary.close.v1";
export const BOUNDARY_DENY_RECORD = "opencode.boundary.deny.v1";
export const PERMISSION_DECISION_RECORD = "opencode.permission.decision.v1";

interface RecordBase {
  record_type: string;
  plugin: string;
  plugin_version: string;
  session_id: string;
  call_id?: string;
  tool?: string;
  tenant_id: string;
  principal: string;
  /** ISO-8601 wall-clock stamp; evidence metadata only, never authority. */
  observed_at: string;
}

export interface BoundaryOpenRecord extends RecordBase {
  record_type: typeof BOUNDARY_OPEN_RECORD;
  tool: string;
  args_hash: string;
  verdict: "ALLOW";
  decision_id?: string;
  receipt_id?: string;
}

export interface BoundaryCloseRecord extends RecordBase {
  record_type: typeof BOUNDARY_CLOSE_RECORD;
  tool: string;
  args_hash: string;
  output_hash: string;
  outcome: "completed" | "error";
}

export interface BoundaryDenyRecord extends RecordBase {
  record_type: typeof BOUNDARY_DENY_RECORD;
  tool: string;
  args_hash: string;
  verdict: Exclude<NormalizedVerdict, "ALLOW">;
  reason_code: string;
  decision_id?: string;
  /** true when the deny was synthesized locally (kernel unreachable/unknown). */
  locally_synthesized: boolean;
}

export interface PermissionDecisionRecord extends RecordBase {
  record_type: typeof PERMISSION_DECISION_RECORD;
  permission: string;
  patterns: string[];
  verdict: NormalizedVerdict;
  mapped_status: "allow" | "deny" | "ask";
  reason_code?: string;
  decision_id?: string;
  locally_synthesized: boolean;
}

export type BoundaryRecord =
  | BoundaryOpenRecord
  | BoundaryCloseRecord
  | BoundaryDenyRecord
  | PermissionDecisionRecord;

export class EvidenceSinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceSinkError";
  }
}

export interface EvidenceSink {
  append(record: BoundaryRecord): Promise<void>;
}

/** JSONL sink: one record per line, one file per UTC day. */
export class JsonlEvidenceSink implements EvidenceSink {
  private readonly dir: string;
  private readonly now: () => Date;

  constructor(dir: string, now: () => Date = () => new Date()) {
    this.dir = dir;
    this.now = now;
  }

  async append(record: BoundaryRecord): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      const day = this.now().toISOString().slice(0, 10);
      await appendFile(
        join(this.dir, `opencode-governance-${day}.jsonl`),
        `${JSON.stringify(record)}\n`,
        "utf8",
      );
    } catch (error) {
      throw new EvidenceSinkError(
        `failed to append boundary evidence: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** In-memory sink for tests and embedding. */
export class MemoryEvidenceSink implements EvidenceSink {
  readonly records: BoundaryRecord[] = [];
  failure?: Error;

  append(record: BoundaryRecord): Promise<void> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    this.records.push(record);
    return Promise.resolve();
  }
}
