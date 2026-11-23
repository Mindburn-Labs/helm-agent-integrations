import { TRUSTED_AGENT_EFFECT_CLASS, TRUSTED_AGENT_RISK_CLASS } from "./intent.js";

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
const SUPPORTED_RISK_CLASSES = new Set(["T0", "T1", "T2", "T3"]);
const SUPPORTED_EFFECT_CLASSES = new Set(["E0", "E1", "E2", "E3", "E4"]);

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
