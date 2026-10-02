import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import * as core from "../../../executors/core/dist/index.js";
import {startFakeCp} from "../../../executors/core/dist/testing/fake-cp.js";
import {createRuntime} from "../src/runtime.mjs";

test("actual core OpenClaw checkout/token/status and stop bind the native plugin; unsupported observe is explicit", async (t) => {
  // The producer-owned fake is a contract fixture, not a second effect ledger.
  const cp = await startFakeCp({pollsBeforeApproval: 0});
  const home = await mkdtemp(join(tmpdir(), "helm-oce-core-"));
  t.after(async () => { await cp.close(); await rm(home, {recursive: true, force: true}); });
  const ctx = core.makeCtx({HELM_EXECUTOR_HOME: home, HELM_EXECUTOR_SLOT: "oce-test", HELM_EXECUTOR_TEST_POLL_MS: "1"});
  await core.login(ctx, {cpUrl: cp.url, org: cp.orgId, say: () => {}});
  const workItem = randomUUID();
  const checked = await core.checkout(ctx, {workItem, client: "openclaw"});
  const requests = [];
  const client = {listTools: async () => ({tools: []}), close: async () => {}};
  const runtime = createRuntime({executorHome: home, slot: "oce-test", edgeOrigin: "https://executor.example.test",
    model: "retained-model", maxOutputTokens: 64, contextWindow: 2048, grantedTools: [], observedNativeTools: ["read"]},
  {client, fetch: async (...args) => { requests.push(args); throw new Error("No model network in this core contract test"); }});
  t.after(() => runtime.close());
  const context = {sessionKey: "agent:oce:core-fixture", sessionId: randomUUID()};
  await runtime.select({}, context);
  assert.equal(runtime.binding().episodeId, checked.slot.episode_id);
  assert.equal(runtime.binding().workItemId, workItem);
  assert.ok(await core.episodeToken(ctx));
  const outcome = await runtime.afterTool({toolName: "read", params: {path: "work.txt"}}, context);
  assert.equal(outcome.status, "failed");
  assert.equal(cp.observations.length, 0); // Current core refuses openclaw; do not claim T98.
  await core.runCli(["stop"], ctx.env, {stdout: () => {}, stderr: () => {}, readStdin: async () => null});
  assert.equal((await runtime.beforeTool({toolName: "read", params: {}}, context)).block, true);
  assert.equal(requests.length, 0);
});
