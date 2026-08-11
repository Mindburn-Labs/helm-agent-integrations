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

/**
 * A content-addressed EvidencePack returned by the authenticated Kernel export
 * route immediately after preflight. It contains the receipts available at
 * that point; it does not attest to the later tool output.
 */
export interface HelmEvidencePackRef {
  evidenceHash: string;
  content: Uint8Array;
  contentType?: string;
}

export interface HelmPreflightResult {
  decision: HelmDecision;
  receipt?: HelmReceiptRef;
  evidencePack?: HelmEvidencePackRef;
  raw: unknown;
}

export interface HelmBoundaryAllowed<Output> {
  allowed: true;
  dispatched: true;
  verdict: "ALLOW";
  output: Output;
  decision: HelmDecision;
  receipt?: HelmReceiptRef;
  evidencePack?: HelmEvidencePackRef;
  raw: unknown;
}

export interface HelmBoundaryBlocked {
  allowed: false;
  dispatched: false;
  verdict: Exclude<HelmVerdict, "ALLOW">;
  decision: HelmDecision;
  receipt?: HelmReceiptRef;
  evidencePack?: HelmEvidencePackRef;
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
  arrayBuffer?(): Promise<ArrayBuffer>;
}>;

export interface HelmBoundaryConfig<Input, Output> {
  actionUrn: string;
  tool: ToolHandler<Input, Output>;
  sessionId: string;
  tenantId: string;
  principal: string;
  workspaceId?: string;
  apiKey?: string;
  serviceToken?: string;
  helmUrl?: string;
  riskClass?: string;
  effectClass?: string;
  metadata?: Record<string, unknown>;
  exportEvidence?: boolean;
  timeoutMs?: number;
  fetch?: FetchLike;
}

export interface HelmPreflightOptions<Input> {
  actionUrn: string;
  input: Input;
  sessionId: string;
  tenantId: string;
  principal: string;
  workspaceId?: string;
  apiKey?: string;
  serviceToken?: string;
  helmUrl?: string;
  riskClass?: string;
  effectClass?: string;
  metadata?: Record<string, unknown>;
  exportEvidence?: boolean;
  timeoutMs?: number;
  fetch?: FetchLike;
}

export interface HelmEvidenceExportOptions {
  sessionId: string;
  tenantId: string;
  principal: string;
  workspaceId?: string;
  apiKey?: string;
  serviceToken?: string;
  helmUrl?: string;
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

const DEFAULT_HELM_URL = "http://127.0.0.1:7714";
const TRUSTED_AGENT_RISK_CLASS = "T2";
const TRUSTED_AGENT_EFFECT_CLASS = "E4";
const SUPPORTED_RISK_CLASSES = new Set(["T0", "T1", "T2", "T3"]);
const SUPPORTED_EFFECT_CLASSES = new Set(["E0", "E1", "E2", "E3", "E4"]);
const UNTRUSTED_AUTHORITY_METADATA = [
  "principal",
  "agent_id",
  "tenant_id",
  "risk_class",
  "riskClass",
  "effect_class",
  "effectClass",
] as const;

function normalizeBaseUrl(url: string | undefined): string {
  return (url ?? DEFAULT_HELM_URL).replace(/\/$/, "");
}

function resolveEvaluateApiKey(apiKey: string | undefined, serviceToken: string | undefined): string {
  if (serviceToken?.trim()) {
    throw new HelmBoundaryTransportError(
      "HELM serviceToken is not authorized for tenant-scoped /api/v1/evaluate; configure apiKey",
    );
  }
  const normalized = apiKey?.trim() ?? "";
  if (normalized === "") {
    throw new HelmBoundaryTransportError("HELM apiKey is required for tenant-scoped /api/v1/evaluate");
  }
  return normalized;
}

function requireValue(value: string | undefined, name: string): string {
  const normalized = value?.trim() ?? "";
  if (normalized === "") {
    throw new HelmBoundaryTransportError(`HELM ${name} is required`);
  }
  return normalized;
}

function normalizeClassification(
  value: string | undefined,
  fallback: string,
  supported: Set<string>,
  name: string,
): string {
  const normalized = value?.trim().toUpperCase() || fallback;
  if (!supported.has(normalized)) {
    throw new HelmBoundaryTransportError(`Unsupported HELM ${name} ${JSON.stringify(value)}`);
  }
  return normalized;
}

function withoutAuthorityMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const sanitized = { ...metadata };
  for (const key of UNTRUSTED_AUTHORITY_METADATA) {
    delete sanitized[key];
  }
  return sanitized;
}

function canonicalVerdict(verdict: unknown): HelmVerdict {
  if (typeof verdict !== "string") {
    return "DENY";
  }
  return verdict.trim().toUpperCase() || "DENY";
}

function normalizedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim() || undefined;
}

function headersToReceipt(headers: { get(name: string): string | null }): HelmReceiptRef | undefined {
  const receiptId = normalizedString(headers.get("x-helm-receipt-id"));
  const decisionId = normalizedString(headers.get("x-helm-decision-id"));
  const reasonCode = normalizedString(headers.get("x-helm-reason-code"));
  const verdict = normalizedString(headers.get("x-helm-verdict"));
  const responseStatus = normalizedString(headers.get("x-helm-status"));
  if (verdict && responseStatus && canonicalVerdict(verdict) !== canonicalVerdict(responseStatus)) {
    throw new HelmBoundaryTransportError(
      "HELM evaluate response has conflicting verdict header values",
    );
  }
  const status = verdict ?? responseStatus;
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
    id: normalizedString(nested.id),
    decision_id: normalizedString(nested.decision_id) ?? normalizedString(body.decision_id),
    reason: normalizedString(nested.reason) ?? normalizedString(body.reason),
    reason_code: normalizedString(nested.reason_code) ?? normalizedString(body.reason_code),
    receipt_id: normalizedString(nested.receipt_id) ?? normalizedString(body.receipt_id),
  };
}

function mergeReceipt(decision: HelmDecision, headerReceipt?: HelmReceiptRef): HelmReceiptRef | undefined {
  const headerReceiptId = normalizedString(headerReceipt?.receiptId);
  const bodyReceiptId = normalizedString(decision.receipt_id);
  if (headerReceiptId && bodyReceiptId && headerReceiptId !== bodyReceiptId) {
    throw new HelmBoundaryTransportError("HELM evaluate response has conflicting receipt_id values");
  }
  const headerStatus = normalizedString(headerReceipt?.status);
  if (headerStatus && canonicalVerdict(headerStatus) !== canonicalVerdict(decision.verdict)) {
    throw new HelmBoundaryTransportError("HELM evaluate response has conflicting verdict values");
  }
  const receiptId = headerReceiptId ?? bodyReceiptId;
  const decisionId = normalizedString(headerReceipt?.decisionId)
    ?? normalizedString(decision.decision_id)
    ?? normalizedString(decision.id);
  const reasonCode = normalizedString(headerReceipt?.reasonCode)
    ?? normalizedString(decision.reason_code);
  const status = headerStatus ? canonicalVerdict(headerStatus) : canonicalVerdict(decision.verdict);
  if (!receiptId) {
    return undefined;
  }
  return { ...headerReceipt, receiptId, decisionId, reasonCode, status };
}

function authenticatedHeaders(
  authToken: string,
  tenantId: string,
  principal: string,
  workspaceId: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${authToken}`,
    "Content-Type": "application/json",
    "X-Helm-Tenant-ID": tenantId,
    "X-Helm-Principal-ID": principal,
  };
  const normalizedWorkspaceId = workspaceId?.trim();
  if (normalizedWorkspaceId) {
    headers["X-Helm-Workspace-ID"] = normalizedWorkspaceId;
  }
  return headers;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Export the current session's EvidencePack through the authenticated Kernel
 * route and verify its source-defined content hash before returning it.
 */
export async function exportEvidencePack(
  options: HelmEvidenceExportOptions,
): Promise<HelmEvidencePackRef> {
  const fetchImpl = options.fetch ?? globalThis.fetch as FetchLike | undefined;
  if (!fetchImpl) {
    throw new HelmBoundaryTransportError("No fetch implementation is available");
  }
  if (!globalThis.crypto?.subtle) {
    throw new HelmBoundaryTransportError("Web Crypto is required to verify HELM EvidencePack exports");
  }

  const authToken = resolveEvaluateApiKey(options.apiKey, options.serviceToken);
  const sessionId = requireValue(options.sessionId, "sessionId");
  const tenantId = requireValue(options.tenantId, "tenantId");
  const principal = requireValue(options.principal, "principal");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

  try {
    const response = await fetchImpl(`${normalizeBaseUrl(options.helmUrl)}/api/v1/evidence/export`, {
      method: "POST",
      headers: authenticatedHeaders(authToken, tenantId, principal, options.workspaceId),
      body: JSON.stringify({ session_id: sessionId, format: "tar.gz" }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const responseText = await response.text();
      let body: unknown = responseText;
      try {
        body = JSON.parse(responseText);
      } catch {
        // Preserve the plaintext error body and the Kernel status.
      }
      throw new HelmBoundaryTransportError(
        `HELM evidence export failed with HTTP ${response.status}`,
        response.status,
        body,
      );
    }
    if (!response.arrayBuffer) {
      throw new HelmBoundaryTransportError("HELM evidence export response is not binary-readable");
    }

    const content = new Uint8Array(await response.arrayBuffer());
    const evidenceHash = response.headers.get("x-helm-evidence-hash")?.trim().toLowerCase();
    if (!evidenceHash || !/^sha256:[0-9a-f]{64}$/.test(evidenceHash)) {
      throw new HelmBoundaryTransportError("HELM evidence export is missing a valid X-Helm-Evidence-Hash");
    }
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", content));
    const actualHash = `sha256:${bytesToHex(digest)}`;
    if (evidenceHash !== actualHash) {
      throw new HelmBoundaryTransportError(
        "HELM evidence export hash mismatch",
        response.status,
        { expected: evidenceHash, actual: actualHash },
      );
    }

    return {
      evidenceHash,
      content,
      contentType: response.headers.get("content-type") ?? undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function preflightAction<Input>(
  options: HelmPreflightOptions<Input>,
): Promise<HelmPreflightResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch as FetchLike | undefined;
  if (!fetchImpl) {
    throw new HelmBoundaryTransportError("No fetch implementation is available");
  }

  const authToken = resolveEvaluateApiKey(options.apiKey, options.serviceToken);
  const actionUrn = requireValue(options.actionUrn, "actionUrn");
  const sessionId = requireValue(options.sessionId, "sessionId");
  const tenantId = requireValue(options.tenantId, "tenantId");
  const principal = requireValue(options.principal, "principal");
  const riskClass = normalizeClassification(
    options.riskClass,
    TRUSTED_AGENT_RISK_CLASS,
    SUPPORTED_RISK_CLASSES,
    "riskClass",
  );
  const effectClass = normalizeClassification(
    options.effectClass,
    TRUSTED_AGENT_EFFECT_CLASS,
    SUPPORTED_EFFECT_CLASSES,
    "effectClass",
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  const payload = {
    principal,
    action: "EXECUTE_TOOL",
    resource: actionUrn,
    tool: "EXECUTE_TOOL",
    args: options.input,
    agent_id: principal,
    effect_level: actionUrn,
    session_id: sessionId,
    context: {
      tool: actionUrn,
      args: options.input,
      arguments: options.input,
      agent_id: principal,
      effect_level: effectClass,
      session_id: sessionId,
      action_urn: actionUrn,
      risk_class: riskClass,
      effect_class: effectClass,
      metadata: options.metadata ?? {},
    },
  };

  try {
    const response = await fetchImpl(`${normalizeBaseUrl(options.helmUrl)}/api/v1/evaluate`, {
      method: "POST",
      headers: authenticatedHeaders(authToken, tenantId, principal, options.workspaceId),
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
    const receipt = mergeReceipt(decision, headersToReceipt(response.headers));
    let evidencePack: HelmEvidencePackRef | undefined;
    if (options.exportEvidence) {
      if (!receipt?.receiptId) {
        throw new HelmBoundaryTransportError(
          "HELM evidence export requires a receipt_id from the evaluate response",
        );
      }
      evidencePack = await exportEvidencePack({
        sessionId,
        tenantId,
        principal,
        workspaceId: options.workspaceId,
        apiKey: options.apiKey,
        serviceToken: options.serviceToken,
        helmUrl: options.helmUrl,
        timeoutMs: options.timeoutMs,
        fetch: fetchImpl,
      });
    }
    return {
      decision,
      receipt,
      evidencePack,
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
      sessionId: config.sessionId,
      tenantId: config.tenantId,
      principal: config.principal,
      workspaceId: config.workspaceId,
      apiKey: config.apiKey,
      serviceToken: config.serviceToken,
      helmUrl: config.helmUrl,
      riskClass: config.riskClass,
      effectClass: config.effectClass,
      metadata: config.metadata,
      exportEvidence: config.exportEvidence,
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
        evidencePack: preflight.evidencePack,
        raw: preflight.raw,
      };
    }

    if (!preflight.receipt?.receiptId) {
      throw new HelmBoundaryTransportError(
        "HELM ALLOW response is missing the durable receipt_id required before dispatch",
      );
    }

    const output = await config.tool(input);
    return {
      allowed: true,
      dispatched: true,
      verdict: "ALLOW",
      output,
      decision: preflight.decision,
      receipt: preflight.receipt,
      evidencePack: preflight.evidencePack,
      raw: preflight.raw,
    };
  };
}

export interface BoundaryIntent<Input = unknown> {
  actionUrn: string;
  input: Input;
  sessionId?: string;
  principal?: string;
  riskClass?: string;
  effectClass?: string;
  metadata?: Record<string, unknown>;
}

export interface TinyFishSearchRequest {
  query: string;
  location?: string;
  language?: string;
  metadata?: Record<string, unknown>;
}

export interface TinyFishFetchRequest {
  urls: string[];
  format?: "markdown" | "html" | "json" | string;
  links?: boolean;
  image_links?: boolean;
  ttl?: number;
  metadata?: Record<string, unknown>;
}

export interface TinyFishBrowserSessionRequest {
  url?: string;
  session_id?: string;
  cdp_url?: string;
  credential_grant_ref?: string;
  ttl_seconds?: number;
  metadata?: Record<string, unknown>;
}

export interface TinyFishAgentRunRequest {
  url: string;
  goal: string;
  output_schema?: Record<string, unknown>;
  use_vault?: boolean;
  credential_item_ids?: string[];
  action_intent?: string;
  external_action?: boolean;
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
    sessionId: defaults.sessionId,
    principal: defaults.principal,
    riskClass: defaults.riskClass,
    effectClass: defaults.effectClass,
    metadata: { ...metadata, ...defaults.metadata },
  };
}

function tinyFishMetadata(endpointFamily: string, metadata?: Record<string, unknown>): Record<string, unknown> {
  return {
    framework: "tinyfish",
    connector_id: "tinyfish-web-v1",
    endpoint_family: endpointFamily,
    ...metadata,
  };
}

function tinyFishAgentEffect(call: TinyFishAgentRunRequest): { actionUrn: string; effectClass: string } {
  const intentValue = call.action_intent?.toLowerCase();
  const externalIntent = intentValue === "submit"
    || intentValue === "purchase"
    || intentValue === "send"
    || intentValue === "publish";
  if (call.external_action || externalIntent) {
    return { actionUrn: "tool.tinyfish.agent.external_action", effectClass: "E4" };
  }
  return { actionUrn: "tool.tinyfish.agent.run", effectClass: "E3" };
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

export function fromCodexToolCall(call: {
  tool_name?: string;
  name?: string;
  recipient_name?: string;
  arguments?: unknown;
  parameters?: unknown;
  input?: unknown;
  payload?: unknown;
  principal?: string;
  risk_class?: string;
  riskClass?: string;
  effect_class?: string;
  effectClass?: string;
  session_id?: string;
  thread_id?: string;
  worktree?: string;
  metadata?: Record<string, unknown>;
}): BoundaryIntent {
  const toolName = call.tool_name?.trim()
    || call.name?.trim()
    || call.recipient_name?.trim()
    || "unknown";
  const input = call.arguments !== undefined
    ? call.arguments
    : call.parameters !== undefined
      ? call.parameters
      : call.input !== undefined
        ? call.input
        : call.payload !== undefined
          ? call.payload
          : {};
  return intent(`tool.codex.${toolName}`, input, {
    ...withoutAuthorityMetadata(call.metadata),
    framework: "codex",
    tool_name: toolName,
    session_id: call.session_id,
    thread_id: call.thread_id,
    worktree: call.worktree,
  }, {
    sessionId: call.session_id,
    riskClass: TRUSTED_AGENT_RISK_CLASS,
    effectClass: TRUSTED_AGENT_EFFECT_CLASS,
  });
}

export function fromClaudeToolCall(call: {
  tool_name?: string;
  name?: string;
  tool_input?: unknown;
  input?: unknown;
  arguments?: unknown;
  id?: string;
  tool_use_id?: string;
  principal?: string;
  risk_class?: string;
  riskClass?: string;
  effect_class?: string;
  effectClass?: string;
  session_id?: string;
  transcript_path?: string;
  metadata?: Record<string, unknown>;
}): BoundaryIntent {
  const toolName = call.tool_name?.trim() || call.name?.trim() || "unknown";
  const input = call.tool_input !== undefined
    ? call.tool_input
    : call.input !== undefined
      ? call.input
      : call.arguments !== undefined
        ? call.arguments
        : {};
  return intent(`tool.claude.${toolName}`, input, {
    ...withoutAuthorityMetadata(call.metadata),
    framework: "claude",
    tool_name: toolName,
    tool_use_id: call.tool_use_id ?? call.id,
    session_id: call.session_id,
    transcript_path: call.transcript_path,
  }, {
    sessionId: call.session_id,
    riskClass: TRUSTED_AGENT_RISK_CLASS,
    effectClass: TRUSTED_AGENT_EFFECT_CLASS,
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
    effectClass: "E4",
  });
}

export function fromTinyFishSearch(call: TinyFishSearchRequest): BoundaryIntent<TinyFishSearchRequest> {
  return intent("tool.tinyfish.search.query", call, tinyFishMetadata("search", call.metadata), {
    riskClass: "T2",
    effectClass: "E2",
  });
}

export function fromTinyFishFetch(call: TinyFishFetchRequest): BoundaryIntent<TinyFishFetchRequest> {
  return intent("tool.tinyfish.fetch.extract", call, tinyFishMetadata("fetch", call.metadata), {
    riskClass: "T2",
    effectClass: "E2",
  });
}

export function fromTinyFishBrowserSession(
  call: TinyFishBrowserSessionRequest,
): BoundaryIntent<TinyFishBrowserSessionRequest> {
  return intent("tool.tinyfish.browser.session", call, tinyFishMetadata("browser", call.metadata), {
    riskClass: "T2",
    effectClass: "E3",
  });
}

export function fromTinyFishAgentRun(call: TinyFishAgentRunRequest): BoundaryIntent<TinyFishAgentRunRequest> {
  const agent = tinyFishAgentEffect(call);
  return intent(agent.actionUrn, call, tinyFishMetadata("agent", {
    action_intent: call.action_intent,
    external_action: call.external_action,
    ...call.metadata,
  }), {
    riskClass: "T2",
    effectClass: agent.effectClass,
  });
}

export type E2BNetworkCapability = "external" | "isolated";

/**
 * Normalize raw E2B network capability metadata into a stable enum.
 *
 * E2B sandboxes have internet access enabled by default, so anything that is
 * not an explicit opt-out normalizes to "external" (fail closed).
 */
export function normalizeE2BNetwork(value: unknown): E2BNetworkCapability {
  if (value === false) {
    return "isolated";
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "none" || normalized === "isolated" || normalized === "offline"
      || normalized === "disabled" || normalized === "false") {
      return "isolated";
    }
  }
  return "external";
}

export function fromE2BExecution(call: {
  command?: string;
  code?: string;
  language?: string;
  network?: unknown;
  metadata?: Record<string, unknown>;
}): BoundaryIntent {
  const network = normalizeE2BNetwork(call.network);
  return intent("tool.e2b.execute", call, {
    framework: "e2b",
    language: call.language,
    network,
    ...call.metadata,
  }, {
    riskClass: "T2",
    effectClass: network === "external" ? "E4" : "E3",
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
