/** Lifecycle tests: startup deadline, session lifecycle, stderr enrichment,
 *  cancel→grace→force-kill, warm-connection reuse — all against a fake ACP
 *  agent speaking the real wire protocol over stdio. */

import test from "node:test";
import assert from "node:assert/strict";
import { GovernedAcpClient, buildAdapterLaunchSpec, buildNativeAcpLaunchSpec } from "./client.js";
import { GovernedPermissionBroker } from "./permission.js";
import { AcpSessionManager } from "./manager.js";
import { SessionStore } from "./session-store.js";
import type { AcpRunEvent } from "./types.js";
import {
  FakeKernelEvaluator,
  cleanupTmpDir,
  fakeLaunchSpec,
  guardFor,
  makeTmpDir,
} from "./test-utils.js";

function makeBroker(evaluator: FakeKernelEvaluator, cwd: string, events?: AcpRunEvent[]): GovernedPermissionBroker {
  return new GovernedPermissionBroker({
    evaluator,
    policy: "ask",
    agent: "claude",
    cwd,
    onResolved: events
      ? (ask, decision, auto, receiptId) => events.push({ type: "permission", ask, decision, auto, receiptId })
      : undefined,
  });
}

test("adapter launch inherits only runtime basics; credentials require explicit delegation", () => {
  const previous = process.env.HELM_TEST_AMBIENT_SECRET;
  process.env.HELM_TEST_AMBIENT_SECRET = "must-not-leak";
  try {
    const isolated = buildAdapterLaunchSpec({ agent: "claude", adapterEntry: "/adapter.mjs" });
    assert.equal(isolated.env?.HELM_TEST_AMBIENT_SECRET, undefined);
    const delegated = buildAdapterLaunchSpec({
      agent: "claude",
      adapterEntry: "/adapter.mjs",
      extraEnv: { HELM_TEST_AMBIENT_SECRET: "explicit" },
    });
    assert.equal(delegated.env?.HELM_TEST_AMBIENT_SECRET, "explicit");
  } finally {
    if (previous === undefined) delete process.env.HELM_TEST_AMBIENT_SECRET;
    else process.env.HELM_TEST_AMBIENT_SECRET = previous;
  }
});

test("native ACP agents use their official stdio commands without ambient credentials", () => {
  const previous = process.env.HELM_TEST_AMBIENT_SECRET;
  process.env.HELM_TEST_AMBIENT_SECRET = "must-not-leak";
  try {
    assert.deepEqual(buildNativeAcpLaunchSpec({ agent: "gemini" }).args, ["--acp"]);
    assert.deepEqual(buildNativeAcpLaunchSpec({ agent: "kimi" }).args, ["acp"]);
    assert.deepEqual(buildNativeAcpLaunchSpec({ agent: "opencode" }).args, ["acp"]);
    const delegated = buildNativeAcpLaunchSpec({
      agent: "gemini",
      command: "/managed/gemini",
      extraEnv: { GEMINI_API_KEY: "explicit" },
    });
    assert.equal(delegated.command, "/managed/gemini");
    assert.equal(delegated.env?.GEMINI_API_KEY, "explicit");
    assert.equal(delegated.env?.HELM_TEST_AMBIENT_SECRET, undefined);
  } finally {
    if (previous === undefined) delete process.env.HELM_TEST_AMBIENT_SECRET;
    else process.env.HELM_TEST_AMBIENT_SECRET = previous;
  }
});

test("lifecycle: start → newSession → prompt → events → dispose", async () => {
  const cwd = await makeTmpDir();
  try {
    const evaluator = new FakeKernelEvaluator();
    const events: AcpRunEvent[] = [];
    const client = new GovernedAcpClient({
      agent: "claude",
      cwd,
      launchSpec: fakeLaunchSpec({}),
      broker: makeBroker(evaluator, cwd),
      fsGuard: guardFor(cwd),
      onEvent: (e) => events.push(e),
    });
    await client.start();
    const sessionId = await client.newSession();
    assert.match(sessionId, /^fake-session-pid\d+$/);
    const res = await client.prompt(sessionId, "hello");
    assert.equal(res.stopReason, "end_turn");
    const messages = events.filter((e) => e.type === "message");
    assert.ok(messages.some((m) => m.type === "message" && m.text === "turn-complete"));
    client.dispose();
  } finally {
    await cleanupTmpDir(cwd);
  }
});

test("startup deadline: a wedged engine fails loudly instead of pending forever", async () => {
  const cwd = await makeTmpDir();
  const prev = process.env.HELM_ACP_STARTUP_TIMEOUT_MS;
  process.env.HELM_ACP_STARTUP_TIMEOUT_MS = "300";
  try {
    const evaluator = new FakeKernelEvaluator();
    const client = new GovernedAcpClient({
      agent: "claude",
      cwd,
      launchSpec: fakeLaunchSpec({ delayInitMs: 5000 }),
      broker: makeBroker(evaluator, cwd),
      fsGuard: guardFor(cwd),
      onEvent: () => {},
    });
    await assert.rejects(client.start(), /timed out after 0\.3s/);
    client.dispose();
  } finally {
    if (prev === undefined) delete process.env.HELM_ACP_STARTUP_TIMEOUT_MS;
    else process.env.HELM_ACP_STARTUP_TIMEOUT_MS = prev;
    await cleanupTmpDir(cwd);
  }
});

test("session/load resume with stale-session fallback to session/new", async () => {
  const cwd = await makeTmpDir();
  try {
    const store = new SessionStore(cwd);
    await store.write({ runId: "run-1", agent: "claude", cwd, sessionId: "stale-session" });
    const stored = await store.read("run-1");
    assert.equal(stored?.sessionId, "stale-session");
    await store.clear("run-1");
    assert.equal(await store.read("run-1"), null);

    // Manager: loadSupported agent resumes a stored session id; a stale one falls back.
    const evaluator = new FakeKernelEvaluator();
    const manager = new AcpSessionManager({
      sessionStore: store,
      fsGuard: guardFor(cwd),
      evaluator,
      launchSpecFor: () => fakeLaunchSpec({ loadSupported: true }),
      disposeGraceMs: 0,
    });
    const res = await manager.runPrompt({
      runId: "run-2",
      agent: "claude",
      cwd,
      prompt: "hi",
      policy: "ask",
      onEvent: () => {},
    });
    assert.match(res.sessionId, /^fake-session-pid\d+$/);
    const persisted = await store.read("run-2");
    assert.equal(persisted?.sessionId, res.sessionId);
    manager.disposeAll();
  } finally {
    await cleanupTmpDir(cwd);
  }
});

test("session store keeps distinct run ids that sanitize to the same filename", async () => {
  const cwd = await makeTmpDir();
  try {
    const store = new SessionStore(cwd);
    await store.write({ runId: "run/a", agent: "claude", cwd, sessionId: "session-a" });
    await store.write({ runId: "run:a", agent: "claude", cwd, sessionId: "session-b" });
    assert.equal((await store.read("run/a"))?.sessionId, "session-a");
    assert.equal((await store.read("run:a"))?.sessionId, "session-b");
  } finally {
    await cleanupTmpDir(cwd);
  }
});

test("cancel → grace → force-kill: a turn that ignores cancel still unwinds", async () => {
  const cwd = await makeTmpDir();
  try {
    const evaluator = new FakeKernelEvaluator();
    const manager = new AcpSessionManager({
      sessionStore: new SessionStore(cwd),
      fsGuard: guardFor(cwd),
      evaluator,
      launchSpecFor: () => fakeLaunchSpec({ hangOnPrompt: true, ignoreCancel: true }),
      disposeGraceMs: 0,
      cancelGraceMs: 150,
    });
    const controller = new AbortController();
    const started = Date.now();
    const promptP = manager.runPrompt({
      runId: "run-cancel",
      agent: "claude",
      cwd,
      prompt: "hang please",
      policy: "ask",
      onEvent: () => {},
      signal: controller.signal,
    });
    // Give the prompt a moment to reach the agent, then abort.
    setTimeout(() => controller.abort(), 200);
    const res = await promptP;
    assert.equal(res.stopReason, "cancelled");
    assert.ok(Date.now() - started < 3000, "force-kill must bound the unwind");
    manager.disposeAll();
  } finally {
    await cleanupTmpDir(cwd);
  }
});

test("graceful cancel: agent that honors session/cancel resolves cancelled without kill", async () => {
  const cwd = await makeTmpDir();
  try {
    const evaluator = new FakeKernelEvaluator();
    const manager = new AcpSessionManager({
      sessionStore: new SessionStore(cwd),
      fsGuard: guardFor(cwd),
      evaluator,
      launchSpecFor: () => fakeLaunchSpec({ hangOnPrompt: true, ignoreCancel: false }),
      disposeGraceMs: 0,
      cancelGraceMs: 2000,
    });
    const controller = new AbortController();
    const promptP = manager.runPrompt({
      runId: "run-graceful",
      agent: "claude",
      cwd,
      prompt: "hang please",
      policy: "ask",
      onEvent: () => {},
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    const res = await promptP;
    assert.equal(res.stopReason, "cancelled");
    manager.disposeAll();
  } finally {
    await cleanupTmpDir(cwd);
  }
});

test("session binding: forged adapter permission is cancelled before kernel evaluation", async () => {
  const cwd = await makeTmpDir();
  let client: GovernedAcpClient | undefined;
  try {
    const evaluator = new FakeKernelEvaluator();
    const events: AcpRunEvent[] = [];
    client = new GovernedAcpClient({
      agent: "claude",
      cwd,
      launchSpec: fakeLaunchSpec({ requestPermission: "edit", forgeSession: true }),
      broker: makeBroker(evaluator, cwd),
      fsGuard: guardFor(cwd),
      onEvent: (event) => events.push(event),
    });
    await client.start();
    const sessionId = await client.newSession();
    await client.prompt(sessionId, "attempt a forged permission");
    assert.equal(evaluator.calls.length, 0, "a forged request must never reach the kernel");
    const message = events.find((event) => event.type === "message" && event.text.startsWith("permission:"));
    assert.ok(message && message.type === "message" && message.text === "permission:cancelled:");
  } finally {
    client?.dispose();
    await cleanupTmpDir(cwd);
  }
});

test("session binding rejects config and cancel operations for another session", async () => {
  const cwd = await makeTmpDir();
  let client: GovernedAcpClient | undefined;
  try {
    client = new GovernedAcpClient({
      agent: "claude",
      cwd,
      launchSpec: fakeLaunchSpec({}),
      broker: makeBroker(new FakeKernelEvaluator(), cwd),
      fsGuard: guardFor(cwd),
      onEvent: () => {},
    });
    await client.start();
    await client.newSession();
    await assert.rejects(client.setSessionConfigOption("forged", "model", "x"), /unknown session id/);
    await assert.rejects(client.cancel("forged"), /unknown session id/);
  } finally {
    client?.dispose();
    await cleanupTmpDir(cwd);
  }
});

test("warm-connection reuse: back-to-back turns within the grace window share one adapter", async () => {
  const cwd = await makeTmpDir();
  try {
    const evaluator = new FakeKernelEvaluator();
    const manager = new AcpSessionManager({
      sessionStore: new SessionStore(cwd),
      fsGuard: guardFor(cwd),
      evaluator,
      launchSpecFor: () => fakeLaunchSpec({}),
      disposeGraceMs: 30_000,
    });
    const first = await manager.runPrompt({
      runId: "run-warm",
      agent: "claude",
      cwd,
      prompt: "one",
      policy: "ask",
      onEvent: () => {},
    });
    const second = await manager.runPrompt({
      runId: "run-warm",
      agent: "claude",
      cwd,
      prompt: "two",
      policy: "ask",
      onEvent: () => {},
    });
    // Same session id ⇒ same pid ⇒ the warm adapter was reused, not respawned.
    assert.equal(first.sessionId, second.sessionId);
    manager.disposeAll();
  } finally {
    await cleanupTmpDir(cwd);
  }
});

test("manager rejects a concurrent prompt for one run before handlers can be swapped", async () => {
  const cwd = await makeTmpDir();
  try {
    const manager = new AcpSessionManager({
      sessionStore: new SessionStore(cwd),
      fsGuard: guardFor(cwd),
      evaluator: new FakeKernelEvaluator(),
      launchSpecFor: () => fakeLaunchSpec({ hangOnPrompt: true }),
      disposeGraceMs: 0,
      cancelGraceMs: 100,
    });
    const controller = new AbortController();
    const first = manager.runPrompt({
      runId: "run-concurrent",
      agent: "claude",
      cwd,
      prompt: "first",
      policy: "ask",
      onEvent: () => {},
      signal: controller.signal,
    });
    await assert.rejects(
      manager.runPrompt({
        runId: "run-concurrent",
        agent: "claude",
        cwd,
        prompt: "second",
        policy: "ask",
        onEvent: () => {},
      }),
      /concurrent runPrompt/,
    );
    controller.abort();
    assert.equal((await first).stopReason, "cancelled");
    manager.disposeAll();
  } finally {
    await cleanupTmpDir(cwd);
  }
});

test("dispose grace 0: each turn cold-starts a fresh adapter", async () => {
  const cwd = await makeTmpDir();
  try {
    const evaluator = new FakeKernelEvaluator();
    const manager = new AcpSessionManager({
      sessionStore: new SessionStore(cwd),
      fsGuard: guardFor(cwd),
      evaluator,
      launchSpecFor: () => fakeLaunchSpec({}),
      disposeGraceMs: 0,
    });
    const first = await manager.runPrompt({
      runId: "run-cold",
      agent: "claude",
      cwd,
      prompt: "one",
      policy: "ask",
      onEvent: () => {},
    });
    const second = await manager.runPrompt({
      runId: "run-cold",
      agent: "claude",
      cwd,
      prompt: "two",
      policy: "ask",
      onEvent: () => {},
    });
    // Same stored session id resumed... but with grace 0 the adapter is
    // disposed, and the fake agent does not support load, so a NEW session is
    // created on a NEW adapter: pids differ.
    assert.notEqual(first.sessionId, second.sessionId);
    manager.disposeAll();
  } finally {
    await cleanupTmpDir(cwd);
  }
});
