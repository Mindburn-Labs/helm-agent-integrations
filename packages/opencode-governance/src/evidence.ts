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
 * Deterministic JSON stringify: object keys sorted recursively.
 *
 * Typing honesty (P2 CANONICALIZE_BUILD_FAILURE): under strict TS lib defs,
 * `JSON.stringify` returns `string | undefined` — top-level `undefined`,
 * functions, and symbols serialize to `undefined`, not a string. Silently
 * casting that away would let unserializable boundary material produce a
 * garbage hash input, so it is a hard, typed error instead (fail closed).
 */
export class EvidenceSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceSerializationError";
  }
}

export function canonicalize(value: unknown): string {
  const serialized: string | undefined = JSON.stringify(sortKeys(value));
  if (serialized === undefined) {
    throw new EvidenceSerializationError(
      `boundary material is not JSON-serializable (got ${
        value === undefined ? "undefined" : typeof value
      }); refusing to hash unserializable evidence`,
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
    const sorted: Record<string, unknown> = {};
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
