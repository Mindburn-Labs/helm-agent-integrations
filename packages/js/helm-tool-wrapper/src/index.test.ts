import assert from "node:assert/strict";
import test from "node:test";
import {
  fromBrowserUseAction,
  fromComposioAction,
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

function response(body: unknown, headers: Record<string, string> = {}): Awaited<ReturnType<FetchLike>> {
  return {
    ok: true,
    status: 200,
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
  const fetchImpl: FetchLike = async (_url, init) => {
    postedURL = _url;
    posted = JSON.parse(init?.body ?? "{}");
    return response({ verdict: "ESCALATE", reason: "approval required" });
  };

  const result = await preflightAction({
    actionUrn: "tool.gmail.send_email",
    input: { to: "ops@example.com" },
    principal: "agent-1",
    riskClass: "T2",
    effectClass: "IRREVERSIBLE",
    fetch: fetchImpl,
  });

  assert.equal(result.decision.verdict, "ESCALATE");
  assert.equal(postedURL, "http://127.0.0.1:7714/api/v1/evaluate");
  assert.deepEqual(posted, {
    principal: "agent-1",
    action: "EXECUTE_TOOL",
    resource: "tool.gmail.send_email",
    context: {
      action_urn: "tool.gmail.send_email",
      risk_class: "T2",
      effect_class: "IRREVERSIBLE",
      arguments: { to: "ops@example.com" },
      metadata: {},
    },
  });
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
