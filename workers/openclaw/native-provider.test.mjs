import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {once} from "node:events";
import {createServer} from "node:http";
import test from "node:test";
import {runEpisode} from "./adapter.mjs";
import {boundedEmitter, gatewayFetch, MAX_RESPONSE_BYTES} from "./boundary.mjs";
import {createGatewayStream} from "./transport.mjs";

const nativeFetch = globalThis.fetch.bind(globalThis);
const reportArgs = {status: "done", summary: "Actual native provider reached loopback gateway"};
async function server(t, handler) {
  const http = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => response.destroy(error));
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(async () => {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });
  return `http://127.0.0.1:${http.address().port}`;
}
function configuration(origin) {
  return {api: "openai-responses", token: randomUUID(), model: "retained-model",
    base_url: origin, mcp_url: origin + "/mcp", max_output_tokens: 128,
    deadline_ms: Date.now() + 30000, allowed: ["helm_work_report"],
    system: "Bounded native provider test", user: "Report the retained work"};
}
function mcp(calls) {
  return {listTools: async () => ({tools: [{name: "helm_work_report",
    inputSchema: {type: "object", properties: {}, additionalProperties: true}}]}),
    callTool: async (request) => {
      calls.push(request);
      return {isError: false, structuredContent: {status: "applied"},
        content: [{type: "text", text: "{\"status\":\"applied\"}"}]};
    }};
}
function reportStream(response, model, name = "helm_work_report", args = reportArgs) {
  const item = {type: "function_call", id: "fc_" + randomUUID(), call_id: "call_" + randomUUID(),
    name, arguments: JSON.stringify(args), status: "completed"};
  const result = {id: "resp_" + randomUUID(), object: "response", created_at: 1,
    model, status: "completed", output: [item], error: null, incomplete_details: null,
    usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2,
      input_tokens_details: {cached_tokens: 0}, output_tokens_details: {reasoning_tokens: 0}}};
  const events = [
    {type: "response.created", response: {...result, status: "in_progress", output: [], usage: null}},
    {type: "response.output_item.added", output_index: 0, item: {...item, status: "in_progress", arguments: ""}},
    {type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments},
    {type: "response.function_call_arguments.done", item_id: item.id, output_index: 0,
      name: item.name, arguments: item.arguments},
    {type: "response.output_item.done", output_index: 0, item},
    {type: "response.completed", response: result},
  ];
  response.writeHead(200, {"Content-Type": "text/event-stream"});
  response.end(events.map((event, sequence_number) =>
    `event: ${event.type}\ndata: ${JSON.stringify({...event, sequence_number})}\n\n`).join(""));
}

test("real Responses SDK and Agent use the injected guarded fetch, exact route and payload", async (t) => {
  const requests = [], calls = [];
  const origin = await server(t, async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({path: request.url, method: request.method,
      auth: request.headers.authorization, payload: JSON.parse(body)});
    reportStream(response, "retained-model");
  });
  const input = configuration(origin);
  let guardedDispatches = 0;
  const fetch = gatewayFetch(input, (...args) => { guardedDispatches++; return nativeFetch(...args); });
  const previous = globalThis.fetch;
  // Reproduces the old ambient-only hook. This test fails if native Undici skips it.
  globalThis.fetch = fetch;
  try {
    const tracker = await runEpisode(input, {client: mcp(calls), emit: () => {}, fetch});
    assert.equal(tracker.report.status, "done");
    assert.equal(guardedDispatches, 1);
    assert.equal(calls.length, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "/v1/responses");
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].auth, `Bearer ${input.token}`);
    assert.equal(requests[0].payload.model, input.model);
    assert.equal(requests[0].payload.max_output_tokens, 128);
    assert.equal(requests[0].payload.parallel_tool_calls, false);
    assert.equal(requests[0].payload.store, false);
    assert.ok(requests[0].payload.tools.every((tool) => tool.type === "function" && tool.name === "helm_work_report"));
  } finally { globalThis.fetch = previous; }
});

test("real Agent/native provider preserves near-limit retained output in the next gateway request", async (t) => {
  const requests = [], calls = [], lines = [];
  const work = randomUUID();
  const structuredContent = {status: "applied", artifact: {payload: "x".repeat(MAX_RESPONSE_BYTES - 128)}};
  const mirror = JSON.stringify(structuredContent, null, 2);
  const origin = await server(t, async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({bytes: Buffer.byteLength(body), payload: JSON.parse(body)});
    if (requests.length === 1) reportStream(response, "retained-model", "helm_work_get", {work_item_id: work});
    else reportStream(response, "retained-model");
  });
  const input = {...configuration(origin), allowed: ["helm_work_get", "helm_work_report"]};
  const client = {listTools: async () => ({tools: input.allowed.map((name) => ({name,
    inputSchema: {type: "object", properties: {}, additionalProperties: true}}))}),
    callTool: async (request) => {
      calls.push(request);
      return request.name === "helm_work_get"
        ? {isError: false, structuredContent, content: [{type: "text", text: mirror}]}
        : {isError: false, structuredContent: {status: "applied"}, content: [{type: "text", text: "applied"}]};
    }};
  const tracker = await runEpisode(input, {client, fetch: gatewayFetch(input, nativeFetch),
    emit: boundedEmitter((line) => lines.push(line))});
  assert.equal(tracker.report.status, "done");
  assert.equal(requests.length, 2);
  assert.ok(requests[1].bytes > MAX_RESPONSE_BYTES);
  const output = requests[1].payload.input.find((item) => item.type === "function_call_output");
  assert.equal(output.output, mirror);
  assert.deepEqual(calls.map((call) => call.name), ["helm_work_get", "helm_work_report"]);
  const chunks = lines.map((line) => JSON.parse(line)).filter((event) => event.type === "tool_chunk");
  const original = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data, "base64"))).toString("utf8"));
  assert.deepEqual(original.structured, structuredContent);
  assert.equal(original.text, mirror);
});

test("real native provider refuses same-origin and foreign-provider redirects before destination dispatch", async (t) => {
  let forbiddenDispatches = 0;
  const foreign = await server(t, (_request, response) => { forbiddenDispatches++; response.end("forbidden"); });
  for (const location of ["/ungranted-provider", foreign + "/v1/responses"]) {
    let sourceDispatches = 0;
    const origin = await server(t, (request, response) => {
      if (request.url !== "/v1/responses") { forbiddenDispatches++; response.end("forbidden"); return; }
      sourceDispatches++;
      response.writeHead(302, {Location: location});
      response.end();
    });
    const input = configuration(origin), calls = [];
    const fetch = gatewayFetch(input, nativeFetch);
    const previous = globalThis.fetch;
    globalThis.fetch = fetch;
    try { await assert.rejects(runEpisode(input, {client: mcp(calls), emit: () => {}, fetch})); }
    finally { globalThis.fetch = previous; }
    assert.equal(sourceDispatches, 1);
    assert.equal(forbiddenDispatches, 0);
    assert.equal(calls.length, 0);
  }
});

test("native provider selection cannot substitute another model, API or provider destination", async (t) => {
  let dispatches = 0;
  const origin = await server(t, (_request, response) => { dispatches++; response.end("forbidden"); });
  const input = configuration(origin);
  const stream = createGatewayStream(input, gatewayFetch(input, nativeFetch));
  const model = {id: input.model, api: input.api, provider: "helm", baseUrl: origin + "/v1"};
  for (const change of [{baseUrl: "https://ungranted.provider.test/v1"},
    {provider: "openai"}, {id: "other-model"}, {api: "anthropic-messages"}]) {
    assert.throws(() => stream({...model, ...change}, {messages: []}, {apiKey: input.token}));
  }
  assert.equal(dispatches, 0);
});

test("actual stalled native provider stream is aborted without dispatching tools", async (t) => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const origin = await server(t, (_request, response) => {
    response.writeHead(200, {"Content-Type": "text/event-stream"});
    response.write("event: response.created\ndata: " + JSON.stringify({type: "response.created",
      response: {id: "resp_stalled", object: "response", created_at: 1, model: "retained-model",
        status: "in_progress", output: [], usage: null}}) + "\n\n");
    entered();
  });
  const input = configuration(origin), calls = [], controller = new AbortController();
  const running = runEpisode(input, {client: mcp(calls), emit: () => {}, signal: controller.signal,
    fetch: gatewayFetch(input, nativeFetch, controller.signal)});
  const rejected = assert.rejects(running);
  await started;
  controller.abort();
  await rejected;
  assert.equal(calls.length, 0);
});
