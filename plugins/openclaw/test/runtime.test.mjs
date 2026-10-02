import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {configureAiTransportHost, getAiTransportHost} from "@openclaw/ai";
import entry from "../src/index.mjs";
import {createRuntime} from "../src/runtime.mjs";
import {configuration, CONFIG_SCHEMA, RUNTIME_MARKER} from "../src/config.mjs";

function fixture() {
  const episode = {episode_id: randomUUID(), work_item_id: randomUUID(), client: "openclaw",
    deadline: new Date(Date.now() + 300000).toISOString(), seconds_left: 300, ended: null};
  const status = {schema: "helm.executor.status/v1", slot: "oce-test", logged_in: true,
    workspace_id: randomUUID(), episode, problems: []};
  const profile = {executorHome: "/tmp/helm-oce-source-fixture", slot: status.slot,
    edgeOrigin: "https://executor.example.test", model: "retained-model", maxOutputTokens: 64,
    contextWindow: 2048, grantedTools: ["github_pull_request_create"], observedNativeTools: ["read"]};
  const calls = [], observations = [], tokens = [], requests = [];
  const core = {
    makeCtx: (env) => ({env, home: env.HELM_EXECUTOR_HOME, slot: env.HELM_EXECUTOR_SLOT, now: Date.now}),
    runCli: async (argv, _env, io) => { assert.deepEqual(argv, ["status", "--json"]); io.stdout(JSON.stringify(status)); return 0; },
    episodeToken: async () => { const token = randomUUID(); tokens.push(token); return token; },
    observe: async (_ctx, opts) => { observations.push(opts); return {status: "posted"}; },
  };
  const client = {
    listTools: async () => ({tools: [{name: profile.grantedTools[0], description: "Governed PR",
      inputSchema: {type: "object", properties: {target: {type: "string"}, arguments: {type: "object"}}}}]}),
    callTool: async (call, _schema, options) => {
      options.signal.throwIfAborted(); calls.push(call);
      return {isError: true, content: [{type: "text", text: "{\"status\":\"denied\"}"}],
        structuredContent: {status: "denied", reason_code: "NO_MANDATE"}};
    },
    close: async () => {},
  };
  const fetch = async (input, options) => {
    requests.push({url: String(input), options});
    return response();
  };
  const context = {sessionKey: "agent:oce:test", sessionId: randomUUID(), agentId: "oce-source-test",
    assertInvocationCurrent() {}};
  return {episode, status, profile, core, client, fetch, context, calls, observations, tokens, requests};
}

function response(text = "native gateway stream") {
  const message = {id: "resp_" + randomUUID(), object: "response", model: "retained-model",
    status: "completed", created_at: 1, error: null, incomplete_details: null,
    output: [{type: "message", id: "msg_" + randomUUID(), role: "assistant", status: "completed",
      content: [{type: "output_text", text, annotations: []}]}],
    usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2,
      input_tokens_details: {cached_tokens: 0}, output_tokens_details: {reasoning_tokens: 0}}};
  const events = [{type: "response.created", response: {...message, status: "in_progress", output: [], usage: null}},
    {type: "response.completed", response: message}];
  return new Response(events.map((event, sequence_number) =>
    `event: ${event.type}\ndata: ${JSON.stringify({...event, sequence_number})}\n\n`).join(""),
  {headers: {"Content-Type": "text/event-stream"}});
}

async function prepared(t, setup = () => {}) {
  const f = fixture(); setup(f);
  const runtime = createRuntime(f.profile, {core: f.core, client: f.client, fetch: f.fetch});
  t.after(() => runtime.close());
  await runtime.select({}, f.context);
  return {...f, runtime};
}

function stream(runtime, tools = []) {
  const model = runtime.model();
  return runtime.createStream({provider: model.provider, modelId: model.id, model})(model,
    {systemPrompt: "bounded source test", messages: [{role: "user", content: "Check the retained route", timestamp: Date.now()}], tools},
    {apiKey: randomUUID(), maxTokens: 999, transport: "websocket", headers: {"x-provider-key": randomUUID()}});
}

test("real definePluginEntry registers version-2 tools, provider, hooks and disposal", async () => {
  const f = fixture(), registrations = {}, hooks = new Map();
  entry.register({pluginConfig: f.profile,
    registerTool: (tool) => { registrations.tool = tool; },
    registerProvider: (provider) => { registrations.provider = provider; },
    registerService: (service) => { registrations.service = service; },
    on: (name, hook) => hooks.set(name, hook),
    lifecycle: {registerRuntimeLifecycle: (lifecycle) => { registrations.lifecycle = lifecycle; }},
  });
  assert.equal(entry.id, "helm-openclaw");
  assert.equal(registrations.tool.contextVersion, 2);
  assert.equal(registrations.provider.id, "helm");
  assert.deepEqual(registrations.provider.auth, []);
  assert.deepEqual([...hooks.keys()], ["before_model_resolve", "before_prompt_build", "before_tool_call", "after_tool_call"]);
  assert.equal(registrations.provider.resolveSyntheticAuth().apiKey, RUNTIME_MARKER);
  assert.equal(typeof registrations.lifecycle.dispose, "function");
  await registrations.lifecycle.dispose();
});

test("manifest schema agrees with runtime and config cannot carry a bearer or alternate endpoint", async () => {
  const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url)));
  assert.deepEqual(manifest.configSchema, CONFIG_SCHEMA);
  const f = fixture();
  for (const change of [{token: randomUUID()}, {apiKey: randomUUID()}, {edgeOrigin: "http://executor.example.test"},
    {edgeOrigin: "https://executor.example.test/v1"}, {edgeOrigin: "https://user@executor.example.test"},
    {edgeOrigin: "https://executor.example.test/?provider=escape"}, {observedNativeTools: ["exec"]},
    {observedNativeTools: f.profile.grantedTools}, {grantedTools: ["duplicate", "duplicate"]}]) {
    assert.throws(() => configuration({...f.profile, ...change}));
  }
});

test("actual MCP schema and refusal survive unchanged; no direct provider effect or manufactured receipt", async (t) => {
  const f = await prepared(t);
  const [tool] = f.runtime.factory(f.context);
  const input = {target: "github.com/Mindburn-Labs/helm-qa-sandbox", arguments: {head_sha: "a".repeat(40)}};
  const result = await tool.execute(randomUUID(), input);
  assert.deepEqual(f.calls, [{name: "github_pull_request_create", arguments: input}]);
  assert.equal(result.isError, true);
  assert.deepEqual(result.details.helm.structured, {status: "denied", reason_code: "NO_MANDATE"});
  assert.equal(f.tokens.length, 0); // Fake MCP port; this test claims no transport proof.
});

test("retained tools refuse stopped/reassigned episodes and foreign native sessions", async (t) => {
  const f = await prepared(t);
  const [tool] = f.runtime.factory(f.context);
  assert.throws(() => f.runtime.factory({...f.context, sessionId: randomUUID()}));
  await assert.rejects(f.runtime.select({}, {...f.context, sessionKey: "another-agent"}));
  f.episode.episode_id = randomUUID();
  await assert.rejects(tool.execute(randomUUID(), {}), /binding changed/);
  assert.equal(f.calls.length, 0);
});

test("native final invocation authority is rechecked after awaits before dispatch", async (t) => {
  const f = await prepared(t);
  let current = true;
  f.context.assertInvocationCurrent = () => { if (!current) throw new Error("revoked native invocation"); };
  const [tool] = f.runtime.factory(f.context);
  const old = f.core.runCli;
  f.core.runCli = async (...args) => { current = false; return old(...args); };
  await assert.rejects(tool.execute(randomUUID(), {}), /revoked native invocation/);
  assert.equal(f.calls.length, 0);
});

test("cancelled native invocation cannot dispatch; runtime disposal never manufactures pause", async (t) => {
  const f = await prepared(t), controller = new AbortController();
  const [tool] = f.runtime.factory(f.context);
  controller.abort();
  await assert.rejects(tool.execute(randomUUID(), {}, controller.signal));
  await f.runtime.close();
  assert.throws(() => f.runtime.factory(f.context));
  assert.equal(f.calls.length, 0);
});

test("cancellation after a tool reply refuses its release as a current result", async (t) => {
  const controller = new AbortController();
  const f = await prepared(t, (f) => {
    const old = f.client.callTool;
    f.client.callTool = async (...args) => { const reply = await old(...args); controller.abort(); return reply; };
  });
  const [tool] = f.runtime.factory(f.context);
  await assert.rejects(tool.execute(randomUUID(), {}, controller.signal));
  assert.equal(f.calls.length, 1); // Actual acceptance may precede cancellation; it is never resubmitted.
});

test("native catalog duplicates and unlisted tools refuse while other native tools are observed-only", async (t) => {
  const f = await prepared(t);
  const denied = await f.runtime.beforeTool({toolName: "exec", params: {command: "git push"}}, f.context);
  assert.equal(denied.block, true);
  assert.equal(await f.runtime.beforeTool({toolName: "read", params: {path: "work.txt"}}, f.context), undefined);
  await f.runtime.afterTool({toolName: "read", params: {path: "work.txt"}, result: {content: randomUUID()}}, f.context);
  assert.ok(f.observations.every((event) => event.client === "openclaw"));
  assert.deepEqual(f.observations.map((event) => event.event), ["PreToolUse", "PreToolUse", "PostToolUse"]);
  for (const event of f.observations) {
    const envelope = JSON.parse(event.input);
    assert.equal(envelope.session_id, f.context.sessionId);
    assert.equal(envelope.tool_response, undefined);
    assert.equal(envelope.result, undefined);
  }
  const g = fixture();
  g.client.listTools = async () => ({tools: [...(await f.client.listTools()).tools,
    {name: "read", inputSchema: {type: "object"}}]});
  const runtime = createRuntime(g.profile, {core: g.core, client: g.client});
  t.after(() => runtime.close());
  await assert.rejects(runtime.initialize(), /could not prepare/);
});

test("observation delivery failure preserves a local deny and never impersonates another client", async (t) => {
  const f = await prepared(t, (f) => { f.core.observe = async (_ctx, options) => {
    assert.equal(options.client, "openclaw"); return {status: "failed", line: "unsupported client"};
  }; });
  assert.equal((await f.runtime.beforeTool({toolName: "github_merge_pr", params: {}}, f.context)).block, true);
  assert.equal(await f.runtime.beforeTool({toolName: "read", params: {}}, f.context), undefined);
});

test("real native Responses transport uses the core bearer, canonical model and output cap", async (t) => {
  const f = await prepared(t);
  const result = await stream(f.runtime, [{name: "read", description: "observed-only local read", parameters: {type: "object"}}]).result();
  assert.notEqual(result.stopReason, "error", result.errorMessage);
  assert.equal(f.requests.length, 1); assert.equal(f.tokens.length, 1);
  const {url, options} = f.requests[0];
  assert.equal(url, f.profile.edgeOrigin + "/v1/responses");
  assert.equal(options.redirect, "error");
  assert.equal(new Headers(options.headers).get("Authorization"), `Bearer ${f.tokens[0]}`);
  assert.equal(new Headers(options.headers).get("x-provider-key"), null);
  const payload = JSON.parse(options.body);
  assert.equal(payload.model, f.profile.model); assert.equal(payload.max_output_tokens, 64);
  assert.equal(payload.parallel_tool_calls, false); assert.equal(payload.store, false);
});

test("real native provider refuses undeclared tools and alternate route before network", async (t) => {
  const f = await prepared(t);
  const result = await stream(f.runtime, [{name: "exec", parameters: {type: "object"}}]).result();
  assert.equal(result.stopReason, "error"); assert.equal(f.requests.length, 0);
  const model = f.runtime.model();
  assert.throws(() => f.runtime.createStream({provider: "openai", modelId: model.id, model}));
  assert.throws(() => f.runtime.createStream({provider: "helm", modelId: model.id,
    model: {...model, baseUrl: "https://api.openai.com/v1"}}));
});

test("binding changes during core token refresh prevent native model dispatch", async (t) => {
  const f = await prepared(t, (f) => {
    const old = f.core.episodeToken;
    f.core.episodeToken = async () => { const token = await old(); f.episode.work_item_id = randomUUID(); return token; };
  });
  const result = await stream(f.runtime).result();
  // The binding guard aborts the whole runtime. The native provider's exact
  // signal-aborted terminal is "aborted", with no response or successor call.
  assert.equal(result.stopReason, "aborted");
  assert.deepEqual(result.content, []);
  assert.notEqual(f.runtime.binding().workItemId, f.episode.work_item_id);
  assert.throws(() => stream(f.runtime), {name: "AbortError"});
  assert.throws(() => f.runtime.factory(f.context), {name: "AbortError"});
  assert.equal(f.tokens.length, 1); assert.equal(f.requests.length, 0);
});

test("native response size remains bounded by the shared worker transport", async (t) => {
  const f = await prepared(t, (f) => {
    f.fetch = async (input, options) => {
      f.requests.push({url: String(input), options});
      return new Response("", {headers: {"content-length": String(1024 * 1024 + 1)}});
    };
  });
  const result = await stream(f.runtime).result();
  assert.equal(result.stopReason, "error");
  assert.equal(f.requests.length, 1);
});

test("concurrent native provider streams keep distinct core slots and do not share credentials", async (t) => {
  const a = await prepared(t), b = await prepared(t, (f) => { f.profile.edgeOrigin = "https://other-edge.example.test"; });
  await Promise.all([stream(a.runtime).result(), stream(b.runtime).result()]);
  assert.equal(a.requests.length, 1); assert.equal(b.requests.length, 1);
  assert.equal(new Headers(a.requests[0].options.headers).get("Authorization"), `Bearer ${a.tokens[0]}`);
  assert.equal(new Headers(b.requests[0].options.headers).get("Authorization"), `Bearer ${b.tokens[0]}`);
  assert.notEqual(a.tokens[0], b.tokens[0]);
});

test("native HELM transport preserves host redaction and unrelated concurrent session routes", async (t) => {
  const original = getAiTransportHost(), unrelatedFetch = () => {}, delegated = [];
  const sentinel = randomUUID(), retainedRedactor = () => "[redacted]";
  configureAiTransportHost({...original,
    buildModelFetch: (...args) => { delegated.push(args); return unrelatedFetch; },
    requiresManagedTransport: () => false,
    resolveSecretSentinel: () => sentinel,
    redactModelVisibleSecrets: retainedRedactor,
  });
  const nativeHost = getAiTransportHost();
  t.after(() => configureAiTransportHost(original));
  const accepted = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  const f = await prepared(t, (f) => { f.fetch = async () => {
    accepted.resolve(); await release.promise; return response();
  }; });
  const pending = stream(f.runtime).result();
  await accepted.promise;
  const host = getAiTransportHost();
  for (const name of Object.keys(nativeHost)) {
    if (["buildModelFetch", "requiresManagedTransport", "plugin"].includes(name)) continue;
    assert.equal(host[name], nativeHost[name], name);
  }
  for (const name of Object.keys(nativeHost.plugin)) assert.equal(host.plugin[name], nativeHost.plugin[name], name);
  assert.equal(host.resolveSecretSentinel("native-sentinel"), sentinel);
  assert.equal(host.redactModelVisibleSecrets(sentinel), "[redacted]");
  const unrelated = {provider: "native-unrelated", api: "openai-responses", id: "retained-unrelated"};
  const timeout = 500, options = {method: "POST"};
  assert.equal(host.requiresManagedTransport(unrelated), false);
  assert.equal(host.buildModelFetch(unrelated, timeout, options), unrelatedFetch);
  assert.deepEqual(delegated, [[unrelated, timeout, options]]);
  assert.throws(() => host.buildModelFetch({...f.runtime.model(), id: f.profile.model}), /Unbound HELM/);
  release.resolve();
  const result = await pending;
  assert.notEqual(result.stopReason, "error", result.errorMessage);
  await stream(f.runtime).result();
  assert.equal(getAiTransportHost(), host); // No host reinstallation on every turn.
});

test("host passthrough cannot admit a foreign provider inside the active HELM stream", async (t) => {
  let refused = false;
  const f = await prepared(t, (f) => { f.fetch = async () => {
    assert.throws(() => getAiTransportHost().buildModelFetch({provider: "native-unrelated",
      api: "openai-responses", id: "other", baseUrl: "https://unrelated.example.test/v1"}), /escaped/);
    refused = true;
    return response();
  }; });
  const result = await stream(f.runtime).result();
  assert.notEqual(result.stopReason, "error", result.errorMessage);
  assert.equal(refused, true);
});
