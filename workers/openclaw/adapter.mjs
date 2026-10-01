import {Agent} from "openclaw/plugin-sdk/agent-core";
import {createAssistantMessageEventStream} from "openclaw/plugin-sdk/llm";
import {OutcomeTracker} from "@mindburn/helm-worker-contract";
import {discoverTools, enforcePayload, gatewayFetch, normalizeResult, validateConfiguration} from "./boundary.mjs";
import {createGatewayStream} from "./transport.mjs";

function refusedStream(model) {
  const output = createAssistantMessageEventStream();
  output.push({type: "error", reason: "error", error: {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
    stopReason: "error", errorMessage: "HELM episode boundary", timestamp: Date.now(),
  }});
  output.end();
  return output;
}

// This is the actual public OpenClaw Agent core. The default stream function is
// its native Responses provider; tests inject native SDK event streams, not a
// second agent implementation. No CLI, built-in shell tools, plugins or fallback
// model registry are selected by this adapter.
export async function runEpisode(raw, {client, emit, signal, stream, fetch}) {
  const config = validateConfiguration(raw);
  stream ??= createGatewayStream(config, fetch ?? gatewayFetch(config, globalThis.fetch.bind(globalThis), signal));
  const allowed = new Set(config.allowed);
  const tracker = new OutcomeTracker();
  const catalog = await discoverTools(client, config.allowed, signal);
  const model = Object.freeze({
    id: config.model, name: config.model, api: "openai-responses", provider: "helm",
    baseUrl: config.base_url + "/v1", reasoning: false, input: ["text"],
    // SDK metadata is deliberately bounded by the supplied output cap. Actual
    // route pricing, context admission and episode budget stay at the gateway.
    contextWindow: config.max_output_tokens, maxTokens: config.max_output_tokens,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
  });
  let turns = 0;
  let toolCalls = 0;
  let boundaryFailed = false;
  let agent;
  const tools = catalog.map((tool) => ({
    name: tool.name, label: tool.name, description: tool.description ?? "HELM gateway tool",
    parameters: tool.inputSchema, resultContentSource: "network", executionMode: "sequential",
    execute: async (_id, args, toolSignal) => {
      signal?.throwIfAborted();
      toolSignal?.throwIfAborted();
      if (!allowed.has(tool.name) || tracker.stopped) throw new Error("HELM tool boundary");
      if (toolCalls++ >= 256) {
        boundaryFailed = true;
        agent.abort();
        throw new Error("HELM episode tool-call limit");
      }
      const signals = [signal, toolSignal].filter(Boolean);
      const result = normalizeResult(await client.callTool({name: tool.name, arguments: args},
        undefined, {signal: signals.length ? AbortSignal.any(signals) : undefined, timeout: 60000}));
      const observation = tracker.observe(tool.name, args, result);
      emit({type: "tool", name: tool.name, arguments: args, is_error: result.isError,
        structured: result.structured, text: result.text});
      return {content: [{type: "text", text: result.text || JSON.stringify(result.structured ?? {})}],
        details: {helm: result}, terminate: observation.stop};
    },
  }));
  agent = new Agent({
    initialState: {model, systemPrompt: config.system, thinkingLevel: "off", tools, messages: []},
    transport: "sse", maxRetryDelayMs: 0, toolExecution: "sequential",
    getApiKey: () => config.token,
    streamFn: (selected, context, options) => {
      if (tracker.stopped || boundaryFailed || signal?.aborted || options?.signal?.aborted || turns >= 20
          || Date.now() >= config.deadline_ms || selected.api !== model.api
          || selected.provider !== model.provider || selected.id !== model.id || selected.baseUrl !== model.baseUrl) {
        return refusedStream(model);
      }
      turns++;
      const signals = [signal, options?.signal].filter(Boolean);
      return stream(model, context, {...options,
        apiKey: config.token, maxTokens: config.max_output_tokens, transport: "sse",
        cacheRetention: "none", maxRetryDelayMs: 0,
        signal: signals.length ? AbortSignal.any(signals) : undefined,
        onPayload: (payload) => enforcePayload(config, allowed, payload),
      });
    },
    beforeToolCall: ({toolCall}) => allowed.has(toolCall.name) && !tracker.stopped && !boundaryFailed && !signal?.aborted
      ? undefined : {block: true, reason: "HELM tool boundary"},
    afterToolCall: ({result, isError}) => ({isError: result.details?.helm?.isError ?? isError, terminate: tracker.stopped}),
    afterToolOutcome: () => ({terminate: tracker.stopped || boundaryFailed}),
    prepareNextTurn: () => { if (tracker.stopped || boundaryFailed || turns >= 20) agent.abort(); },
  });
  const abort = () => agent.abort();
  signal?.addEventListener("abort", abort, {once: true});
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "tool_execution_start") emit({type: "progress", name: event.toolName});
    if (event.type === "message_end" && event.message.role === "assistant") {
      const text = event.message.content.filter((part) => part.type === "text")
        .map((part) => part.text).join("\n");
      if (text) emit({type: "text", text});
    }
  });
  try {
    signal?.throwIfAborted();
    await agent.prompt(config.user);
    signal?.throwIfAborted();
    if (boundaryFailed || (!tracker.stopped && (turns >= 20 || agent.state.errorMessage))) throw new Error("OpenClaw episode failed");
    return tracker;
  } finally {
    signal?.removeEventListener("abort", abort);
    unsubscribe();
    agent.abort();
  }
}
