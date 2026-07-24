/** Permission broker tests: kernel verdict round-trips, fail-closed defaults,
 *  low-risk tier semantics, sticky allows recorded as receipts, option-family
 *  fallback mapping. */

import test from "node:test";
import assert from "node:assert/strict";
import { GovernedPermissionBroker, pickPermissionOption } from "./permission.js";
import { GovernedAcpClient } from "./client.js";
import type { AcpRunEvent, RequestPermissionRequest } from "./types.js";
import {
  FakeKernelEvaluator,
  cleanupTmpDir,
  fakeLaunchSpec,
  guardFor,
  makeTmpDir,
} from "./test-utils.js";

const OPTIONS = [
  { optionId: "opt-allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "opt-allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
];

function permRequest(kind: string): RequestPermissionRequest {
  return {
    sessionId: "sess-1",
    toolCall: { toolCallId: "tc-1", title: `${kind} something`, kind },
    options: OPTIONS,
  };
}

function makeBroker(
  evaluator: FakeKernelEvaluator,
  policy: "ask" | "auto-approve-reads" = "ask",
): GovernedPermissionBroker {
  return new GovernedPermissionBroker({ evaluator, policy, agent: "claude", cwd: "/tmp" });
}

test("ALLOW verdict maps to an offered allow option", async () => {
  const evaluator = new FakeKernelEvaluator();
  const broker = makeBroker(evaluator);
  const res = await broker.resolve(permRequest("edit"));
  assert.deepEqual(res.outcome, { outcome: "selected", optionId: "opt-allow-once" });
  assert.equal(evaluator.calls.length, 1);
  assert.equal(evaluator.calls[0].tier, "standard");
});

test("DENY verdict maps to a reject option (fail-closed)", async () => {
  const evaluator = new FakeKernelEvaluator();
  evaluator.defaultVerdict = { verdict: "DENY", reasonCode: "POLICY_DENY" };
  const broker = makeBroker(evaluator);
  const res = await broker.resolve(permRequest("edit"));
  assert.deepEqual(res.outcome, { outcome: "selected", optionId: "opt-reject" });
});

test("ESCALATE verdict rejects at this tier — heavyweight ceremony is elsewhere", async () => {
  const evaluator = new FakeKernelEvaluator();
  evaluator.defaultVerdict = { verdict: "ESCALATE" };
  const broker = makeBroker(evaluator);
  const res = await broker.resolve(permRequest("edit"));
  assert.deepEqual(res.outcome, { outcome: "selected", optionId: "opt-reject" });
});

test("evaluator transport failure rejects (fail-closed, never a silent allow)", async () => {
  const evaluator = new FakeKernelEvaluator();
  evaluator.throwError = new Error("connection refused");
  const broker = makeBroker(evaluator);
  const res = await broker.resolve(permRequest("edit"));
  assert.deepEqual(res.outcome, { outcome: "selected", optionId: "opt-reject" });
});

test("auto-approve-reads: read kinds take the low-risk tier and stick with a receipt", async () => {
  const evaluator = new FakeKernelEvaluator();
  const stickies: unknown[] = [];
  const broker = new GovernedPermissionBroker({
    evaluator,
    policy: "auto-approve-reads",
    agent: "claude",
    cwd: "/tmp",
    onStickyAllow: (r) => stickies.push(r),
  });

  const first = await broker.resolve(permRequest("read"));
  assert.deepEqual(first.outcome, { outcome: "selected", optionId: "opt-allow-always" });
  assert.equal(evaluator.calls.length, 1);
  assert.equal(evaluator.calls[0].tier, "low");
  assert.equal(stickies.length, 1);
  assert.deepEqual(
    broker.stickyAllowReceipts().map((r) => r.receiptId),
    ["rcpt-fake"],
  );

  // Second identical ask resolves from sticky memory WITHOUT a new kernel call.
  const second = await broker.resolve(permRequest("read"));
  assert.deepEqual(second.outcome, { outcome: "selected", optionId: "opt-allow-always" });
  assert.equal(evaluator.calls.length, 1);
});

test("auto-approve-reads does NOT extend to mutating kinds (standard tier, no stick)", async () => {
  const evaluator = new FakeKernelEvaluator();
  const broker = makeBroker(evaluator, "auto-approve-reads");
  const res = await broker.resolve(permRequest("edit"));
  assert.deepEqual(res.outcome, { outcome: "selected", optionId: "opt-allow-once" });
  assert.equal(evaluator.calls[0].tier, "standard");
  assert.equal(broker.stickyAllowReceipts().length, 0);
  // A second ask hits the kernel again — no sticky record for standard tier.
  await broker.resolve(permRequest("edit"));
  assert.equal(evaluator.calls.length, 2);
});

test("kernel stickyAllow hint sticks under the plain ask policy too, with receipt", async () => {
  const evaluator = new FakeKernelEvaluator();
  evaluator.defaultVerdict = { verdict: "ALLOW", receiptId: "rcpt-sticky", decisionId: "dec-1", stickyAllow: true };
  const broker = makeBroker(evaluator, "ask");
  const res = await broker.resolve(permRequest("edit"));
  assert.deepEqual(res.outcome, { outcome: "selected", optionId: "opt-allow-always" });
  assert.equal(broker.stickyAllowReceipts()[0]?.receiptId, "rcpt-sticky");
  await broker.resolve(permRequest("edit"));
  assert.equal(evaluator.calls.length, 1);
});

test("option-family fallback: allow maps to allow_once when allow_always is not offered", () => {
  const opt = pickPermissionOption(
    [
      { optionId: "a1", kind: "allow_once" },
      { optionId: "r1", kind: "reject_once" },
    ],
    "allow_always",
  );
  assert.equal(opt?.optionId, "a1");
  const rej = pickPermissionOption([{ optionId: "a1", kind: "allow_once" }], "reject");
  assert.equal(rej, undefined);
});

test("reject with no reject option offered answers cancelled, never an allow", async () => {
  const evaluator = new FakeKernelEvaluator();
  evaluator.defaultVerdict = { verdict: "DENY" };
  const broker = makeBroker(evaluator);
  const res = await broker.resolve({
    sessionId: "s",
    toolCall: { kind: "edit", title: "x" },
    options: [{ optionId: "only-allow", kind: "allow_once" }],
  });
  assert.deepEqual(res.outcome, { outcome: "cancelled" });
});

test("end-to-end: fake agent's requestPermission round-trips through the kernel", async () => {
  const cwd = await makeTmpDir();
  try {
    const evaluator = new FakeKernelEvaluator();
    const events: AcpRunEvent[] = [];
    const client = new GovernedAcpClient({
      agent: "claude",
      cwd,
      launchSpec: fakeLaunchSpec({ requestPermission: "read" }),
      broker: new GovernedPermissionBroker({
        evaluator,
        policy: "auto-approve-reads",
        agent: "claude",
        cwd,
        onResolved: (ask, decision, auto, receiptId) =>
          events.push({ type: "permission", ask, decision, auto, receiptId }),
      }),
      fsGuard: guardFor(cwd),
      onEvent: (e) => events.push(e),
    });
    await client.start();
    const sessionId = await client.newSession();
    const res = await client.prompt(sessionId, "do a read");
    assert.equal(res.stopReason, "end_turn");

    const permEvents = events.filter((e) => e.type === "permission");
    assert.equal(permEvents.length, 1);
    const p = permEvents[0];
    assert.ok(p.type === "permission");
    if (p.type === "permission") {
      assert.equal(p.decision, "allow_always");
      assert.equal(p.receiptId, "rcpt-fake");
      assert.equal(p.ask.kind, "read");
    }
    const msg = events.find((e) => e.type === "message" && e.text.startsWith("permission:"));
    assert.ok(msg && msg.type === "message" && msg.text === "permission:selected:opt-allow-always");
    client.dispose();
  } finally {
    await cleanupTmpDir(cwd);
  }
});

test("end-to-end: kernel DENY reaches the agent as a rejection", async () => {
  const cwd = await makeTmpDir();
  try {
    const evaluator = new FakeKernelEvaluator();
    evaluator.defaultVerdict = { verdict: "DENY", reasonCode: "NO" };
    const events: AcpRunEvent[] = [];
    const client = new GovernedAcpClient({
      agent: "claude",
      cwd,
      launchSpec: fakeLaunchSpec({ requestPermission: "edit" }),
      broker: new GovernedPermissionBroker({ evaluator, policy: "ask", agent: "claude", cwd }),
      fsGuard: guardFor(cwd),
      onEvent: (e) => events.push(e),
    });
    await client.start();
    const sessionId = await client.newSession();
    await client.prompt(sessionId, "edit something");
    const msg = events.find((e) => e.type === "message" && e.text.startsWith("permission:"));
    assert.ok(msg && msg.type === "message" && msg.text === "permission:selected:opt-reject");
    client.dispose();
  } finally {
    await cleanupTmpDir(cwd);
  }
});
