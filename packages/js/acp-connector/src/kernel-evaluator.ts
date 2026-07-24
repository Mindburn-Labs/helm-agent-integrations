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
      const base = (this.opts.helmUrl ?? DEFAULT_HELM_URL).replace(/\/$/, "");
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
      const verdictRaw = nested.verdict ?? nested.status ?? rec.verdict ?? rec.status;
      const verdict = typeof verdictRaw === "string" ? verdictRaw.toUpperCase() : "DENY";
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
