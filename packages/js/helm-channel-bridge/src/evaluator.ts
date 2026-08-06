// Kernel evaluator for channel commands.
//
// Every inbound channel command is evaluated by the HELM AI Kernel before it
// may execute. This module deliberately mirrors the tenant-scoped
// /api/v1/evaluate contract used by @mindburn/helm-tool-wrapper, but stays
// self-contained so this package has no cross-package build dependency.
//
// Fail-closed rule: any transport failure, malformed response, or non-ALLOW
// verdict is treated as a denial. The bridge never dispatches without an
// explicit ALLOW.

export type ChannelVerdict = "ALLOW" | "DENY" | "ESCALATE" | "PENDING" | string;

export interface ChannelDecision {
  verdict: ChannelVerdict;
  reason?: string;
  reasonCode?: string;
  receiptId?: string;
  decisionId?: string;
}

export interface ChannelEvaluationRequest {
  /** Action URN, e.g. "channel.telegram.turn.run". */
  actionUrn: string;
  /** Stable channel sender identity, used as the HELM principal. */
  senderKey: string;
  /** Session the evaluation belongs to (active session or channel identity). */
  sessionId: string;
  /** Command payload placed under context.args. */
  input: Record<string, unknown>;
  riskClass?: string;
  effectClass?: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelEvaluator {
  evaluate(request: ChannelEvaluationRequest): Promise<ChannelDecision>;
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

export interface KernelEvaluatorConfig {
  tenantId: string;
  apiKey: string;
  helmUrl?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}

const DEFAULT_HELM_URL = "http://127.0.0.1:7714";
const DEFAULT_TIMEOUT_MS = 30_000;

/** Synthetic decision used when the Kernel cannot be reached. Fail closed. */
export function evaluatorUnavailableDecision(detail: string): ChannelDecision {
  return {
    verdict: "DENY",
    reason: `HELM Kernel evaluation unavailable: ${detail}`,
    reasonCode: "CHANNEL_EVALUATOR_UNAVAILABLE",
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function extractDecision(payload: unknown, headers: { get(name: string): string | null }): ChannelDecision {
  const body = readRecord(payload);
  const nested = readRecord(body.decision ?? body.record ?? body.result ?? payload);
  const rawVerdict = nested.verdict ?? nested.status ?? body.verdict ?? body.status;
  // Unknown or missing verdicts fail closed to DENY.
  const verdict = typeof rawVerdict === "string" ? rawVerdict.toUpperCase() : "DENY";
  return {
    verdict,
    reason: readString(nested.reason) ?? readString(body.reason),
    reasonCode: readString(nested.reason_code) ?? readString(body.reason_code)
      ?? headers.get("x-helm-reason-code") ?? undefined,
    receiptId: readString(nested.receipt_id) ?? readString(body.receipt_id)
      ?? headers.get("x-helm-receipt-id") ?? undefined,
    decisionId: readString(nested.decision_id) ?? readString(body.decision_id)
      ?? readString(nested.id) ?? headers.get("x-helm-decision-id") ?? undefined,
  };
}

/**
 * Create a ChannelEvaluator backed by a live HELM AI Kernel.
 *
 * The evaluator never throws for governance outcomes: HTTP errors and network
 * failures are converted into fail-closed DENY decisions so the bridge can
 * report them to the sender without dispatching.
 */
export function createKernelEvaluator(config: KernelEvaluatorConfig): ChannelEvaluator {
  const baseUrl = (config.helmUrl ?? DEFAULT_HELM_URL).replace(/\/$/, "");
  const tenantId = config.tenantId.trim();
  const apiKey = config.apiKey.trim();
  if (tenantId === "") {
    throw new Error("HELM tenantId is required for the channel evaluator");
  }
  if (apiKey === "") {
    throw new Error("HELM apiKey is required for the channel evaluator");
  }

  return {
    async evaluate(request: ChannelEvaluationRequest): Promise<ChannelDecision> {
      const fetchImpl = config.fetch ?? globalThis.fetch as FetchLike | undefined;
      if (!fetchImpl) {
        return evaluatorUnavailableDecision("no fetch implementation is available");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const payload = {
        principal: request.senderKey,
        action: "EXECUTE_TOOL",
        resource: request.actionUrn,
        context: {
          tool: request.actionUrn,
          args: request.input,
          arguments: request.input,
          agent_id: request.senderKey,
          session_id: request.sessionId,
          action_urn: request.actionUrn,
          risk_class: request.riskClass ?? "T2",
          effect_class: request.effectClass ?? "E3",
          metadata: request.metadata ?? {},
        },
      };
      try {
        const response = await fetchImpl(`${baseUrl}/api/v1/evaluate`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "X-Helm-Tenant-ID": tenantId,
            "X-Helm-Principal-ID": request.senderKey,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = undefined;
        }
        if (!response.ok) {
          return evaluatorUnavailableDecision(`HTTP ${response.status} from /api/v1/evaluate`);
        }
        return extractDecision(body, response.headers);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return evaluatorUnavailableDecision(detail);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
