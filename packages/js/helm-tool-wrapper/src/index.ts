export type HelmVerdict = "ALLOW" | "DENY" | "ESCALATE" | "PENDING" | string;

export interface HelmDecision {
  id?: string;
  decision_id?: string;
  verdict: HelmVerdict;
  reason?: string;
  reason_code?: string;
  receipt_id?: string;
  [key: string]: unknown;
}

export interface HelmReceiptRef {
  receiptId?: string;
  decisionId?: string;
  reasonCode?: string;
  status?: string;
  [key: string]: unknown;
}

export interface HelmPreflightResult {
  decision: HelmDecision;
  receipt?: HelmReceiptRef;
  raw: unknown;
}

export interface HelmBoundaryAllowed<Output> {
  allowed: true;
  dispatched: true;
  verdict: "ALLOW";
  output: Output;
  decision: HelmDecision;
  receipt?: HelmReceiptRef;
  raw: unknown;
}

export interface HelmBoundaryBlocked {
  allowed: false;
  dispatched: false;
  verdict: Exclude<HelmVerdict, "ALLOW">;
  decision: HelmDecision;
  receipt?: HelmReceiptRef;
  raw: unknown;
}

export type HelmBoundaryResult<Output> =
  | HelmBoundaryAllowed<Output>
  | HelmBoundaryBlocked;

export type ToolHandler<Input, Output> = (input: Input) => Output | Promise<Output>;

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

export interface HelmBoundaryConfig<Input, Output> {
  actionUrn: string;
  tool: ToolHandler<Input, Output>;
  helmUrl?: string;
  principal?: string;
  riskClass?: string;
  effectClass?: string;
  metadata?: Record<string, unknown>;
  timeoutMs?: number;
  fetch?: FetchLike;
}

export interface HelmPreflightOptions<Input> {
  actionUrn: string;
  input: Input;
  helmUrl?: string;
  principal?: string;
  riskClass?: string;
  effectClass?: string;
  metadata?: Record<string, unknown>;
  timeoutMs?: number;
  fetch?: FetchLike;
}

export class HelmBoundaryTransportError extends Error {
  readonly status?: number;
  readonly body?: unknown;

  constructor(message: string, status?: number, body?: unknown) {
    super(message);
    this.name = "HelmBoundaryTransportError";
    this.status = status;
    this.body = body;
  }
}

const DEFAULT_HELM_URL = "http://127.0.0.1:7715";
const DEFAULT_PRINCIPAL = "helm-agent-integrations";

function normalizeBaseUrl(url: string | undefined): string {
  return (url ?? DEFAULT_HELM_URL).replace(/\/$/, "");
}

function canonicalVerdict(verdict: unknown): HelmVerdict {
  if (typeof verdict !== "string") {
    return "DENY";
  }
  return verdict.toUpperCase();
}

function headersToReceipt(headers: { get(name: string): string | null }): HelmReceiptRef | undefined {
  const receiptId = headers.get("x-helm-receipt-id") ?? undefined;
  const decisionId = headers.get("x-helm-decision-id") ?? undefined;
  const reasonCode = headers.get("x-helm-reason-code") ?? undefined;
  const status = headers.get("x-helm-status") ?? undefined;
  if (!receiptId && !decisionId && !reasonCode && !status) {
    return undefined;
  }
  return { receiptId, decisionId, reasonCode, status };
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function extractDecision(payload: unknown): HelmDecision {
  const body = readRecord(payload);
  const nested = readRecord(body.decision ?? body.record ?? body.result ?? payload);
  const verdict = canonicalVerdict(nested.verdict ?? nested.status ?? body.verdict ?? body.status);
  return {
    ...nested,
    verdict,
    id: typeof nested.id === "string" ? nested.id : undefined,
    decision_id: typeof nested.decision_id === "string"
      ? nested.decision_id
      : typeof body.decision_id === "string"
        ? body.decision_id
        : undefined,
    reason: typeof nested.reason === "string"
      ? nested.reason
      : typeof body.reason === "string"
        ? body.reason
        : undefined,
    reason_code: typeof nested.reason_code === "string"
      ? nested.reason_code
      : typeof body.reason_code === "string"
        ? body.reason_code
        : undefined,
    receipt_id: typeof nested.receipt_id === "string"
      ? nested.receipt_id
      : typeof body.receipt_id === "string"
        ? body.receipt_id
        : undefined,
  };
}

function mergeReceipt(decision: HelmDecision, headerReceipt?: HelmReceiptRef): HelmReceiptRef | undefined {
  const receiptId = headerReceipt?.receiptId ?? decision.receipt_id;
  const decisionId = headerReceipt?.decisionId ?? decision.decision_id ?? decision.id;
  const reasonCode = headerReceipt?.reasonCode ?? decision.reason_code;
  const status = headerReceipt?.status ?? decision.verdict;
  if (!receiptId && !decisionId && !reasonCode && !status) {
    return undefined;
  }
  return { ...headerReceipt, receiptId, decisionId, reasonCode, status };
}

export async function preflightAction<Input>(
  options: HelmPreflightOptions<Input>,
): Promise<HelmPreflightResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch as FetchLike | undefined;
  if (!fetchImpl) {
    throw new HelmBoundaryTransportError("No fetch implementation is available");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  const payload = {
    principal: options.principal ?? DEFAULT_PRINCIPAL,
    action: "EXECUTE_TOOL",
    resource: options.actionUrn,
    context: {
      action_urn: options.actionUrn,
      risk_class: options.riskClass,
      effect_class: options.effectClass,
      arguments: options.input,
      metadata: options.metadata ?? {},
    },
  };

  try {
    const response = await fetchImpl(`${normalizeBaseUrl(options.helmUrl)}/api/v1/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      throw new HelmBoundaryTransportError(
        `HELM preflight failed with HTTP ${response.status}`,
        response.status,
        body,
      );
    }

    const decision = extractDecision(body);
    return {
      decision,
      receipt: mergeReceipt(decision, headersToReceipt(response.headers)),
      raw: body,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function withHelmBoundary<Input, Output>(
  config: HelmBoundaryConfig<Input, Output>,
): (input: Input) => Promise<HelmBoundaryResult<Output>> {
  return async (input: Input): Promise<HelmBoundaryResult<Output>> => {
    const preflight = await preflightAction({
      actionUrn: config.actionUrn,
      input,
      helmUrl: config.helmUrl,
      principal: config.principal,
      riskClass: config.riskClass,
      effectClass: config.effectClass,
      metadata: config.metadata,
      timeoutMs: config.timeoutMs,
      fetch: config.fetch,
    });

    if (preflight.decision.verdict !== "ALLOW") {
      return {
        allowed: false,
        dispatched: false,
        verdict: preflight.decision.verdict as Exclude<HelmVerdict, "ALLOW">,
        decision: preflight.decision,
        receipt: preflight.receipt,
        raw: preflight.raw,
      };
    }

    const output = await config.tool(input);
    return {
      allowed: true,
      dispatched: true,
      verdict: "ALLOW",
      output,
      decision: preflight.decision,
      receipt: preflight.receipt,
      raw: preflight.raw,
    };
  };
}

export interface BoundaryIntent<Input = unknown> {
  actionUrn: string;
  input: Input;
  principal?: string;
  riskClass?: string;
  effectClass?: string;
  metadata?: Record<string, unknown>;
}

function intent<Input>(
  actionUrn: string,
  input: Input,
  metadata: Record<string, unknown>,
  defaults: Partial<BoundaryIntent<Input>> = {},
): BoundaryIntent<Input> {
  return {
    actionUrn,
    input,
    principal: defaults.principal,
    riskClass: defaults.riskClass,
    effectClass: defaults.effectClass,
    metadata: { ...metadata, ...defaults.metadata },
  };
}

export function fromHermesToolCall(call: {
  tool_name?: string;
  name?: string;
  arguments?: unknown;
  args?: unknown;
  profile?: string;
  task_id?: string;
  run_id?: string;
}): BoundaryIntent {
  const toolName = call.tool_name ?? call.name ?? "unknown";
  return intent(`tool.hermes.${toolName}`, call.arguments ?? call.args ?? {}, {
    framework: "hermes",
    profile: call.profile,
    task_id: call.task_id,
    run_id: call.run_id,
  });
}

export function fromOpenClawSkillCall(call: {
  skill?: string;
  action?: string;
  input?: unknown;
  args?: unknown;
  user_id?: string;
  conversation_id?: string;
}): BoundaryIntent {
  const action = call.action ?? call.skill ?? "unknown";
  return intent(`tool.openclaw.${action}`, call.input ?? call.args ?? {}, {
    framework: "openclaw",
    skill: call.skill,
    user_id: call.user_id,
    conversation_id: call.conversation_id,
  });
}

export function fromMastraToolCall(call: {
  toolId?: string;
  toolName?: string;
  args?: unknown;
  input?: unknown;
  runId?: string;
  agentId?: string;
}): BoundaryIntent {
  const toolName = call.toolName ?? call.toolId ?? "unknown";
  return intent(`tool.mastra.${toolName}`, call.args ?? call.input ?? {}, {
    framework: "mastra",
    run_id: call.runId,
    agent_id: call.agentId,
  });
}

export function fromBrowserUseAction(call: {
  action?: string;
  url?: string;
  form?: unknown;
  metadata?: Record<string, unknown>;
}): BoundaryIntent {
  const action = call.action ?? "browser.action";
  return intent(`tool.browser_use.${action}`, { url: call.url, form: call.form }, {
    framework: "browser-use",
    url: call.url,
    ...call.metadata,
  }, {
    riskClass: "T2",
    effectClass: "IRREVERSIBLE",
  });
}

export function fromE2BExecution(call: {
  command?: string;
  code?: string;
  language?: string;
  network?: unknown;
  metadata?: Record<string, unknown>;
}): BoundaryIntent {
  return intent("tool.e2b.execute", call, {
    framework: "e2b",
    language: call.language,
    network: call.network,
    ...call.metadata,
  }, {
    riskClass: "T2",
    effectClass: "REVERSIBLE",
  });
}

export function fromComposioAction(call: {
  app?: string;
  action?: string;
  payload?: unknown;
  connected_account_id?: string;
  metadata?: Record<string, unknown>;
}): BoundaryIntent {
  const app = call.app ?? "unknown";
  const action = call.action ?? "unknown";
  return intent(`tool.composio.${app}.${action}`, call.payload ?? {}, {
    framework: "composio",
    app,
    action,
    connected_account_id: call.connected_account_id,
    ...call.metadata,
  });
}
