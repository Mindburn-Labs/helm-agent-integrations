/**
 * ACP (Agent Client Protocol) wire types — the subset this connector speaks.
 *
 * ACP is the Zed-originated JSON-RPC protocol (ndJSON over stdio) used to
 * drive vendor coding agents. Wire shape follows the public ACP schema
 * (https://agentclientprotocol.com). The connector design is adapted from
 * Rowboat's Apache-2.0 code-mode ACP client (apps/x/packages/core/src/
 * code-mode/acp/) — mechanisms reimplemented, no Rowboat code copied.
 */

export const ACP_PROTOCOL_VERSION = 1;

/** Supported coding agents behind the governed ACP boundary. */
export type BridgedCodingAgent = "claude" | "codex";
export type NativeAcpCodingAgent = "gemini" | "kimi" | "opencode";
export type CodingAgent = BridgedCodingAgent | NativeAcpCodingAgent;

/** Outcome kinds an agent may offer on a permission request. */
export type PermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always"
  | string;

export interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: PermissionOptionKind;
}

export interface ToolCallUpdate {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  [key: string]: unknown;
}

export interface RequestPermissionRequest {
  sessionId: string;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
}

export type RequestPermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export interface RequestPermissionResponse {
  outcome: RequestPermissionOutcome;
}

export interface ReadTextFileRequest {
  sessionId: string;
  path: string;
  line?: number | null;
  limit?: number | null;
}

export interface ReadTextFileResponse {
  content: string;
}

export interface WriteTextFileRequest {
  sessionId: string;
  path: string;
  content: string;
}

export type WriteTextFileResponse = Record<string, never>;

/** Session update notification payload (agent → client). Kept permissive. */
export interface SessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
}

export interface PromptResponse {
  stopReason: string;
  [key: string]: unknown;
}

export interface InitializeResponse {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    [key: string]: unknown;
  };
  agentInfo?: { name?: string; version?: string } | null;
  authMethods?: unknown[];
  [key: string]: unknown;
}

export interface NewSessionResponse {
  sessionId: string;
  configOptions?: unknown;
  models?: unknown;
  modes?: unknown;
  [key: string]: unknown;
}

/** Normalized event stream emitted by the connector (sessionUpdate mapped). */
export type AcpRunEvent =
  | { type: "message"; role: "user" | "agent"; text: string }
  | { type: "thought" }
  | { type: "tool_call"; id?: string; title?: string; kind?: string; status?: string }
  | { type: "tool_call_update"; id?: string; status?: string; diffs: string[] }
  | { type: "plan"; entries: Array<{ content: string; status?: string; priority?: string }> }
  | { type: "usage"; used?: number; size?: number }
  | { type: "permission"; ask: PermissionAsk; decision: PermissionDecision; auto: boolean; receiptId?: string }
  | { type: "other"; sessionUpdate: string };

/** A normalized permission question derived from a requestPermission call. */
export interface PermissionAsk {
  toolCallId?: string;
  title: string;
  kind?: string;
  isRead: boolean;
  sessionId: string;
  /**
   * The full raw tool-call payload as supplied by the adapter (e.g. ACP
   * `rawInput` with the command/args/file content the tool will run with).
   * The kernel MUST see this — authorizing on title/kind alone would approve
   * a label, not the actual side effect. Canonicalized for the wire by the
   * kernel evaluator; also feeds sticky-allow target keying.
   */
  toolInput?: unknown;
}

/** Internal decision vocabulary before mapping onto offered options. */
export type PermissionDecision = "allow_always" | "allow_once" | "reject";

/** Interactive permission policy for a session. Deliberately NO "yolo":
 *  fail-closed is the doctrine; every allow is either a kernel ALLOW or a
 *  recorded sticky allow beneath one. */
export type ApprovalPolicy = "ask" | "auto-approve-reads";

export interface RunPromptResult {
  stopReason: string;
  sessionId: string;
}
