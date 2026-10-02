import {AsyncLocalStorage} from "node:async_hooks";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {configureAiTransportHost, getAiTransportHost} from "@openclaw/ai";
import {getApiProvider} from "openclaw/plugin-sdk/llm";
import * as executor from "../../../executors/core/dist/index.js";
import {discoverTools, enforcePayload, gatewayFetch, normalizeResult, validateConfiguration,
  MAX_RESPONSE_BYTES} from "../../../workers/openclaw/boundary.mjs";
import {configuration, PROVIDER_ID, RUNTIME_MARKER} from "./config.mjs";

const currentModelRequest = new AsyncLocalStorage();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const correlation = (value) => typeof value === "string" && value.length > 0 && value.length <= 256
  && !/[\x00-\x1f\x7f]/.test(value);
const transmittedHeaders = new Set(["accept", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"]);

let installedModelHost;
function installModelTransport() {
  const previous = getAiTransportHost();
  if (previous === installedModelHost) return;
  // Native OpenClaw already owns redaction, secret sentinels and other provider
  // ports. Preserve that host, including unrelated sessions outside this scope.
  configureAiTransportHost({...previous,
    buildModelFetch: (model, ...options) => {
      const active = currentModelRequest.getStore();
      if (!active?.config) {
        if (model.provider === PROVIDER_ID) throw new Error("Unbound HELM native model");
        return previous.buildModelFetch(model, ...options);
      }
      if (model.api !== "openai-responses" || model.provider !== PROVIDER_ID
          || model.id !== active.config.model || model.baseUrl !== active.config.base_url + "/v1") {
        throw new Error("Native model escaped the HELM executor binding");
      }
      return active.fetch;
    },
    requiresManagedTransport: (model) => Boolean(currentModelRequest.getStore()?.config)
      || model.provider === PROVIDER_ID || previous.requiresManagedTransport(model),
  });
  installedModelHost = getAiTransportHost();
}

export function createRuntime(raw, dependencies = {}) {
  const profile = configuration(raw);
  const core = dependencies.core ?? executor;
  const fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const ctx = core.makeCtx({HELM_EXECUTOR_HOME: profile.executorHome, HELM_EXECUTOR_SLOT: profile.slot,
    HELM_EXECUTOR_OBSERVE_SUMMARY: "off"});
  const abort = new AbortController();
  let binding, session, client, tools = [], transport, guardedFetch, config, initialization;
  const catalogNames = new Set();
  let calls = 0, turns = 0, closed = false;

  async function snapshot() {
    let output = "";
    const code = await core.runCli(["status", "--json"], ctx.env, {
      stdout: (part) => { output += part; if (Buffer.byteLength(output) > 64 * 1024) throw new Error("Unbounded executor status"); },
      stderr: () => {}, readStdin: async () => null,
    }, {home: ctx.home, slot: ctx.slot, now: ctx.now});
    if (code !== 0) throw new Error("HELM executor status is unavailable");
    const status = JSON.parse(output), episode = status.episode;
    if (status.schema !== "helm.executor.status/v1" || status.slot !== profile.slot || !status.logged_in
        || !UUID.test(status.workspace_id ?? "") || !Array.isArray(status.problems) || status.problems.length
        || !episode || !UUID.test(episode.episode_id ?? "") || !UUID.test(episode.work_item_id ?? "")
        || episode.client !== "openclaw" || episode.ended !== null || !(episode.seconds_left > 0)
        || !Number.isFinite(Date.parse(episode.deadline))) throw new Error("No live OpenClaw executor episode");
    return Object.freeze({workspaceId: status.workspace_id, episodeId: episode.episode_id,
      workItemId: episode.work_item_id, deadline: episode.deadline});
  }

  async function assertBinding() {
    if (closed) throw new Error("HELM plugin runtime ended");
    abort.signal.throwIfAborted();
    const actual = await snapshot();
    if (!binding || JSON.stringify(actual) !== JSON.stringify(binding)) {
      abort.abort();
      throw new Error("HELM executor binding changed; prepare another runtime");
    }
  }

  async function authorizedFetch(input, options = {}) {
    await assertBinding();
    options.signal?.throwIfAborted();
    const token = await core.episodeToken(ctx);
    await assertBinding();
    options.signal?.throwIfAborted();
    const headers = new Headers();
    new Headers(options.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((value, key) => {
      if (transmittedHeaders.has(key)) headers.set(key, value);
    });
    headers.set("Authorization", `Bearer ${token}`);
    // A retained factory's final authority check must be adjacent to dispatch.
    const invocation = currentModelRequest.getStore();
    invocation?.assertCurrent?.();
    return fetch(input, {...options, headers, redirect: "error"});
  }

  async function initialize() {
    if (closed) throw new Error("HELM plugin runtime ended");
    if (initialization) return initialization;
    initialization = (async () => {
      binding = await snapshot();
      config = validateConfiguration({api: "openai-responses", token: RUNTIME_MARKER, model: profile.model,
        base_url: profile.edgeOrigin, mcp_url: profile.edgeOrigin + "/mcp", max_output_tokens: profile.maxOutputTokens,
        // status.seconds_left is already corrected for the control plane clock.
        deadline_ms: Date.now() + (await remainingSeconds()) * 1000,
        allowed: profile.grantedTools, system: "", user: ""});
      guardedFetch = gatewayFetch(config, authorizedFetch, abort.signal);
      client = dependencies.client ?? new Client({name: "mindburn-helm-openclaw", version: "0.1.0"});
      if (!dependencies.client) {
        transport = new StreamableHTTPClientTransport(new URL(config.mcp_url), {
          fetch: guardedFetch, requestInit: {headers: {Authorization: `Bearer ${RUNTIME_MARKER}`}},
        });
        await client.connect(transport, {signal: abort.signal, timeout: 10000});
      }
      const catalog = {listTools: async (...args) => {
        const page = await client.listTools(...args);
        for (const tool of page.tools ?? []) catalogNames.add(tool.name);
        return page;
      }};
      tools = await discoverTools(catalog, profile.grantedTools, abort.signal);
      if (profile.observedNativeTools.some((name) => catalogNames.has(name))) {
        throw new Error("Native tool duplicates the actual gateway catalog");
      }
      await assertBinding();
    })().catch(async () => {
      closed = true; abort.abort();
      await client?.close().catch(() => {});
      throw new Error("HELM plugin could not prepare its retained gateway tools");
    });
    return initialization;
  }

  async function remainingSeconds() {
    let status;
    await core.runCli(["status", "--json"], ctx.env, {stdout: (text) => { status = JSON.parse(text); },
      stderr: () => {}, readStdin: async () => null}, {home: ctx.home, slot: ctx.slot, now: ctx.now});
    await assertBinding();
    return status.episode.seconds_left;
  }

  function assertSession(context) {
    if (closed || !binding || !session || context.sessionKey !== session.sessionKey
        || context.sessionId !== session.sessionId) throw new Error("Native session is outside the HELM executor binding");
    abort.signal.throwIfAborted();
    context.abortSignal?.throwIfAborted();
  }

  async function select(_event, context) {
    await initialize(); await assertBinding();
    if (!correlation(context.sessionKey) || !correlation(context.sessionId)) throw new Error("Native session identity is required");
    const next = {sessionKey: context.sessionKey, sessionId: context.sessionId};
    if (session && JSON.stringify(session) !== JSON.stringify(next)) throw new Error("One HELM executor slot cannot serve another native session");
    session = Object.freeze(next);
    return {providerOverride: PROVIDER_ID, modelOverride: model().id};
  }

  function model() {
    if (!binding || !config || closed) throw new Error("HELM model is not prepared");
    // The alias isolates provider factories, whose SDK context has no session id.
    // Only the transport translates this host alias to the actual retained model.
    return {api: "openai-responses", provider: PROVIDER_ID, id: "episode_" + binding.episodeId,
      name: "HELM retained route", baseUrl: profile.edgeOrigin + "/v1", reasoning: false, input: ["text"],
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
      contextWindow: profile.contextWindow, maxTokens: profile.maxOutputTokens};
  }

  function assertModel(selected) {
    const expected = model();
    if (!selected || selected.provider !== expected.provider || selected.api !== expected.api
        || selected.id !== expected.id || selected.baseUrl !== expected.baseUrl) throw new Error("HELM model route changed");
  }

  function createStream(context) {
    if (context.provider !== PROVIDER_ID || context.modelId !== model().id) throw new Error("HELM provider selection changed");
    assertModel(context.model);
    const provider = getApiProvider("openai-responses");
    if (typeof provider?.streamSimple !== "function") throw new Error("Native Responses provider unavailable");
    return (selected, messages, options = {}) => {
      assertModel(selected); abort.signal.throwIfAborted(); options.signal?.throwIfAborted();
      if (!session || turns++ >= 20) throw new Error("HELM model turn boundary");
      const wireModel = {...model(), id: profile.model};
      const allowed = new Set([...profile.grantedTools, ...profile.observedNativeTools]);
      installModelTransport();
      return currentModelRequest.run({config, fetch: guardedFetch}, () => provider.streamSimple(wireModel, messages, {
        ...options, apiKey: RUNTIME_MARKER, headers: undefined, transport: "sse", cacheRetention: "none",
        maxTokens: profile.maxOutputTokens, maxRetryDelayMs: 0,
        signal: AbortSignal.any([abort.signal, options.signal].filter(Boolean)),
        onPayload: (payload) => enforcePayload(config, allowed, payload),
      }));
    };
  }

  function factory(context) {
    assertSession(context);
    if (typeof context.assertInvocationCurrent !== "function") throw new Error("Native final-effect authority is required");
    context.assertInvocationCurrent();
    return tools.map((tool) => ({name: tool.name, label: tool.name,
      description: tool.description ?? "HELM gateway tool", parameters: tool.inputSchema,
      resultContentSource: "network", executionMode: "sequential",
      execute: async (_callId, args, signal) => {
        assertSession(context); context.assertInvocationCurrent();
        if (calls++ >= 256 || Buffer.byteLength(JSON.stringify(args)) > MAX_RESPONSE_BYTES) throw new Error("HELM tool call bound");
        await assertBinding(); context.assertInvocationCurrent();
        const combined = AbortSignal.any([abort.signal, signal].filter(Boolean));
        combined.throwIfAborted();
        const response = await currentModelRequest.run({assertCurrent: context.assertInvocationCurrent}, () =>
          client.callTool({name: tool.name, arguments: args}, undefined, {signal: combined, timeout: 60000}));
        await assertBinding(); assertSession(context); context.assertInvocationCurrent(); combined.throwIfAborted();
        const result = normalizeResult(response);
        return {content: response.content, details: {helm: result}, isError: result.isError};
      },
    }));
  }

  async function observation(event, context, phase) {
    try {
      assertSession(context); await assertBinding();
      const envelope = {hook_event_name: phase, session_id: context.sessionId, agent_id: context.agentId,
        tool_name: event.toolName, tool_use_id: event.toolCallId ?? context.toolCallId,
        tool_input: event.params, duration_ms: event.durationMs};
      // Core owns canonical digest/redaction/intake, including its unsupported
      // client refusal until its additive OpenClaw observation port is published.
      return await core.observe(ctx, {client: "openclaw", event: phase, input: JSON.stringify(envelope)});
    } catch { return {status: "skipped", reason: "HELM observation binding unavailable"}; }
  }

  async function beforeTool(event, context) {
    try { assertSession(context); await assertBinding(); }
    catch { return {block: true, blockReason: "No current HELM executor binding"}; }
    const gateway = profile.grantedTools.includes(event.toolName);
    const native = profile.observedNativeTools.includes(event.toolName);
    await observation(event, context, "PreToolUse");
    if (!gateway && (!native || catalogNames.has(event.toolName) || profile.blockedNativeTools.includes(event.toolName))) {
      return {block: true, blockReason: "Use HELM gateway tools for catalog effects; this native tool is outside the observed-only surface"};
    }
  }

  async function close() {
    closed = true; abort.abort();
    await client?.close().catch(() => {});
  }

  return {profile, initialize, select, model, assertModel, createStream, factory, beforeTool,
    afterTool: (event, context) => observation(event, context, event.error ? "PostToolUseFailure" : "PostToolUse"),
    prompt: (_event, context) => { assertSession(context); return {toolsAllow: [...profile.grantedTools, ...profile.observedNativeTools]}; },
    close, binding: () => binding};
}
