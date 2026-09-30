// Identifiers fixed by the HELM episode contract.

export const EPISODE_SCHEMA = "helm.episode.v1";
export const STATUS_SCHEMA = "helm.episode.status.v1";
export const PROPOSAL_SCHEMA = "helm.proposal.v1";
export const REPORT_SCHEMA = "helm.report.v1";

/** The A2A extension every worker declares as required on its AgentCard. */
export const EXTENSION_URI = "urn:helm:a2a:episode:v1";
export const EPISODE_MEDIA_TYPE = "application/vnd.helm.episode.v1+json";
export const STATUS_MEDIA_TYPE = "application/vnd.helm.episode.status.v1+json";

export const A2A_VERSION = "1.0";
export const DEFAULT_TOKEN_ENV = "HELM_EPISODE_TOKEN";
/** Secret the control plane presents to the worker's JSON-RPC endpoint. */
export const INGRESS_TOKEN_ENV = "HELM_A2A_BEARER_TOKEN";

export const MODEL_API_ANTHROPIC = "anthropic-messages";
export const MODEL_API_RESPONSES = "openai-responses";
export const MODEL_API_CHAT = "openai-chat-completions";
export const MODEL_APIS = [MODEL_API_ANTHROPIC, MODEL_API_RESPONSES, MODEL_API_CHAT] as const;
export type ModelApi = (typeof MODEL_APIS)[number];

// MCP tool names (tool names use underscores; OpenAI-compatible APIs reject dots).
export const REPORT_TOOL = "helm_work_report";
export const DELEGATE_TOOL = "helm_work_delegate";
export const REQUEST_INPUT_TOOL = "helm_work_request_input";

/** Terminal-state reason codes carried in helm.episode.status.v1 `error.code`. */
export const REJECTED_CODES = ["INVALID_EPISODE", "MISSING_CREDENTIAL", "UNSUPPORTED_MODEL_API"] as const;
export const FAILED_CODES = [
  "NO_REPORT",
  "MODEL_ERROR",
  "TOOL_ERROR",
  "MAX_TURNS",
  "DEADLINE_EXCEEDED",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof REJECTED_CODES)[number] | (typeof FAILED_CODES)[number];
