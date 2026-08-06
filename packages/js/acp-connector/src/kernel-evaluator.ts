/**
 * Kernel verdict client for ACP permission decisions.
 *
 * CONTRACT NOTE: the HTTP shape below intentionally mirrors the HELM
 * tenant-scoped evaluate endpoint as implemented in this repo's
 * packages/js/helm-tool-wrapper (POST {helmUrl}/api/v1/evaluate with Bearer
 * apiKey, X-Helm-Tenant-ID / X-Helm-Principal-ID headers, receipt metadata on
 * X-Helm-* response headers). It is replicated locally so this package stays
 * build-independent; helm-ai-kernel remains the source of truth for verdict
 * and receipt semantics. If the kernel contract changes, both packages must
 * be updated together.
 *
 * Fail-closed doctrine: this module NEVER fabricates an ALLOW. Any transport
 * error, timeout, malformed response, or non-ALLOW verdict is surfaced to the
 * caller, which must treat it as a rejection.
 */

import * as crypto from "node:crypto";
import type { PermissionAsk } from "./types.js";

export type KernelVerdictValue = "ALLOW" | "DENY" | "ESCALATE" | "PENDING" | string;

export interface KernelVerdict {
  verdict: KernelVerdictValue;
  reason?: string;
  reasonCode?: string;
  decisionId?: string;
  receiptId?: string;
  /** Kernel hint that this allow may stick for the session (low-risk tier). */
  stickyAllow?: boolean;
  raw?: unknown;
}

export interface KernelEvaluationRequest {
  ask: PermissionAsk;
  /** Low-risk interactive tier: read-only tool kinds under an
   *  auto-approve-reads policy. Beneath the heavyweight approval ceremony;
   *  the kernel still issues the verdict — the tier only classifies. */
  tier: "low" | "standard";
  agent: string;
  cwd: string;
  policy: string;
}

export interface KernelEvaluator {
  evaluate(request: KernelEvaluationRequest): Promise<KernelVerdict>;
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
  statusText?: string;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface HelmKernelEvaluatorOptions {
  apiKey: string;
  tenantId: string;
  principal: string;
  helmUrl?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}

const DEFAULT_HELM_URL = "http://127.0.0.1:7714";

/** Tool kinds that never mutate state — candidates for the low-risk tier. */
export const READ_TOOL_KINDS = new Set(["read", "search", "fetch", "think"]);

/**
 * Deterministic JSON (recursively sorted keys) for tool input. ACP is a JSON
 * protocol, so values that would be changed or discarded by JSON encoding are
 * rejected rather than authorized under a lossy representation.
 */
export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  const canon = (v: unknown): unknown => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("HELM ACP: tool input contains a non-finite number");
      return v;
    }
    if (Array.isArray(v)) {
      if (active.has(v)) throw new Error("HELM ACP: tool input contains a cycle");
      active.add(v);
      try {
        return v.map(canon);
      } finally {
        active.delete(v);
      }
    }
    if (v && typeof v === "object") {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error("HELM ACP: tool input must contain only JSON objects");
      }
      if (active.has(v)) throw new Error("HELM ACP: tool input contains a cycle");
      active.add(v);
      try {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(v as Record<string, unknown>).sort()) {
          out[key] = canon((v as Record<string, unknown>)[key]);
        }
        return out;
      } finally {
        active.delete(v);
      }
    }
    throw new Error(`HELM ACP: tool input contains unsupported ${typeof v} data`);
  };
  return JSON.stringify(canon(value));
}

export function toolInputSha256(toolInput: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(toolInput), "utf8").digest("hex");
}

/** Maximum full tool-input payload sent to the kernel (UTF-8 bytes). */
export const TOOL_INPUT_PAYLOAD_CAP = 8192;

/**
 * Kernel-ready rendering of the raw tool input. The kernel receives the
 * complete canonical value or the request fails: a preview plus a hash cannot
 * authorize an effect it cannot inspect.
 */
export function kernelToolInput(toolInput: unknown): {
  tool_input: unknown;
  tool_input_sha256: string;
} {
  const canonical = canonicalJson(toolInput);
  const byteLength = Buffer.byteLength(canonical, "utf8");
  if (byteLength > TOOL_INPUT_PAYLOAD_CAP) {
    throw new Error(
      `HELM ACP: tool input is ${byteLength} bytes, exceeding the ${TOOL_INPUT_PAYLOAD_CAP}-byte evaluation limit; ` +
        "refusing partial authorization",
    );
  }
  const sha256 = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
  return { tool_input: JSON.parse(canonical), tool_input_sha256: sha256 };
}

/** Advisory risk/effect classes (kernel-owned taxonomy T0–T3 / E0–E4). */
export function classifyAsk(ask: PermissionAsk, tier: "low" | "standard"): { riskClass: string; effectClass: string } {
  if (tier === "low") return { riskClass: "T0", effectClass: "E1" };
  const kind = ask.kind ?? "";
  if (kind === "execute" || kind === "shell") return { riskClass: "T2", effectClass: "E3" };
  if (kind === "edit" || kind === "write" || kind === "delete" || kind === "move") {
    return { riskClass: "T2", effectClass: "E2" };
  }
  return { riskClass: "T1", effectClass: "E2" };
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function normalizeHelmUrl(value: string | undefined): string {
  const raw = (value ?? DEFAULT_HELM_URL).replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("HELM ACP: helmUrl must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("HELM ACP: helmUrl must use HTTP or HTTPS");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol === "http:" && !loopback) {
    throw new Error("HELM ACP: plaintext helmUrl is allowed only on loopback");
  }
  return raw;
}

const AUTHORITY_VERDICTS = new Set(["ALLOW", "DENY", "ESCALATE", "PENDING"]);

function readAuthorityVerdict(...values: unknown[]): string {
  const verdicts = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toUpperCase())
    .filter((value) => AUTHORITY_VERDICTS.has(value));
  if (new Set(verdicts).size > 1) {
    throw new Error("HELM ACP: conflicting verdict fields in Kernel response (fail-closed)");
  }
  return verdicts[0] ?? "DENY";
}

/**
 * Kernel evaluator over the HELM evaluate HTTP endpoint. Mirrors the
 * helm-tool-wrapper preflight contract (see CONTRACT NOTE above).
 */
export class HelmKernelEvaluator implements KernelEvaluator {
  private readonly opts: HelmKernelEvaluatorOptions;

  constructor(opts: HelmKernelEvaluatorOptions) {
    if (!opts.apiKey?.trim()) {
      throw new Error("HELM apiKey is required for the ACP permission evaluator (fail-closed)");
    }
    if (!opts.tenantId?.trim() || !opts.principal?.trim()) {
      throw new Error("HELM tenantId and principal are required for the ACP permission evaluator");
    }
    this.opts = opts;
  }

  async evaluate(request: KernelEvaluationRequest): Promise<KernelVerdict> {
    const fetchImpl = this.opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) {
      throw new Error("No fetch implementation available for the HELM evaluator");
    }
    const { riskClass, effectClass } = classifyAsk(request.ask, request.tier);
    const actionUrn = `tool.acp.${request.agent}.${request.ask.kind ?? "unknown"}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);
    // The kernel authorizes the REAL effect: forward the full tool input /
    // arguments (canonicalized, digest over the complete bytes), not just the
    // agent-controlled title/kind label.
    const toolInput = kernelToolInput(request.ask.toolInput ?? null);
    const payload = {
      principal: this.opts.principal,
      action: "EXECUTE_TOOL",
      resource: actionUrn,
      context: {
        tool: actionUrn,
        args: {
          title: request.ask.title,
          kind: request.ask.kind,
          tool_call_id: request.ask.toolCallId,
          cwd: request.cwd,
          tool_input: toolInput.tool_input,
          tool_input_sha256: toolInput.tool_input_sha256,
        },
        agent_id: this.opts.principal,
        effect_level: effectClass,
        session_id: request.ask.sessionId,
        action_urn: actionUrn,
        risk_class: riskClass,
        effect_class: effectClass,
        metadata: {
          framework: "acp",
          connector_id: "helm-acp-connector",
          engine: request.agent,
          permission_tier: request.tier,
          policy: request.policy,
        },
      },
    };
    try {
      const base = normalizeHelmUrl(this.opts.helmUrl);
      const response = await fetchImpl(`${base}/api/v1/evaluate`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.opts.apiKey}`,
          "Content-Type": "application/json",
          "X-Helm-Tenant-ID": this.opts.tenantId,
          "X-Helm-Principal-ID": this.opts.principal,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text();
      }
      if (!response.ok) {
        throw new Error(`HELM evaluate failed with HTTP ${response.status}`);
      }
      const rec = readRecord(body);
      const nested = readRecord(rec.decision ?? rec.record ?? rec.result ?? body);
      const verdict = readAuthorityVerdict(
        nested.verdict,
        nested.status,
        rec.verdict,
        rec.status,
        response.headers.get("x-helm-verdict"),
        response.headers.get("x-helm-status"),
      );
      return {
        verdict,
        reason: str(nested.reason) ?? str(rec.reason),
        reasonCode: str(nested.reason_code) ?? str(rec.reason_code),
        decisionId: str(nested.decision_id) ?? str(rec.decision_id) ?? str(nested.id),
        receiptId:
          response.headers.get("x-helm-receipt-id") ?? str(nested.receipt_id) ?? str(rec.receipt_id) ?? undefined,
        stickyAllow: nested.sticky_allow === true || rec.sticky_allow === true,
        raw: body,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
