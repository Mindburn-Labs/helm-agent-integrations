import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import * as core from "../../../executors/core/dist/index.js";
import {startFakeCp} from "../../../executors/core/dist/testing/fake-cp.js";
import {createRuntime} from "../src/runtime.mjs";

test("actual core binds OpenClaw native verdict intake to the retained episode and minimizes hook data", async (t) => {
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
  assert.equal(outcome.status, "posted");
  assert.equal(cp.observations.length, 1);
  const marker = randomUUID(), callId = randomUUID(), params = {path: "work.txt", content: marker};
  assert.equal(await runtime.beforeTool({toolName: "read", toolCallId: callId, params}, context), undefined);
  assert.equal(cp.observations.length, 2);
  const observation = cp.observations[1];
  assert.equal(observation.coverage, "observed-only"); assert.equal(observation.client, "openclaw");
  assert.equal(observation.episode_id, checked.slot.episode_id); assert.equal(observation.work_item_id, workItem);
  assert.equal(observation.session_id, context.sessionId); assert.equal(observation.tool.use_id, callId);
  assert.equal(observation.tool.input_digest, core.inputDigest(params));
  assert.equal(observation.tool.input_summary, undefined);
  assert.deepEqual(observation.external_verdict, {source: "openclaw.helm.before_tool_call", decision: "ALLOW",
    tool: "read", observed_at: observation.external_verdict.observed_at});
  assert.ok(Number.isFinite(Date.parse(observation.external_verdict.observed_at)));
  assert.equal(cp.observations[0].external_verdict, undefined); // Post events contain no inferred verdict from results.
  assert.equal(JSON.stringify(cp.observations).includes(marker), false);
  assert.equal(observation.tool_input, undefined); assert.equal(observation.tool_response, undefined);
  assert.equal(observation.result, undefined); assert.equal(observation.admission, undefined); assert.equal(observation.permit, undefined);
  // Canonical producer-owned CP contract fixture, not deployed CP or live T98.
  await core.runCli(["stop"], ctx.env, {stdout: () => {}, stderr: () => {}, readStdin: async () => null});
  assert.equal((await runtime.beforeTool({toolName: "read", params: {}}, context)).block, true);
  assert.equal(requests.length, 0);
});
