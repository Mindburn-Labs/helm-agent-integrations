import test from "node:test";
import assert from "node:assert/strict";
import { AcpSessionManager } from "./manager.js";
import { SessionStore } from "./session-store.js";
import { pickPermissionOption } from "./permission.js";
import { cleanupTmpDir, fakeLaunchSpec, FakeKernelEvaluator, guardFor, makeTmpDir } from "./test-utils.js";

test("an approval for one effect cannot grant an adapter persistent authority", () => {
  assert.equal(pickPermissionOption([{ optionId: "persistent", kind: "allow_always" }], "allow_once"), undefined);
});

test("a pre-aborted run never constructs a launch spec or starts a prompt", async () => {
  const cwd = await makeTmpDir();
  let launches = 0;
  const manager = new AcpSessionManager({
    sessionStore: new SessionStore(cwd),
    fsGuard: guardFor(cwd),
    evaluator: new FakeKernelEvaluator(),
    launchSpecFor: () => { launches++; return fakeLaunchSpec({}); },
    disposeGraceMs: 0,
  });
  try {
    const result = await manager.runPrompt({
      runId: "already-stopped", agent: "codex", cwd, prompt: "must not execute", policy: "ask",
      onEvent: () => {}, signal: AbortSignal.abort(),
    });
    assert.equal(result.stopReason, "cancelled");
    assert.equal(launches, 0);
  } finally {
    await manager.disposeAll();
    await cleanupTmpDir(cwd);
  }
});
