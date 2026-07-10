import assert from "node:assert/strict";
import test from "node:test";
import {
  fromBrowserUseAction,
  fromClaudeToolCall,
  fromComposioAction,
  fromCodexToolCall,
  fromE2BExecution,
  fromTinyFishAgentRun,
  fromTinyFishBrowserSession,
  fromTinyFishFetch,
  fromTinyFishSearch,
  normalizeE2BNetwork,
  preflightAction,
  withHelmBoundary,
  type FetchLike,
} from "./index.js";

function response(
  body: unknown,
  headers: Record<string, string> = {},
  status = 200,
): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

test("withHelmBoundary dispatches only on ALLOW", async () => {
  let dispatched = 0;
  const fetchImpl: FetchLike = async () => response(
    { decision: { verdict: "ALLOW", reason_code: "ok", decision_id: "dec-1" } },
    { "x-helm-receipt-id": "rcpt-1" },
  );

  const wrapped = withHelmBoundary({
    actionUrn: "tool.demo.allow",
    sessionId: "session-allow",
    tenantId: "tenant-allow",
    principal: "principal-allow",
    apiKey: "api-key-allow",
    fetch: fetchImpl,
    tool: async (input: { value: number }) => {
      dispatched += 1;
      return { doubled: input.value * 2 };
    },
  });

  const result = await wrapped({ value: 21 });
  assert.equal(result.allowed, true);
  if (!result.allowed) {
    throw new Error("expected ALLOW result");
  }
  assert.equal(result.dispatched, true);
  assert.equal(dispatched, 1);
  assert.deepEqual(result.output, { doubled: 42 });
  assert.equal(result.receipt?.receiptId, "rcpt-1");
});

test("withHelmBoundary does not dispatch on DENY", async () => {
  let dispatched = 0;
  const fetchImpl: FetchLike = async () => response({
    decision: {
      verdict: "DENY",
      reason: "forbidden path",
      reason_code: "POLICY_DENY",
      receipt_id: "rcpt-deny",
    },
  });

  const wrapped = withHelmBoundary({
    actionUrn: "tool.shell.rm_rf",
    sessionId: "session-deny",
    tenantId: "tenant-deny",
    principal: "principal-deny",
    apiKey: "api-key-deny",
    fetch: fetchImpl,
    tool: async () => {
      dispatched += 1;
      return "should not run";
    },
  });

  const result = await wrapped({ command: "rm -rf ./secrets" });
  assert.equal(result.allowed, false);
  assert.equal(result.dispatched, false);
  assert.equal(result.verdict, "DENY");
  assert.equal(dispatched, 0);
  assert.equal(result.receipt?.receiptId, "rcpt-deny");
});

test("preflightAction sends HELM evaluate payload", async () => {
  let posted: unknown;
  let postedURL = "";
  let postedHeaders: Record<string, string> | undefined;
  const fetchImpl: FetchLike = async (_url, init) => {
    postedURL = _url;
    posted = JSON.parse(init?.body ?? "{}");
    postedHeaders = init?.headers;
    return response({ verdict: "ESCALATE", reason: "approval required" });
  };

  const result = await preflightAction({
    actionUrn: "tool.gmail.send_email",
    input: { to: "ops@example.com" },
    sessionId: "session-preflight",
    tenantId: "tenant-preflight",
    apiKey: "api-key-preflight",
    principal: "agent-1",
    riskClass: "T2",
    effectClass: "E4",
    fetch: fetchImpl,
  });

  assert.equal(result.decision.verdict, "ESCALATE");
  assert.equal(postedURL, "http://127.0.0.1:7714/api/v1/evaluate");
  assert.equal(postedHeaders?.Authorization, "Bearer api-key-preflight");
  assert.equal(postedHeaders?.["Content-Type"], "application/json");
  assert.equal(postedHeaders?.["X-Helm-Tenant-ID"], "tenant-preflight");
  assert.equal(postedHeaders?.["X-Helm-Principal-ID"], "agent-1");
  assert.deepEqual(posted, {
    principal: "agent-1",
    action: "EXECUTE_TOOL",
    resource: "tool.gmail.send_email",
    context: {
      tool: "tool.gmail.send_email",
      args: { to: "ops@example.com" },
      arguments: { to: "ops@example.com" },
      agent_id: "agent-1",
      effect_level: "E4",
      session_id: "session-preflight",
      action_urn: "tool.gmail.send_email",
      risk_class: "T2",
      effect_class: "E4",
      metadata: {},
    },
  });
});

test("withHelmBoundary fails closed on Kernel 401", async () => {
  let dispatched = 0;
  const wrapped = withHelmBoundary({
    actionUrn: "tool.demo.unauthorized",
    sessionId: "session-unauthorized",
    tenantId: "tenant-unauthorized",
    principal: "principal-unauthorized",
    apiKey: "rejected-api-key",
    fetch: async () => response({ error: "unauthorized" }, {}, 401),
    tool: async () => {
      dispatched += 1;
      return "should-not-run";
    },
  });

  await assert.rejects(
    wrapped({ value: 1 }),
    (error: unknown) => error instanceof Error && error.message === "HELM preflight failed with HTTP 401",
  );
  assert.equal(dispatched, 0);
});

test("preflightAction rejects missing auth, service credentials, and unsupported classifications", async () => {
  let requests = 0;
  const fetchImpl: FetchLike = async () => {
    requests += 1;
    return response({ verdict: "ALLOW" });
  };
  const base = {
    actionUrn: "tool.demo.validation",
    input: { value: 1 },
    sessionId: "session-validation",
    tenantId: "tenant-validation",
    principal: "principal-validation",
    fetch: fetchImpl,
  };

  await assert.rejects(preflightAction(base), /apiKey is required/);
  await assert.rejects(
    preflightAction({ ...base, serviceToken: "service-key" }),
    /serviceToken is not authorized/,
  );
  await assert.rejects(
    preflightAction({ ...base, apiKey: "api-key", effectClass: "E9" }),
    /Unsupported HELM effectClass/,
  );
  await assert.rejects(
    preflightAction({ ...base, apiKey: "api-key", principal: "" }),
    /principal is required/,
  );
  assert.equal(requests, 0);
});

test("Codex and Claude helpers preserve arguments and ignore caller classification downgrades", () => {
  const codex = fromCodexToolCall({
    recipient_name: "functions.exec_command",
    parameters: { cmd: "gh pr merge 189 --merge" },
    input: { cmd: "wrong fallback" },
    session_id: "codex-session-1",
    thread_id: "thread-1",
    risk_class: "T0",
    effect_class: "E1",
    principal: "spoofed-principal",
    metadata: {
      framework: "spoofed",
      tool_name: "spoofed",
      principal: "spoofed-principal",
      risk_class: "T0",
      effect_class: "E1",
    },
  });
  assert.equal(codex.actionUrn, "tool.codex.functions.exec_command");
  assert.deepEqual(codex.input, { cmd: "gh pr merge 189 --merge" });
  assert.equal(codex.sessionId, "codex-session-1");
  assert.equal(codex.riskClass, "T2");
  assert.equal(codex.effectClass, "E4");
  assert.equal(codex.metadata?.framework, "codex");
  assert.equal(codex.metadata?.tool_name, "functions.exec_command");
  assert.equal(codex.metadata?.thread_id, "thread-1");
  assert.equal(codex.metadata?.principal, undefined);
  assert.equal(codex.metadata?.risk_class, undefined);
  assert.equal(codex.metadata?.effect_class, undefined);
  assert.equal(codex.principal, undefined);

  const claude = fromClaudeToolCall({
    tool_name: "Bash",
    tool_input: { command: "cat README.md" },
    input: { command: "wrong fallback" },
    id: "toolu_1",
    session_id: "claude-session-1",
    risk_class: "T0",
    effect_class: "E1",
    principal: "spoofed-principal",
    metadata: {
      framework: "spoofed",
      tool_name: "spoofed",
      principal: "spoofed-principal",
      risk_class: "T0",
      effect_class: "E1",
    },
  });
  assert.equal(claude.actionUrn, "tool.claude.Bash");
  assert.deepEqual(claude.input, { command: "cat README.md" });
  assert.equal(claude.sessionId, "claude-session-1");
  assert.equal(claude.riskClass, "T2");
  assert.equal(claude.effectClass, "E4");
  assert.equal(claude.metadata?.framework, "claude");
  assert.equal(claude.metadata?.tool_name, "Bash");
  assert.equal(claude.metadata?.tool_use_id, "toolu_1");
  assert.equal(claude.metadata?.principal, undefined);
  assert.equal(claude.metadata?.risk_class, undefined);
  assert.equal(claude.metadata?.effect_class, undefined);
  assert.equal(claude.principal, undefined);
});

test("Codex and Claude intents produce authenticated served Kernel requests", async () => {
  const intents = [
    fromCodexToolCall({
      recipient_name: "functions.exec_command",
      parameters: { cmd: "git status --short" },
      session_id: "codex-session-2",
    }),
    fromClaudeToolCall({
      tool_name: "Edit",
      tool_input: { file_path: "README.md", old_string: "old", new_string: "new" },
      session_id: "claude-session-2",
    }),
  ];

  for (const intent of intents) {
    let posted: Record<string, unknown> = {};
    await preflightAction({
      actionUrn: intent.actionUrn,
      input: intent.input,
      sessionId: intent.sessionId ?? "",
      tenantId: "tenant-conformance",
      apiKey: "api-key-conformance",
      principal: "principal-conformance",
      riskClass: intent.riskClass,
      effectClass: intent.effectClass,
      metadata: intent.metadata,
      fetch: async (_url, init) => {
        posted = JSON.parse(init?.body ?? "{}");
        assert.equal(init?.headers?.Authorization, "Bearer api-key-conformance");
        assert.equal(init?.headers?.["X-Helm-Tenant-ID"], "tenant-conformance");
        assert.equal(init?.headers?.["X-Helm-Principal-ID"], "principal-conformance");
        return response({ verdict: "DENY", receipt_id: "receipt-conformance" });
      },
    });
    assert.equal(posted.action, "EXECUTE_TOOL");
    assert.equal(posted.resource, intent.actionUrn);
    const context = posted.context as Record<string, unknown>;
    assert.equal(context.tool, intent.actionUrn);
    assert.deepEqual(context.args, intent.input);
    assert.deepEqual(context.arguments, intent.input);
    assert.equal(context.effect_level, "E4");
    assert.equal(context.session_id, intent.sessionId);
  }
});

test("new framework helpers normalize Browser Use and Composio calls", () => {

  const browser = fromBrowserUseAction({
    action: "submit",
    url: "https://shop.example/checkout",
  });
  assert.equal(browser.actionUrn, "tool.browser_use.submit");
  assert.equal(browser.riskClass, "T2");
  assert.equal(browser.effectClass, "E4");

  const composio = fromComposioAction({
    app: "salesforce",
    action: "export_records",
    payload: { object: "Lead" },
  });
  assert.equal(composio.actionUrn, "tool.composio.salesforce.export_records");
  assert.deepEqual(composio.input, { object: "Lead" });
});

test("TinyFish helpers emit canonical effect classes and endpoint metadata", () => {
  const search = fromTinyFishSearch({ query: "HELM governed web capability" });
  assert.equal(search.actionUrn, "tool.tinyfish.search.query");
  assert.equal(search.effectClass, "E2");
  assert.equal(search.metadata?.connector_id, "tinyfish-web-v1");
  assert.equal(search.metadata?.endpoint_family, "search");

  const fetch = fromTinyFishFetch({ urls: ["https://example.com"], ttl: 3600 });
  assert.equal(fetch.actionUrn, "tool.tinyfish.fetch.extract");
  assert.equal(fetch.effectClass, "E2");
  assert.equal(fetch.metadata?.endpoint_family, "fetch");

  const browser = fromTinyFishBrowserSession({
    url: "https://portal.example",
    credential_grant_ref: "grant:demo",
    ttl_seconds: 900,
  });
  assert.equal(browser.actionUrn, "tool.tinyfish.browser.session");
  assert.equal(browser.effectClass, "E3");
  assert.equal(browser.metadata?.endpoint_family, "browser");

  const agent = fromTinyFishAgentRun({
    url: "https://shop.example/checkout",
    goal: "Submit the saved cart",
    action_intent: "submit",
  });
  assert.equal(agent.actionUrn, "tool.tinyfish.agent.external_action");
  assert.equal(agent.effectClass, "E4");
  assert.equal(agent.metadata?.endpoint_family, "agent");
});

test("E2B helper normalizes network capability and fails closed", () => {
  const external = fromE2BExecution({ language: "python", code: "print(1)", network: true });
  assert.equal(external.actionUrn, "tool.e2b.execute");
  assert.equal(external.metadata?.network, "external");
  assert.equal(external.effectClass, "E4");

  // Missing network capability must not be treated as isolated.
  const unknown = fromE2BExecution({ language: "python", code: "print(1)" });
  assert.equal(unknown.metadata?.network, "external");
  assert.equal(unknown.effectClass, "E4");

  const isolated = fromE2BExecution({ language: "python", code: "print(1)", network: "none" });
  assert.equal(isolated.metadata?.network, "isolated");
  assert.equal(isolated.effectClass, "E3");

  assert.equal(normalizeE2BNetwork(false), "isolated");
  assert.equal(normalizeE2BNetwork("external"), "external");
  assert.equal(normalizeE2BNetwork({ internet_access: true }), "external");
});
