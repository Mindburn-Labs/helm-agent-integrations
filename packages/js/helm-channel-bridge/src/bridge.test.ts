import assert from "node:assert/strict";
import test from "node:test";
import {
  ChannelBridge,
  type ChannelBridgeConfig,
  type ChannelSessionSummary,
  type ChannelTurnEvent,
} from "./bridge.js";
import type {
  ChannelDecision,
  ChannelEvaluationRequest,
} from "./evaluator.js";

class FakeEvaluator {
  requests: ChannelEvaluationRequest[] = [];
  decision: ChannelDecision = { verdict: "ALLOW", receiptId: "rcpt-fake" };
  decide?: (req: ChannelEvaluationRequest) => ChannelDecision;

  async evaluate(req: ChannelEvaluationRequest): Promise<ChannelDecision> {
    this.requests.push(structuredClone(req));
    return this.decide ? this.decide(req) : this.decision;
  }
}

class FakeBus {
  private listeners = new Set<(e: { turnId: string; event: ChannelTurnEvent }) => void>();

  subscribeAll(listener: (e: { turnId: string; event: ChannelTurnEvent }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(turnId: string, event: ChannelTurnEvent): void {
    for (const listener of [...this.listeners]) {
      listener({ turnId, event });
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}

interface SentMessage {
  sessionId: string;
  text: string;
  options: { autoPermission: boolean; principal: string };
}

class FakeSessions {
  summaries: ChannelSessionSummary[] = [];
  sent: SentMessage[] = [];
  stopped: Array<{ turnId: string; reason: string }> = [];
  answered: Array<{ turnId: string; toolCallId: string; answer: string }> = [];
  listCalls: string[] = [];
  onlyPrincipal?: string;
  created = 0;
  turnCounter = 0;
  /** Optional hook fired synchronously inside sendMessage (bus is already subscribed). */
  onSend?: (turnId: string) => void;
  /** Optional hook fired synchronously inside respondToAskHuman. */
  onAnswer?: (turnId: string) => void;

  // Deliberately UNscoped: returns every session regardless of principal, to
  // prove the bridge itself enforces per-principal scoping even when the
  // engine does not.
  listSessions(principal: string): ChannelSessionSummary[] {
    this.listCalls.push(principal);
    return this.onlyPrincipal === undefined || principal === this.onlyPrincipal ? this.summaries : [];
  }

  async createSession(): Promise<string> {
    this.created += 1;
    const sessionId = `sess-${this.created}`;
    this.summaries.push({
      sessionId,
      title: `Session ${this.created}`,
      updatedAt: new Date().toISOString(),
    });
    return sessionId;
  }

  async sendMessage(
    sessionId: string,
    text: string,
    options: { autoPermission: boolean; principal: string },
  ): Promise<{ turnId: string }> {
    this.turnCounter += 1;
    const turnId = `turn-${this.turnCounter}`;
    this.sent.push({ sessionId, text, options });
    const entry = this.summaries.find((s) => s.sessionId === sessionId);
    if (entry) {
      entry.latestTurnId = turnId;
      entry.latestTurnStatus = "running";
    }
    this.onSend?.(turnId);
    return { turnId };
  }

  async stopTurn(turnId: string, reason: string): Promise<void> {
    this.stopped.push({ turnId, reason });
    const entry = this.summaries.find((s) => s.latestTurnId === turnId);
    if (entry) entry.latestTurnStatus = "cancelled";
  }

  async respondToAskHuman(turnId: string, toolCallId: string, answer: string): Promise<void> {
    this.answered.push({ turnId, toolCallId, answer });
    this.onAnswer?.(turnId);
  }
}

function harness(overrides: Partial<ChannelBridgeConfig> = {}) {
  const evaluator = new FakeEvaluator();
  const sessions = new FakeSessions();
  const bus = new FakeBus();
  const replies: string[] = [];
  const bridge = new ChannelBridge({
    transportName: "telegram",
    evaluator,
    sessions,
    turnEvents: bus,
    ...overrides,
  });
  const reply = async (text: string) => {
    replies.push(text);
  };
  return { bridge, evaluator, sessions, bus, replies, reply };
}

test("read-only command is Kernel-evaluated before execution", async () => {
  const { bridge, evaluator, sessions, replies, reply } = harness();
  sessions.summaries.push({
    sessionId: "sess-x",
    title: "Quarterly audit",
    updatedAt: new Date().toISOString(),
  });

  await bridge.handleInbound("telegram:42", "list", reply);

  assert.equal(evaluator.requests.length, 1);
  const req = evaluator.requests[0];
  assert.equal(req.actionUrn, "channel.telegram.command.list");
  assert.equal(req.senderKey, "telegram:42");
  assert.equal(req.effectClass, "E0");
  assert.equal(req.metadata?.auto_permission, true);
  assert.equal(sessions.sent.length, 0);
  assert.ok(replies.some((r) => r.includes("Quarterly audit")));
});

test("resumed sessions retain the sender principal for every lookup", async () => {
  const { bridge, sessions, replies, reply } = harness();
  sessions.onlyPrincipal = "telegram:42";
  sessions.summaries.push({
    sessionId: "sess-1",
    title: "Private audit",
    updatedAt: new Date().toISOString(),
    latestTurnId: "turn-private",
    latestTurnStatus: "running",
  });

  await bridge.handleInbound("telegram:42", "resume 1", reply);
  await bridge.handleInbound("telegram:42", "status", reply);
  await bridge.handleInbound("telegram:42", "stop", reply);

  assert.ok(replies.some((r) => r.includes('Resumed "Private audit"')));
  assert.ok(replies.some((r) => r.includes('Current session: "Private audit"')));
  assert.deepEqual(sessions.stopped, [{ turnId: "turn-private", reason: "stopped from governed channel" }]);
  assert.ok(sessions.listCalls.every((principal) => principal === "telegram:42"));
});

test("a bridge-owned session is hidden from another sender even with an unscoped engine", async () => {
  const { bridge, sessions, bus, replies, reply } = harness();
  sessions.onSend = (turnId) => bus.emit(turnId, { type: "turn_completed", text: "done" });

  await bridge.handleInbound("telegram:42", "start private work", reply);
  replies.length = 0;
  await bridge.handleInbound("telegram:1337", "list", reply);
  await bridge.handleInbound("telegram:1337", "resume 1", reply);

  assert.equal(sessions.sent.length, 1);
  assert.ok(replies.some((r) => r.includes("No governed sessions yet")));
  assert.ok(replies.some((r) => r.includes("No session #1")));
});

test("new with a message evaluates the fresh session and embedded turn separately", async () => {
  const { bridge, evaluator, sessions, replies, reply } = harness();
  evaluator.decide = (request) =>
    request.actionUrn === "channel.telegram.turn.run"
      ? { verdict: "DENY", reason: "turns disabled" }
      : { verdict: "ALLOW" };

  await bridge.handleInbound("telegram:42", "new delete the audit", reply);

  assert.deepEqual(
    evaluator.requests.map((request) => request.actionUrn),
    ["channel.telegram.command.new", "channel.telegram.turn.run"],
  );
  assert.equal(sessions.created, 0);
  assert.equal(sessions.sent.length, 0);
  assert.ok(replies.some((r) => r.includes('HELM denied "chat"')));
});

test("a timeout keeps the sender busy without discarding the active session", async () => {
  const { bridge, sessions, bus, replies, reply } = harness({ turnTimeoutMs: 1 });

  await bridge.handleInbound("telegram:42", "first", reply);
  await bridge.handleInbound("telegram:42", "new second", reply);
  await bridge.handleInbound("telegram:42", "status", reply);

  assert.equal(sessions.sent.length, 1);
  assert.ok(replies.some((r) => r.includes('Current session: "Session 1"')));

  bus.emit("turn-1", { type: "turn_completed", text: "first complete" });
  await new Promise((resolve) => setImmediate(resolve));
  sessions.onSend = (turnId) => bus.emit(turnId, { type: "turn_completed", text: "second complete" });
  await bridge.handleInbound("telegram:42", "second", reply);

  assert.equal(sessions.sent.length, 2);
  assert.equal(sessions.sent[1].sessionId, "sess-1");
});

test("chat message becomes a Kernel-evaluated turn and dispatches on ALLOW", async () => {
  const { bridge, evaluator, sessions, bus, replies, reply } = harness();
  sessions.onSend = (turnId) => bus.emit(turnId, { type: "turn_completed", text: "All clear." });

  await bridge.handleInbound("telegram:42", "summarize the audit", reply);

  assert.equal(evaluator.requests.length, 1);
  const req = evaluator.requests[0];
  assert.equal(req.actionUrn, "channel.telegram.turn.run");
  assert.equal(req.effectClass, "E3");
  assert.equal(req.metadata?.auto_permission, false);

  assert.equal(sessions.sent.length, 1);
  assert.equal(sessions.sent[0].text, "summarize the audit");
  assert.equal(sessions.sent[0].options.autoPermission, false);
  assert.equal(sessions.sent[0].options.principal, "telegram:42");
  assert.ok(replies.includes("All clear."));
  // Watcher unsubscribes after the turn settles.
  assert.equal(bus.size, 0);
});

test("DENY verdict blocks dispatch and reports the receipt", async () => {
  const { bridge, evaluator, sessions, replies, reply } = harness();
  evaluator.decision = {
    verdict: "DENY",
    reason: "channel turns disabled by policy",
    reasonCode: "POLICY_DENY",
    receiptId: "rcpt-deny-1",
  };

  await bridge.handleInbound("telegram:42", "delete everything", reply);

  assert.equal(evaluator.requests.length, 1);
  assert.equal(sessions.sent.length, 0);
  assert.equal(sessions.created, 0);
  const denial = replies.find((r) => r.startsWith("⛔"));
  assert.ok(denial);
  assert.ok(denial.includes("channel turns disabled by policy"));
  assert.ok(denial.includes("rcpt-deny-1"));
});

test("non-ALLOW verdicts fail closed (ESCALATE, unknown verdict, evaluator outage)", async () => {
  const { bridge, evaluator, sessions, replies, reply } = harness();

  evaluator.decision = { verdict: "ESCALATE", reason: "needs operator approval" };
  await bridge.handleInbound("telegram:42", "run the payroll", reply);
  assert.equal(sessions.sent.length, 0);

  evaluator.decision = { verdict: "SOMETHING_UNEXPECTED" };
  await bridge.handleInbound("telegram:42", "status please", reply);
  assert.equal(sessions.sent.length, 0);

  evaluator.decision = {
    verdict: "DENY",
    reason: "HELM Kernel evaluation unavailable: connection refused",
    reasonCode: "CHANNEL_EVALUATOR_UNAVAILABLE",
  };
  await bridge.handleInbound("telegram:42", "list", reply);
  assert.equal(sessions.sent.length, 0);

  assert.equal(evaluator.requests.length, 3);
  assert.equal(replies.filter((r) => r.startsWith("⛔")).length, 3);
});

test("unknown slash-commands are denied without evaluation or dispatch", async () => {
  const { bridge, evaluator, sessions, replies, reply } = harness();

  await bridge.handleInbound("telegram:42", "/rm -rf /", reply);

  assert.equal(evaluator.requests.length, 0);
  assert.equal(sessions.sent.length, 0);
  const denial = replies.find((r) => r.startsWith("⛔"));
  assert.ok(denial);
  assert.ok(denial.includes("Unknown command"));
});

test("ask_human question is relayed and the answer round-trips through the Kernel", async () => {
  const { bridge, evaluator, sessions, bus, replies, reply } = harness();
  sessions.onSend = (turnId) =>
    bus.emit(turnId, {
      type: "turn_suspended",
      pendingAskHuman: {
        toolCallId: "call-99",
        question: "Deploy to production?",
        options: ["yes", "no"],
      },
      pendingPermissions: 0,
    });
  sessions.onAnswer = (turnId) =>
    bus.emit(turnId, { type: "turn_completed", text: "Deployed and receipted." });

  await bridge.handleInbound("telegram:42", "ship it", reply);
  assert.ok(replies.some((r) => r.includes("❓ Deploy to production?")));
  assert.ok(replies.some((r) => r.includes("1. yes")));

  replies.length = 0;
  await bridge.handleInbound("telegram:42", "yes", reply);

  // The answer was evaluated as its own governed command.
  const answerReq = evaluator.requests.find((r) =>
    r.actionUrn === "channel.telegram.ask_human.answer"
  );
  assert.ok(answerReq);
  assert.equal(answerReq.input.answer, "yes");
  assert.equal(answerReq.metadata?.auto_permission, false);

  assert.equal(sessions.answered.length, 1);
  assert.deepEqual(sessions.answered[0], {
    turnId: "turn-1",
    toolCallId: "call-99",
    answer: "yes",
  });
  assert.ok(replies.includes("Deployed and receipted."));
});

test("denied ask_human answer is never routed back into the turn", async () => {
  const { bridge, evaluator, sessions, bus, replies, reply } = harness();
  sessions.onSend = (turnId) =>
    bus.emit(turnId, {
      type: "turn_suspended",
      pendingAskHuman: { toolCallId: "call-1", question: "Proceed?" },
    });

  await bridge.handleInbound("telegram:42", "start", reply);
  assert.ok(replies.some((r) => r.includes("❓ Proceed?")));

  evaluator.decide = (req) =>
    req.actionUrn.endsWith("ask_human.answer")
      ? { verdict: "DENY", reason: "answers require MFA step-up", receiptId: "rcpt-mfa" }
      : { verdict: "ALLOW" };
  replies.length = 0;
  await bridge.handleInbound("telegram:42", "yes", reply);

  assert.equal(sessions.answered.length, 0);
  const denial = replies.find((r) => r.startsWith("⛔"));
  assert.ok(denial);
  assert.ok(denial.includes("rcpt-mfa"));
});

test("autoPermission is granted only to explicitly allowlisted commands", async () => {
  const { bridge, sessions, bus, reply } = harness();
  sessions.onSend = (turnId) => bus.emit(turnId, { type: "turn_completed", text: "ok" });

  // Defaults: routine read-only commands are allowlisted, chat is not.
  assert.equal(bridge.isAutoPermissionAllowed("help"), true);
  assert.equal(bridge.isAutoPermissionAllowed("list"), true);
  assert.equal(bridge.isAutoPermissionAllowed("status"), true);
  assert.equal(bridge.isAutoPermissionAllowed("chat"), false);
  assert.equal(bridge.isAutoPermissionAllowed("stop"), false);

  await bridge.handleInbound("telegram:42", "hello", reply);
  assert.equal(sessions.sent[0].options.autoPermission, false);

  // Operator explicitly allowlists chat turns (Rowboat-style); documented risk.
  const permissive = harness({ autoPermissionAllowlist: ["help", "list", "status", "chat"] });
  permissive.sessions.onSend = (turnId) =>
    permissive.bus.emit(turnId, { type: "turn_completed", text: "ok" });
  await permissive.bridge.handleInbound("telegram:42", "hello", permissive.reply);
  assert.equal(permissive.sessions.sent[0].options.autoPermission, true);
});

test("stop cancels the running turn only after Kernel ALLOW", async () => {
  const { bridge, evaluator, sessions, replies, reply } = harness();
  sessions.summaries.push({
    sessionId: "sess-1",
    title: "Long task",
    updatedAt: new Date().toISOString(),
    latestTurnId: "turn-77",
    latestTurnStatus: "running",
  });

  await bridge.handleInbound("telegram:42", "resume 1", reply);
  await bridge.handleInbound("telegram:42", "stop", reply);

  const stopReq = evaluator.requests.find((r) => r.actionUrn === "channel.telegram.command.stop");
  assert.ok(stopReq);
  assert.equal(stopReq.effectClass, "E2");
  assert.deepEqual(sessions.stopped, [{ turnId: "turn-77", reason: "stopped from governed channel" }]);
  assert.ok(replies.includes("🛑 Stop requested."));
});

test("denied stop never touches the engine", async () => {
  const { bridge, evaluator, sessions, reply } = harness();
  sessions.summaries.push({
    sessionId: "sess-1",
    title: "Long task",
    updatedAt: new Date().toISOString(),
    latestTurnId: "turn-77",
    latestTurnStatus: "running",
  });
  evaluator.decision = { verdict: "DENY", reason: "no remote stops" };

  await bridge.handleInbound("telegram:42", "resume 1", reply);
  await bridge.handleInbound("telegram:42", "stop", reply);

  assert.equal(sessions.stopped.length, 0);
});
