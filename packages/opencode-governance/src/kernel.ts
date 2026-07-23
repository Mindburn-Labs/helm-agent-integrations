/**
 * Kernel verdict sources.
 *
 * A KernelClient NEVER throws for transport/authority failures and NEVER
 * fabricates an authoritative verdict. It returns a discriminated outcome:
 *
 * - { kind: "verdict", ... }  — the kernel answered with an exact
 *   ALLOW/DENY/ESCALATE verdict. The verdict material is passed through
 *   unmodified; `raw` retains the response body for evidence.
 * - { kind: "error", ... }    — anything else (unreachable, timeout, non-2xx,
 *   malformed body, unknown verdict string, local failure). The caller MUST
 *   treat this as DENY with the attached locally synthesized reason code.
 *
 * The http payload shape and header contract mirror the audited sibling
 * package @mindburn/helm-tool-wrapper (packages/js/helm-tool-wrapper,
 * preflightAction). Direct reuse was rejected deliberately: the wrapper's
 * preflight throws on transport failure, whereas a permission hook needs a
 * non-throwing, locally-typed outcome that can never be confused with signed
 * kernel evidence (see research/opencode-study/26 §3.1 gem #1).
 */

import { execFile } from "node:child_process";
import type { KernelVerdict, LocalDenyReason, NormalizedVerdict } from "./verdict.js";
import { normalizeVerdict } from "./verdict.js";

export interface KernelEvaluationRequest {
  /** opencode tool id (e.g. "bash", "edit"). */
  tool: string;
  sessionID: string;
  callID?: string;
  /** Tool arguments as presented at the hook boundary. */
  args: unknown;
  /** Permission name when invoked from permission.ask (e.g. "bash", "external_directory"). */
  permission?: string;
  /** Permission patterns when invoked from permission.ask. */
  patterns?: string[];
  metadata?: Record<string, unknown>;
}

export interface KernelVerdictOutcome {
  kind: "verdict";
  verdict: KernelVerdict;
  decisionId?: string;
  reasonCode?: string;
  receiptId?: string;
  raw: unknown;
}

export interface KernelErrorOutcome {
  kind: "error";
  reasonCode: LocalDenyReason;
  message: string;
  raw?: unknown;
}

export type KernelOutcome = KernelVerdictOutcome | KernelErrorOutcome;

export interface KernelClient {
  evaluate(request: KernelEvaluationRequest): Promise<KernelOutcome>;
}

/** Metadata keys that must never be accepted from the untrusted (agent) side. */
const UNTRUSTED_AUTHORITY_METADATA = [
  "principal",
  "agent_id",
  "tenant_id",
  "risk_class",
  "riskClass",
  "effect_class",
  "effectClass",
] as const;

export function withoutAuthorityMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const sanitized = { ...metadata };
  for (const key of UNTRUSTED_AUTHORITY_METADATA) {
    delete sanitized[key];
  }
  return sanitized;
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function readString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "") {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Extract a verdict outcome from a kernel response body. Only exact
 * ALLOW/DENY/ESCALATE strings survive; anything else degrades to an error
 * outcome with KERNEL_UNKNOWN_VERDICT / KERNEL_MALFORMED_RESPONSE.
 */
export function outcomeFromResponseBody(body: unknown): KernelOutcome {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      kind: "error",
      reasonCode: "KERNEL_MALFORMED_RESPONSE",
      message: "kernel response body is not an object",
      raw: body,
    };
  }
  const record = readRecord(body);
  const nested = readRecord(record.decision ?? record.record ?? record.result);
  const rawVerdict = nested.verdict ?? nested.status ?? record.verdict ?? record.status;
  const verdict: NormalizedVerdict = normalizeVerdict(rawVerdict);
  if (verdict === "UNKNOWN") {
    return {
      kind: "error",
      reasonCode: "KERNEL_UNKNOWN_VERDICT",
      message: `kernel returned unrecognized verdict material: ${JSON.stringify(rawVerdict)}`,
      raw: body,
    };
  }
  return {
    kind: "verdict",
    verdict,
    decisionId: readString(nested.decision_id, record.decision_id, nested.id, record.id),
    reasonCode: readString(nested.reason_code, record.reason_code),
    receiptId: readString(nested.receipt_id, record.receipt_id),
    raw: body,
  };
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface HttpKernelClientOptions {
  kernelUrl: string;
  apiKey: string;
  tenantId: string;
  principal: string;
  riskClass: string;
  effectClass: string;
  timeoutMs: number;
  fetch?: FetchLike;
}

/**
 * HTTP kernel client: POST {kernelUrl}/api/v1/evaluate.
 * Fail closed on every failure class; no retries (a permission hook must be
 * fast and deterministic, and retrying a deny-path delays the deny).
 */
export class HttpKernelClient implements KernelClient {
  private readonly options: HttpKernelClientOptions;

  constructor(options: HttpKernelClientOptions) {
    this.options = options;
  }

  async evaluate(request: KernelEvaluationRequest): Promise<KernelOutcome> {
    const fetchImpl = this.options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) {
      return {
        kind: "error",
        reasonCode: "KERNEL_UNAVAILABLE",
        message: "no fetch implementation available",
      };
    }

    const actionUrn = `tool.opencode.${request.tool}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const payload = {
      principal: this.options.principal,
      action: "EXECUTE_TOOL",
      resource: actionUrn,
      context: {
        tool: actionUrn,
        args: request.args,
        arguments: request.args,
        agent_id: this.options.principal,
        effect_level: this.options.effectClass,
        session_id: request.sessionID,
        call_id: request.callID,
        permission: request.permission,
        patterns: request.patterns,
        action_urn: actionUrn,
        risk_class: this.options.riskClass,
        effect_class: this.options.effectClass,
        metadata: {
          framework: "opencode",
          ...withoutAuthorityMetadata(request.metadata),
        },
      },
    };

    try {
      const response = await fetchImpl(`${this.options.kernelUrl}/api/v1/evaluate`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
          "X-Helm-Tenant-ID": this.options.tenantId,
          "X-Helm-Principal-ID": this.options.principal,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        try {
          body = await response.text();
        } catch {
          body = undefined;
        }
      }

      if (!response.ok) {
        return {
          kind: "error",
          reasonCode: "KERNEL_UNAVAILABLE",
          message: `kernel evaluate returned HTTP ${response.status}`,
          raw: body,
        };
      }
      return outcomeFromResponseBody(body);
    } catch (error) {
      return {
        kind: "error",
        reasonCode: "KERNEL_UNAVAILABLE",
        message: `kernel evaluate failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export type SpawnLike = (
  file: string,
  args: string[],
  options: { input: string; timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Default spawn implementation: execFile with stdin payload and a hard timeout. */
export const defaultSpawn: SpawnLike = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && (error as { killed?: boolean }).killed) {
          resolve({ code: -1, stdout: String(stdout), stderr: `timeout after ${options.timeoutMs}ms` });
          return;
        }
        const code = typeof (error as { code?: number } | null)?.code === "number"
          ? (error as { code: number }).code
          : error
          ? -1
          : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    child.on("error", reject);
    if (child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
  });

export interface BinaryKernelClientOptions {
  kernelBinary: string;
  kernelBinaryArgs: string[];
  tenantId: string;
  principal: string;
  riskClass: string;
  effectClass: string;
  timeoutMs: number;
  spawn?: SpawnLike;
}

/**
 * Local kernel binary client.
 *
 * Adapter contract (documented in README): the binary receives one JSON
 * evaluation request on stdin and must print one JSON object on stdout with a
 * `verdict` field of ALLOW|DENY|ESCALATE. Exit code 0 with an exact ALLOW is
 * the ONLY authorizing path; non-zero exit, empty/invalid stdout, or unknown
 * verdict material all fail closed. This matches the kernel's own hook
 * posture (signer/receipt failure denies at the last mile,
 * helm-ai-kernel core/cmd/helm-ai-kernel/hook_cmd.go).
 */
export class BinaryKernelClient implements KernelClient {
  private readonly options: BinaryKernelClientOptions;
  private readonly spawn: SpawnLike;

  constructor(options: BinaryKernelClientOptions) {
    this.options = options;
    this.spawn = options.spawn ?? defaultSpawn;
  }

  async evaluate(request: KernelEvaluationRequest): Promise<KernelOutcome> {
    const actionUrn = `tool.opencode.${request.tool}`;
    const payload = {
      principal: this.options.principal,
      tenant_id: this.options.tenantId,
      action: "EXECUTE_TOOL",
      resource: actionUrn,
      context: {
        tool: actionUrn,
        args: request.args,
        agent_id: this.options.principal,
        session_id: request.sessionID,
        call_id: request.callID,
        permission: request.permission,
        patterns: request.patterns,
        risk_class: this.options.riskClass,
        effect_class: this.options.effectClass,
        metadata: {
          framework: "opencode",
          ...withoutAuthorityMetadata(request.metadata),
        },
      },
    };

    let result: { code: number; stdout: string; stderr: string };
    try {
      result = await this.spawn(this.options.kernelBinary, this.options.kernelBinaryArgs, {
        input: JSON.stringify(payload),
        timeoutMs: this.options.timeoutMs,
      });
    } catch (error) {
      return {
        kind: "error",
        reasonCode: "KERNEL_UNAVAILABLE",
        message: `kernel binary spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (result.stdout.trim() === "") {
      return {
        kind: "error",
        reasonCode: result.code === 0 ? "KERNEL_MALFORMED_RESPONSE" : "KERNEL_UNAVAILABLE",
        message: result.code === 0
          ? "kernel binary exited 0 but produced no verdict on stdout"
          : `kernel binary exited ${result.code} with no verdict: ${result.stderr.slice(0, 200)}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return {
        kind: "error",
        reasonCode: "KERNEL_MALFORMED_RESPONSE",
        message: "kernel binary stdout is not valid JSON",
        raw: result.stdout.slice(0, 500),
      };
    }

    const outcome = outcomeFromResponseBody(parsed);
    // A non-zero exit can never upgrade a parsed verdict: it downgrades any
    // ALLOW to a locally synthesized error. DENY/ESCALATE verdicts printed
    // alongside a non-zero exit are still honored (they only restrict).
    if (result.code !== 0 && outcome.kind === "verdict" && outcome.verdict === "ALLOW") {
      return {
        kind: "error",
        reasonCode: "KERNEL_UNAVAILABLE",
        message: `kernel binary exited ${result.code} while printing ALLOW; refusing to honor it (fail closed)`,
        raw: parsed,
      };
    }
    return outcome;
  }
}
