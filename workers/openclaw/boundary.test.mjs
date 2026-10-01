import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {discoverTools, enforcePayload, gatewayFetch, normalizeResult, validateConfiguration} from "./boundary.mjs";

export function fixture() {
  return {api: "openai-responses", token: randomUUID(), model: "retained-model",
    base_url: "https://model.gateway.test", mcp_url: "https://mcp.gateway.test/mcp",
    max_output_tokens: 128, deadline_ms: Date.now() + 30000,
    allowed: ["helm_work_report"], system: "Bounded test agent", user: "Perform the retained work"};
}

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
