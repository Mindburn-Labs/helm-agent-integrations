import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

function evidenceResponse(
  content: Uint8Array,
  evidenceHash: string,
  status = 200,
): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        const values: Record<string, string> = {
          "content-type": "application/octet-stream",
          "x-helm-evidence-hash": evidenceHash,
        };
        return values[name.toLowerCase()] ?? null;
      },
    },
    async json() {
      throw new SyntaxError("binary EvidencePack");
    },
    async text() {
      return "binary EvidencePack";
    },
    async arrayBuffer() {
      return content.slice().buffer as ArrayBuffer;
    },
  };
}

function sha256(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
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
    workspaceId: "workspace-preflight",
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
  assert.equal(postedHeaders?.["X-Helm-Workspace-ID"], "workspace-preflight");
  assert.deepEqual(posted, {
    principal: "agent-1",
    action: "EXECUTE_TOOL",
    resource: "tool.gmail.send_email",
    tool: "EXECUTE_TOOL",
    args: { to: "ops@example.com" },
    agent_id: "agent-1",
    effect_level: "tool.gmail.send_email",
    session_id: "session-preflight",
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

test("withHelmBoundary rejects ALLOW without a durable receipt reference", async () => {
  let dispatched = 0;
  const wrapped = withHelmBoundary({
    actionUrn: "tool.demo.missing_receipt",
    sessionId: "session-missing-receipt",
    tenantId: "tenant-missing-receipt",
    principal: "principal-missing-receipt",
    apiKey: "api-key-missing-receipt",
    fetch: async () => response({ verdict: "ALLOW", decision_id: "decision-only" }),
    tool: async () => {
      dispatched += 1;
      return "should-not-run";
    },
  });

  await assert.rejects(wrapped({ value: 1 }), /ALLOW response is missing the durable receipt_id/);
  assert.equal(dispatched, 0);
});

test("withHelmBoundary rejects malformed or conflicting evaluate evidence", async () => {
  const malformed: Array<{
    body: Record<string, unknown>;
    headers: Record<string, string>;
    error: RegExp;
  }> = [
    {
      body: { verdict: "ALLOW", receipt_id: "receipt-body" },
      headers: { "x-helm-receipt-id": "receipt-body", "x-helm-verdict": "DENY" },
      error: /conflicting verdict values/,
    },
    {
      body: { verdict: "ALLOW", receipt_id: "receipt-body" },
      headers: { "x-helm-receipt-id": "receipt-header" },
      error: /conflicting receipt_id values/,
    },
    {
      body: { verdict: "ALLOW", receipt_id: "   " },
      headers: {},
      error: /missing the durable receipt_id/,
    },
  ];

  for (const vector of malformed) {
    let dispatched = 0;
    const wrapped = withHelmBoundary({
      actionUrn: "tool.demo.malformed",
      sessionId: "session-malformed",
      tenantId: "tenant-malformed",
      principal: "principal-malformed",
      apiKey: "api-key-malformed",
      fetch: async () => response(vector.body, vector.headers),
      tool: async () => {
        dispatched += 1;
        return "should-not-run";
      },
    });

    await assert.rejects(wrapped({ value: 1 }), vector.error);
    assert.equal(dispatched, 0);
  }
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

test("Codex and Claude compositions enforce verdicts and authenticate preflight EvidencePacks", async (t) => {
  const connectors = [
    {
      name: "Codex",
      intent: () => fromCodexToolCall({
        recipient_name: "functions.exec_command",
        parameters: { cmd: "git status --short" },
        session_id: "codex-session-2",
      }),
    },
    {
      name: "Claude",
      intent: () => fromClaudeToolCall({
        tool_name: "Edit",
        tool_input: { file_path: "README.md", old_string: "old", new_string: "new" },
        session_id: "claude-session-2",
      }),
    },
  ];

  for (const connector of connectors) {
    await t.test(`${connector.name} ALLOW returns durable receipt and verified EvidencePack hash`, async () => {
      const intent = connector.intent();
      const pack = new TextEncoder().encode(`${connector.name} preflight EvidencePack`);
      const packHash = sha256(pack);
      const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
      let dispatches = 0;
      const fetchImpl: FetchLike = async (url, init) => {
        const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
        requests.push({ url, body });
        assert.equal(init?.headers?.Authorization, "Bearer api-key-conformance");
        assert.equal(init?.headers?.["X-Helm-Tenant-ID"], "tenant-conformance");
        assert.equal(init?.headers?.["X-Helm-Principal-ID"], "principal-conformance");
        assert.equal(init?.headers?.["X-Helm-Workspace-ID"], "workspace-conformance");
        if (url.endsWith("/api/v1/evaluate")) {
          return response({
            verdict: "ALLOW",
            decision_id: `${connector.name.toLowerCase()}-decision-allow`,
            receipt_id: `${connector.name.toLowerCase()}-receipt-allow`,
          });
        }
        assert.equal(url, "https://kernel.example.test/api/v1/evidence/export");
        return evidenceResponse(pack, packHash);
      };

      const wrapped = withHelmBoundary({
        actionUrn: intent.actionUrn,
        sessionId: intent.sessionId ?? "",
        tenantId: "tenant-conformance",
        principal: "principal-conformance",
        workspaceId: "workspace-conformance",
        apiKey: "api-key-conformance",
        helmUrl: "https://kernel.example.test",
        riskClass: intent.riskClass,
        effectClass: intent.effectClass,
        metadata: intent.metadata,
        exportEvidence: true,
        fetch: fetchImpl,
        tool: async (input: unknown) => {
          dispatches += 1;
          return { input };
        },
      });
      const result = await wrapped(intent.input);

      assert.equal(result.allowed, true);
      assert.equal(result.dispatched, true);
      assert.equal(dispatches, 1);
      assert.equal(result.receipt?.receiptId, `${connector.name.toLowerCase()}-receipt-allow`);
      assert.equal(result.evidencePack?.evidenceHash, packHash);
      assert.deepEqual(result.evidencePack?.content, pack);
      assert.equal(requests.length, 2);
      assert.equal(requests[0]?.url, "https://kernel.example.test/api/v1/evaluate");
      assert.equal(requests[0]?.body.action, "EXECUTE_TOOL");
      assert.equal(requests[0]?.body.resource, intent.actionUrn);
      assert.equal(requests[0]?.body.tool, "EXECUTE_TOOL");
      assert.deepEqual(requests[0]?.body.args, intent.input);
      assert.equal(requests[0]?.body.agent_id, "principal-conformance");
      assert.equal(requests[0]?.body.effect_level, intent.actionUrn);
      assert.equal(requests[0]?.body.session_id, intent.sessionId);
      const context = requests[0]?.body.context as Record<string, unknown>;
      assert.equal(context.tool, intent.actionUrn);
      assert.deepEqual(context.args, intent.input);
      assert.equal(context.effect_level, "E4");
      assert.equal(context.session_id, intent.sessionId);
      assert.deepEqual(requests[1]?.body, { session_id: intent.sessionId, format: "tar.gz" });
    });

    await t.test(`${connector.name} DENY returns evidence and never dispatches`, async () => {
      const intent = connector.intent();
      const pack = new TextEncoder().encode(`${connector.name} denied preflight EvidencePack`);
      let dispatches = 0;
      const result = await withHelmBoundary({
        actionUrn: intent.actionUrn,
        sessionId: intent.sessionId ?? "",
        tenantId: "tenant-conformance",
        principal: "principal-conformance",
        apiKey: "api-key-conformance",
        exportEvidence: true,
        fetch: async (url) => url.endsWith("/api/v1/evaluate")
          ? response({ verdict: "DENY", receipt_id: `${connector.name}-receipt-deny` })
          : evidenceResponse(pack, sha256(pack)),
        tool: async () => {
          dispatches += 1;
          return "unexpected";
        },
      })(intent.input);

      assert.equal(result.allowed, false);
      assert.equal(result.dispatched, false);
      assert.equal(result.receipt?.receiptId, `${connector.name}-receipt-deny`);
      assert.equal(result.evidencePack?.evidenceHash, sha256(pack));
      assert.equal(dispatches, 0);
    });

    await t.test(`${connector.name} Kernel error fails closed`, async () => {
      const intent = connector.intent();
      let dispatches = 0;
      await assert.rejects(
        withHelmBoundary({
          actionUrn: intent.actionUrn,
          sessionId: intent.sessionId ?? "",
          tenantId: "tenant-conformance",
          principal: "principal-conformance",
          apiKey: "api-key-conformance",
          exportEvidence: true,
          fetch: async () => response({ error: "unavailable" }, {}, 503),
          tool: async () => {
            dispatches += 1;
            return "unexpected";
          },
        })(intent.input),
        /HELM preflight failed with HTTP 503/,
      );
      assert.equal(dispatches, 0);
    });

    await t.test(`${connector.name} tampered EvidencePack fails closed before dispatch`, async () => {
      const intent = connector.intent();
      const pack = new TextEncoder().encode(`${connector.name} tampered preflight EvidencePack`);
      let dispatches = 0;
      await assert.rejects(
        withHelmBoundary({
          actionUrn: intent.actionUrn,
          sessionId: intent.sessionId ?? "",
          tenantId: "tenant-conformance",
          principal: "principal-conformance",
          apiKey: "api-key-conformance",
          exportEvidence: true,
          fetch: async (url) => url.endsWith("/api/v1/evaluate")
            ? response({ verdict: "ALLOW", receipt_id: `${connector.name}-receipt-tamper` })
            : evidenceResponse(pack, `sha256:${"0".repeat(64)}`),
          tool: async () => {
            dispatches += 1;
            return "unexpected";
          },
        })(intent.input),
        /HELM evidence export hash mismatch/,
      );
      assert.equal(dispatches, 0);
    });
  }
});

test("EvidencePack export HTTP failure preserves status and blocks dispatch", async () => {
  const intent = fromCodexToolCall({
    recipient_name: "functions.exec_command",
    parameters: { cmd: "git status --short" },
    session_id: "codex-export-error",
  });
  let dispatches = 0;
  const wrapped = withHelmBoundary({
    actionUrn: intent.actionUrn,
    sessionId: intent.sessionId ?? "",
    tenantId: "tenant-export-error",
    principal: "principal-export-error",
    apiKey: "api-key-export-error",
    exportEvidence: true,
    fetch: async (url) => {
      if (url.endsWith("/api/v1/evaluate")) {
        return response({ verdict: "ALLOW", receipt_id: "receipt-export-error" });
      }
      return {
        ok: false,
        status: 503,
        headers: { get: () => null },
        async json() {
          throw new SyntaxError("plaintext response");
        },
        async text() {
          return "evidence service unavailable";
        },
      };
    },
    tool: async () => {
      dispatches += 1;
      return "should-not-run";
    },
  });

  await assert.rejects(
    wrapped(intent.input),
    (error: unknown) => error instanceof Error
      && "status" in error
      && error.status === 503
      && "body" in error
      && error.body === "evidence service unavailable",
  );
  assert.equal(dispatches, 0);
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
