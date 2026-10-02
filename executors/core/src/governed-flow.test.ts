import assert from "node:assert/strict";
import { test } from "node:test";
import { episodeHeaders } from "./commands/token.js";
import { runGovernedFlow, type FlowStep } from "./testing/governed-flow.js";
import { checkedOut, world, type World } from "./test-utils.js";

const TARGET = "github.com/Mindburn-Labs/helm-qa-sandbox";

async function flow(w: World, extra: Partial<Parameters<typeof runGovernedFlow>[0]> = {}): Promise<FlowStep[]> {
  const ctx = await checkedOut(w);
  const headers = JSON.parse(await episodeHeaders(ctx)) as Record<string, string>;
  return runGovernedFlow({ edgeUrl: w.fake.url, headers, target: TARGET, branchPrefix: "helm/", ...extra });
}

const byName = (steps: FlowStep[], part: string): FlowStep | undefined => steps.find((s) => s.name.includes(part));

test("the governed flow passes end to end, including approval of the pull request", async () => {
  const w = await world();
  try {
    const steps = await flow(w, { waitForApprovalMs: 5_000, onEscalated: (id) => void setTimeout(() => w.fake.gateway.approve(id), 300) });
    assert.deepEqual(steps.filter((s) => s.status !== "PASS").map((s) => `${s.name}: ${s.detail}`), []);
    assert.ok(steps.length >= 9);
    assert.equal(byName(steps, "approved pull request")?.detail, `https://${TARGET}/pull/1`);
    assert.equal([...w.fake.gateway.attempts.values()].filter((a) => a.effectType === "github.branch.create_from_changes").length, 1, "the replay made no second attempt");
  } finally {
    await w.close();
  }
});

test("without a wait the pull request is reported as awaiting approval, not as a failure", async () => {
  const w = await world();
  try {
    const steps = await flow(w);
    assert.equal(byName(steps, "admitted")?.status, "PASS");
    const waiting = byName(steps, "waits for approval");
    assert.equal(waiting?.status, "SKIP");
    assert.match(waiting?.detail ?? "", /approve attempt [0-9a-f-]{36} in the Console/);
    assert.equal(steps.some((s) => s.status === "FAIL"), false);
  } finally {
    await w.close();
  }
});

test("a branch outside the mandate's prefix is refused and the flow stops there", async () => {
  const w = await world();
  try {
    const steps = await flow(w, { branchPrefix: "elsewhere/" });
    const failed = steps.filter((s) => s.status === "FAIL");
    assert.equal(failed.length, 1);
    assert.match(failed[0]?.name ?? "", /creates the branch/);
    assert.match(failed[0]?.detail ?? "", /invalid .*branch prefix helm\//);
    assert.equal(w.fake.gateway.attempts.size, 1, "only the read was an attempt");
  } finally {
    await w.close();
  }
});

test("a token the edge does not accept fails at the first step", async () => {
  const w = await world();
  try {
    const steps = await runGovernedFlow({ edgeUrl: w.fake.url, headers: { Authorization: "Bearer not-a-token" }, target: TARGET, branchPrefix: "helm/" });
    assert.deepEqual(steps.map((s) => [s.name, s.status, s.detail]), [["MCP initialize", "FAIL", "HTTP 401"]]);
  } finally {
    await w.close();
  }
});

test("an edge that does not serve the GitHub effects yet is a skip, not a failure", async () => {
  const w = await world({
    routes: {
      "POST /mcp": ({ res, body }) => {
        const rpc = body as { id?: number; method?: string };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: rpc.method === "tools/list" ? { tools: [{ name: "helm_attempt_get" }] } : { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "x", version: "0" } } }));
      },
    },
  });
  try {
    const steps = await flow(w);
    assert.equal(steps.at(-1)?.status, "SKIP");
    assert.match(steps.at(-1)?.detail ?? "", /github_repository_get/);
    assert.equal(steps.some((s) => s.status === "FAIL"), false);
  } finally {
    await w.close();
  }
});
