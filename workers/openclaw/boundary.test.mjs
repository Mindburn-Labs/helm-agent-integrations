import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {boundedEmitter, discoverTools, enforcePayload, gatewayFetch, MAX_EVENT_BYTES,
  MAX_EPISODE_BYTES, MAX_MCP_RESPONSE_BYTES, MAX_MODEL_REQUEST_BYTES, MAX_RESPONSE_BYTES,
  MAX_TOOL_EVENT_BYTES, normalizeResult, readBoundedJSON, validateConfiguration} from "./boundary.mjs";

export function fixture() {
  return {api: "openai-responses", token: randomUUID(), model: "retained-model",
    base_url: "https://model.gateway.test", mcp_url: "https://mcp.gateway.test/mcp",
    max_output_tokens: 128, deadline_ms: Date.now() + 30000,
    allowed: ["helm_work_report"], system: "Bounded test agent", user: "Perform the retained work"};
}

test("private JSON input preserves code points split across reads and rejects malformed or excessive bytes", async () => {
  const original = {text: "é🧭中文"}, raw = Buffer.from(JSON.stringify(original));
  async function* oneByteReads() {
    for (const byte of raw) yield new Uint8Array([byte]);
  }
  assert.deepEqual(await readBoundedJSON(oneByteReads(), raw.length), original);
  await assert.rejects(readBoundedJSON(oneByteReads(), raw.length - 1));
  const broken = [Buffer.from('{"text":"'), new Uint8Array([0xc3]), Buffer.from('"}')];
  await assert.rejects(readBoundedJSON(broken, 1024));
  // The bound counts UTF-8 wire bytes, rather than JavaScript code units.
  await assert.rejects(readBoundedJSON([Buffer.from(JSON.stringify({text: "🧭".repeat(100)}))], 200));
});

test("native gateway fetch rejects credential, redirect, path and provider escapes before dispatch", async () => {
  const config = validateConfiguration(fixture());
  const sent = [];
  const fetch = gatewayFetch(config, async (...args) => { sent.push(args); return new Response("ok"); });
  const auth = {Authorization: `Bearer ${config.token}`};
  await fetch(config.base_url + "/v1/responses", {method: "POST", headers: auth});
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1].redirect, "error");
  await fetch(new Request(config.mcp_url, {method: "POST", headers: auth}));
  assert.equal(sent.length, 2);
  for (const url of ["https://ungranted.provider.test/v1/responses", config.base_url + "/v1/chat/completions",
    config.base_url + "/v1/responses?redirect=outside", config.mcp_url + "/ungranted"]) {
    await assert.rejects(fetch(url, {method: "POST", headers: auth}));
  }
  await assert.rejects(fetch(config.mcp_url, {method: "POST", headers: {Authorization: `Bearer ${randomUUID()}`}}));
  assert.equal(sent.length, 2);
});

test("Responses payload retains route/output cap and rejects hosted or ungranted tools", () => {
  const config = fixture();
  const allowed = new Set(config.allowed);
  const payload = {model: config.model, tools: [{type: "function", name: "helm_work_report"}],
    max_output_tokens: 99999, parallel_tool_calls: true, store: true, previous_response_id: "external-session"};
  enforcePayload(config, allowed, payload);
  assert.equal(payload.max_output_tokens, 128);
  assert.equal(payload.parallel_tool_calls, false);
  assert.equal(payload.store, false);
  assert.equal(payload.previous_response_id, undefined);
  assert.throws(() => enforcePayload(config, allowed, {...payload, model: "unretained-model"}));
  assert.throws(() => enforcePayload(config, allowed, {...payload, tools: [{type: "web_search"}]}));
  assert.throws(() => enforcePayload(config, allowed, {...payload, tools: [{type: "function", name: "read_file"}]}));
});

test("retained tool context may exceed the model response bound within the real gateway request limit", () => {
  const config = fixture(), allowed = new Set(config.allowed);
  const payload = {model: config.model, input: [{type: "function_call_output",
    call_id: randomUUID(), output: "x".repeat(MAX_RESPONSE_BYTES)}]};
  assert.equal(enforcePayload(config, allowed, payload), payload);
  payload.input[0].output = "x".repeat(MAX_MODEL_REQUEST_BYTES);
  assert.throws(() => enforcePayload(config, allowed, payload));
});

test("gateway catalog cannot grant unknown tools, omit required tools or loop forever", async () => {
  const report = {name: "helm_work_report", inputSchema: {type: "object"}};
  const tools = await discoverTools({listTools: async () => ({tools: [report,
    {name: "read_file", inputSchema: {type: "object"}}]})}, [report.name]);
  assert.deepEqual(tools, [report]);
  await assert.rejects(discoverTools({listTools: async () => ({tools: []})}, [report.name]));
  let pages = 0;
  await assert.rejects(discoverTools({listTools: async () => {
    pages++; return {tools: [], nextCursor: "same-cursor"};
  }}, []));
  assert.equal(pages, 2);
});

test("MCP denied and escalated results keep their actual error and status", () => {
  for (const [status, isError] of [["denied", true], ["escalated", false]]) {
    const structuredContent = {status, attempt_id: randomUUID()};
    const normalized = normalizeResult({isError, structuredContent,
      content: [{type: "text", text: JSON.stringify(structuredContent)}]});
    assert.equal(normalized.isError, isError);
    assert.deepEqual(normalized.structured, structuredContent);
    assert.equal(JSON.parse(normalized.text).status, status);
  }
});

test("alternate profiles and non-origin model URLs are rejected", () => {
  for (const changes of [{api: "openai-chat-completions"}, {base_url: "https://model.gateway.test/v1"},
    {base_url: "https://caller@model.gateway.test"}, {deadline_ms: Date.now() - 1}]) {
    assert.throws(() => validateConfiguration({...fixture(), ...changes}));
  }
});

test("streamed and declared response overflows are refused before unbounded parsing", async () => {
  const input = {...fixture(), deadline_ms: Date.now() + 30000.25};
  const options = {method: "POST", headers: {Authorization: `Bearer ${input.token}`}};
  const oversized = gatewayFetch(input, async () => new Response("small", {headers: {"Content-Length": MAX_RESPONSE_BYTES + 1}}));
  await assert.rejects(oversized(input.base_url + "/v1/responses", options));
  const streamed = gatewayFetch(input, async () => new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1)));
  await assert.rejects((await streamed(input.base_url + "/v1/responses", options)).arrayBuffer());
  const total = gatewayFetch(input, async () => new Response(new Uint8Array(MAX_RESPONSE_BYTES)));
  for (let n = 0; n < MAX_EPISODE_BYTES / MAX_RESPONSE_BYTES; n++) {
    await (await total(input.base_url + "/v1/responses", options)).arrayBuffer();
  }
  await assert.rejects((await total(input.base_url + "/v1/responses", options)).arrayBuffer());
});

test("near-limit artifact with its JSON mirror survives MCP transport and exact bounded IPC", async () => {
  const input = fixture(), options = {method: "POST", headers: {Authorization: `Bearer ${input.token}`}};
  // Opaque producer data: this test grants no authority by its shape or summary.
  const structuredContent = {status: "applied", artifact: {payload: "🧭é".repeat(174600)}};
  assert.ok(Buffer.byteLength(JSON.stringify(structuredContent)) < MAX_RESPONSE_BYTES);
  const mirror = JSON.stringify(structuredContent, null, 2);
  const wire = {isError: false, structuredContent, content: [{type: "text", text: mirror}]};
  const json = JSON.stringify({jsonrpc: "2.0", id: 1, result: wire});
  assert.ok(Buffer.byteLength(json) > MAX_RESPONSE_BYTES);
  assert.ok(Buffer.byteLength(json) < MAX_MCP_RESPONSE_BYTES);
  const fetch = gatewayFetch(input, async () => new Response(json,
    {headers: {"Content-Type": "application/json", "Content-Length": Buffer.byteLength(json)}}));
  const received = (await (await fetch(input.mcp_url, options)).json()).result;
  const result = normalizeResult(received);
  assert.deepEqual(result.structured, structuredContent);
  assert.equal(result.text, mirror);
  const event = {type: "tool", name: "helm_work_get", arguments: {work_id: randomUUID()},
    is_error: result.isError, structured: result.structured, text: result.text};
  const lines = [];
  boundedEmitter((line) => lines.push(line))(event);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => Buffer.byteLength(line) <= MAX_EVENT_BYTES));
  const chunks = lines.map((line) => JSON.parse(line));
  assert.ok(chunks.every((chunk, index) => chunk.type === "tool_chunk" && chunk.index === index));
  const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data, "base64")));
  assert.equal(raw.length, chunks[0].size);
  assert.deepEqual(JSON.parse(raw.toString("utf8")), event);
});

test("MCP has a bounded 4 MiB transport while model streams retain 1 MiB and the episode retains 8 MiB", async () => {
  const input = fixture(), options = {method: "POST", headers: {Authorization: `Bearer ${input.token}`}};
  const declared = gatewayFetch(input, async () => new Response("small",
    {headers: {"Content-Length": MAX_MCP_RESPONSE_BYTES + 1}}));
  await assert.rejects(declared(input.mcp_url, options));
  const streamed = gatewayFetch(input, async () => new Response(new Uint8Array(MAX_MCP_RESPONSE_BYTES + 1)));
  await assert.rejects((await streamed(input.mcp_url, options)).arrayBuffer());
  const total = gatewayFetch(input, async () => new Response(new Uint8Array(MAX_MCP_RESPONSE_BYTES)));
  await (await total(input.mcp_url, options)).arrayBuffer();
  await (await total(input.mcp_url, options)).arrayBuffer();
  await assert.rejects((await total(input.mcp_url, options)).arrayBuffer());
});

test("private IPC enforces UTF-8 event and cumulative limits before writing", () => {
  let writes = 0;
  const emit = boundedEmitter(() => { writes++; });
  assert.throws(() => emit({text: "é".repeat(MAX_EVENT_BYTES)}));
  assert.equal(writes, 0);
  const event = {text: "x".repeat(MAX_EVENT_BYTES - 32)};
  for (let n = 0; n < MAX_EPISODE_BYTES / MAX_EVENT_BYTES; n++) emit(event);
  assert.throws(() => emit(event));
  assert.equal(writes, MAX_EPISODE_BYTES / MAX_EVENT_BYTES);
  assert.throws(() => normalizeResult({content: [{type: "text", text: "x".repeat(MAX_MCP_RESPONSE_BYTES)}]}));
});

test("chunked tool IPC refuses oversized results and preflights the complete episode budget", () => {
  const lines = [], emit = boundedEmitter((line) => lines.push(line));
  assert.throws(() => emit({type: "tool", text: "x".repeat(MAX_TOOL_EVENT_BYTES)}));
  assert.equal(lines.length, 0);
  emit({type: "tool", text: "x".repeat(3 * 1024 * 1024)});
  const previous = lines.length;
  // Each result is admitted individually, but both encoded frame sets exceed
  // the 8 MiB episode. No part of the refused second result is written.
  assert.throws(() => emit({type: "tool", text: "x".repeat(3 * 1024 * 1024)}));
  assert.equal(lines.length, previous);
});
