import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {createAssistantMessageEventStream} from "openclaw/plugin-sdk/llm";
import {runEpisode} from "./adapter.mjs";

function config(allowed = ["helm_work_report"]) {
  return {api: "openai-responses", token: randomUUID(), model: "retained-model",
    base_url: "http://model.gateway.test", mcp_url: "http://mcp.gateway.test/mcp",
    max_output_tokens: 128, deadline_ms: Date.now() + 30000,
    allowed, system: "Bounded native Agent test", user: "Do the work"};
}
const reportArgs = {status: "done", summary: "Report accepted by test gateway"};
const call = (name, argumentsValue = {}) => ({type: "toolCall", id: randomUUID(), name, arguments: argumentsValue});
function scriptedStream(scripts, calls) {
  return (model, context, options) => {
    calls.push({model, context, options});
    const scripted = scripts[Math.min(calls.length - 1, scripts.length - 1)];
    const content = typeof scripted === "function" ? scripted() : scripted;
    options.onPayload({model: model.id, tools: context.tools.map((tool) => ({type: "function", name: tool.name}))});
    const stream = createAssistantMessageEventStream();
    const message = {role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
      usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
      stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now()};
    stream.push({type: "start", partial: message});
    stream.push({type: "done", reason: message.stopReason, message});
    stream.end();
    return stream;
  };
}
function catalog(allowed, callTool) {
  return {listTools: async () => ({tools: allowed.map((name) => ({name,
    inputSchema: {type: "object", properties: {}, additionalProperties: true}}))}), callTool};
}
const result = (status, isError = false, extra = {}) => ({isError,
  structuredContent: {status, ...extra}, content: [{type: "text", text: JSON.stringify({status, ...extra})}]});

test("actual native Agent preserves denied report and only stops after gateway acceptance", async () => {
  const input = config();
  const modelCalls = [], events = [], tools = [];
  const tracker = await runEpisode(input, {
    client: catalog(input.allowed, async (request) => {
      tools.push(request);
      return tools.length === 1 ? result("denied", true) : result("applied");
    }),
    emit: (event) => events.push(event),
    stream: scriptedStream([[call("helm_work_report", reportArgs)], [call("helm_work_report", reportArgs)]], modelCalls),
  });
  assert.equal(modelCalls.length, 2);
  assert.equal(tools.length, 2);
  assert.equal(tracker.report.status, "done");
  assert.equal(events.filter((event) => event.type === "tool")[0].is_error, true);
  assert.ok(modelCalls.every(({model, options}) => model.api === "openai-responses"
    && model.baseUrl === input.base_url + "/v1" && options.apiKey === input.token && options.transport === "sse"));
});

test("native sequential batch cannot dispatch after an escalated result", async () => {
  const input = config(["helm_work_delegate", "helm_work_report"]);
  const modelCalls = [], dispatched = [];
  const attempt = randomUUID();
  const tracker = await runEpisode(input, {
    client: catalog(input.allowed, async (request) => {
      dispatched.push(request.name);
      return result("escalated", false, {attempt_id: attempt});
    }), emit: () => {},
    stream: scriptedStream([[call("helm_work_delegate"), call("helm_work_report", reportArgs)]], modelCalls),
  });
  assert.deepEqual(dispatched, ["helm_work_delegate"]);
  assert.deepEqual(tracker.attempts, [attempt]);
  assert.equal(tracker.report, null);
  assert.equal(modelCalls.length, 1);
});

test("model-requested built-in tool has no executable implementation", async () => {
  const input = config();
  const modelCalls = [], dispatched = [];
  const tracker = await runEpisode(input, {
    client: catalog(input.allowed, async (request) => { dispatched.push(request); return result("applied"); }),
    emit: () => {}, stream: scriptedStream([[call("read_file", {path: "/private"})],
      [{type: "text", text: "No permitted report was applied"}]], modelCalls),
  });
  assert.deepEqual(dispatched, []);
  assert.equal(tracker.report, null);
  assert.equal(modelCalls.length, 2);
});

test("cancellation aborts native MCP work and prevents the next tool in its batch", async () => {
  const input = config(["helm_work_get", "helm_work_report"]);
  const controller = new AbortController();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const dispatched = [];
  const running = runEpisode(input, {
    client: catalog(input.allowed, async (request, _schema, options) => {
      dispatched.push(request.name);
      entered();
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("MCP cancelled")), {once: true});
      });
    }), emit: () => {}, signal: controller.signal,
    stream: scriptedStream([[call("helm_work_get"), call("helm_work_report", reportArgs)]], []),
  });
  await started;
  controller.abort();
  await assert.rejects(running);
  assert.deepEqual(dispatched, ["helm_work_get"]);
});

test("nonterminal native loop cannot exceed the bounded model turn count", async () => {
  const input = config(["helm_work_get"]);
  const calls = [];
  await assert.rejects(runEpisode(input, {
    client: catalog(input.allowed, async () => result("applied")), emit: () => {},
    stream: scriptedStream([() => [call("helm_work_get")]], calls),
  }));
  assert.equal(calls.length, 20);
});
