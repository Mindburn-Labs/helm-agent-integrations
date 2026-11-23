import {
  TRUSTED_AGENT_EFFECT_CLASS,
  TRUSTED_AGENT_RISK_CLASS,
  withoutAuthorityMetadata,
  type BoundaryIntent,
} from "./intent.js";

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
