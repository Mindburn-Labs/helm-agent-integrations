import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { AcpSessionManager } from "./manager.js";
import { SessionStore } from "./session-store.js";
import { ToolCallTracker } from "./tool-calls.js";
import { reviewedLaunch } from "./session-safety.js";
import { GovernedPermissionBroker } from "./permission.js";
import { HelmKernelEvaluator, type KernelEvaluationRequest, type KernelEvaluator } from "./kernel-evaluator.js";
import type { AcpRunEvent, AcpMcpServer } from "./types.js";
import { cleanupTmpDir, fakeLaunchSpec, FakeKernelEvaluator, guardFor, makeTmpDir } from "./test-utils.js";

const mcp: AcpMcpServer[] = [{ name: "helm_browser", command: process.execPath, args: [], env: [] }];
const allow = { verdict: "ALLOW", decisionId: "kernel-decision", receiptId: "kernel-receipt" };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const exists = (file: string) => fs.stat(file).then(() => true, () => false);

function managerFor(cwd: string, behavior: Record<string, unknown>, evaluator: KernelEvaluator = new FakeKernelEvaluator()) {
  return new AcpSessionManager({ sessionStore: new SessionStore(path.join(cwd, "sessions")), fsGuard: guardFor(cwd), evaluator, mcpServers: mcp, launchSpecFor: () => fakeLaunchSpec(behavior), disposeGraceMs: 0, cancelGraceMs: 30 });
}
const prompt = (cwd: string, onEvent: (event: AcpRunEvent) => void = () => {}) => ({ runId: "run", agent: "codex" as const, cwd, prompt: "do the operation", policy: "ask" as const, onEvent });

for (const [name, behavior] of Object.entries({ "unsafe Auto review": { mode: "agent" }, "missing mode capability": { missingModes: true }, "missing config capability": { missingConfig: true }, "missing protocol capabilities": { missingCapabilities: true }, "mode changed during readback": { ignoreModeChange: true } })) {
  test(`${name} fails before the first prompt`, async () => {
    const cwd = await makeTmpDir();
    const trace = path.join(cwd, "prompt-trace");
    const manager = managerFor(cwd, { ...behavior, promptTrace: trace });
    try {
      await assert.rejects(manager.runPrompt(prompt(cwd)), /mode|capabilit|configuration/);
      assert.equal(await exists(trace), false);
    } finally { await manager.disposeAll(); await cleanupTmpDir(cwd); }
  });
}

test("declared MCP tools always prompt and Codex cannot select Auto review via launch overrides", () => {
  const launch = reviewedLaunch("codex", { command: "node", args: ["bridge"], env: { INITIAL_AGENT_MODE: "agent-full-access", CODEX_CONFIG: JSON.stringify({ model: "selected", model_reasoning_effort: "max", approvals_reviewer: "auto_review", mcp_servers: { inherited: { default_tools_approval_mode: "approve", tools: { click: { approval_mode: "approve" } } } } }) } }, mcp);
  const config = JSON.parse(launch.env!.CODEX_CONFIG!);
  assert.equal(launch.env!.INITIAL_AGENT_MODE, "workspace-write");
  assert.equal(config.approvals_reviewer, "user");
  assert.equal(config.sandbox_mode, "workspace-write");
  assert.equal(config.mcp_servers.inherited.enabled, false);
  assert.equal(config.mcp_servers.helm_browser.default_tools_approval_mode, "prompt");
  assert.deepEqual(config.mcp_servers.helm_browser.tools, {});
  assert.equal(config.model, "selected");
  assert.equal(config.model_reasoning_effort, "max");
});

test("sparse vendor permissions join concrete MCP arguments and retained results by toolCallId", async () => {
  const cwd = await makeTmpDir();
  const requests: KernelEvaluationRequest[] = [];
  const events: AcpRunEvent[] = [];
  const input = { server: "helm_browser", tool: "navigate_page", arguments: { url: "https://example.test/allowed" } };
  const manager = managerFor(cwd, { requestPermission: "execute", toolName: "mcp.helm_browser.navigate_page", rawInput: input, sparsePermission: true }, { evaluate: async request => { requests.push(request); return allow; } });
  try {
    const result = await manager.runPrompt(prompt(cwd, event => events.push(event)));
    assert.equal(result.stopReason, "end_turn");
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].ask.action, { server: "helm_browser", tool: "navigate_page", arguments: input.arguments, url: "https://example.test/allowed" });
    assert.deepEqual((requests[0].ask.toolInput as { rawInput: unknown }).rawInput, input);
    assert.ok(events.some(event => event.type === "tool_call_update" && !!event.rawOutput));
  } finally { await manager.disposeAll(); await cleanupTmpDir(cwd); }
});

for (const [name, behavior] of Object.entries({ "missing raw input": { sparsePermission: true, omitToolUpdate: true }, "mismatched raw input": { permissionInput: { command: "different-effect" } } })) {
  test(`${name} rejects before Kernel evaluation or effect`, async () => {
    const cwd = await makeTmpDir();
    const effectFile = path.join(cwd, "effect");
    let evaluated = false;
    const manager = managerFor(cwd, { requestPermission: "execute", effectFile, ...behavior }, { evaluate: async () => { evaluated = true; return allow; } });
    try {
      await manager.runPrompt(prompt(cwd));
      assert.equal(evaluated, false);
      assert.equal(await exists(effectFile), false);
    } finally { await manager.disposeAll(); await cleanupTmpDir(cwd); }
  });
}

test("a changed mode during a prompt cannot run the pending effect", async () => {
  const cwd = await makeTmpDir();
  const effectFile = path.join(cwd, "effect");
  const manager = managerFor(cwd, { requestPermission: "execute", changeModeDuringPrompt: true, effectFile });
  try { await assert.rejects(manager.runPrompt(prompt(cwd))); assert.equal(await exists(effectFile), false); }
  finally { await manager.disposeAll(); await cleanupTmpDir(cwd); }
});

test("browser clicks bind the last completed page result rather than a proposed navigation", () => {
  const tracker = new ToolCallTracker();
  const navigation = { toolCallId: "nav", title: "mcp.helm_browser.new_page", kind: "execute", rawInput: { server: "helm_browser", tool: "new_page", arguments: { url: "https://example.test/start" } } };
  tracker.observe({ ...navigation, status: "completed", rawOutput: { content: [{ type: "text", text: '## Pages\n2: Result (https://example.test/final) [selected]' }] } });
  const click = { toolCallId: "click", title: "mcp.helm_browser.click", kind: "execute", rawInput: { server: "helm_browser", tool: "click", arguments: { uid: "button-1" } } };
  const action = tracker.action(click);
  assert.equal(action.url, "https://example.test/final");
  assert.deepEqual(action.browserContext, { url: "https://example.test/final", sourceToolCallId: "nav" });
});

test("MCP sticky hints cannot skip a subsequent Kernel decision", async () => {
  let evaluated = 0;
  const broker = new GovernedPermissionBroker({ agent: "codex", cwd: "/tmp", policy: "ask", evaluator: { evaluate: async () => { evaluated++; return { ...allow, stickyAllow: true }; } } });
  const request = { sessionId: "s", toolCall: { toolCallId: "call", title: "mcp.example.read", kind: "read", rawInput: { server: "example", tool: "read", arguments: {} } }, options: [{ optionId: "once", kind: "allow_once" }, { optionId: "always", kind: "allow_always" }] };
  assert.deepEqual((await broker.resolve(request)).outcome, { outcome: "selected", optionId: "once" });
  assert.deepEqual((await broker.resolve(request)).outcome, { outcome: "selected", optionId: "once" });
  assert.equal(evaluated, 2);
});

test("Stop during startup terminates without prompting", async () => {
  const cwd = await makeTmpDir();
  const trace = path.join(cwd, "prompt-trace");
  const manager = managerFor(cwd, { delayInitMs: 10000, promptTrace: trace });
  try {
    const running = manager.runPrompt(prompt(cwd));
    await pause(50);
    const termination = await manager.stop("run");
    assert.deepEqual(termination, { adapterExited: true, descendantsExited: true, forced: false });
    assert.equal((await running).stopReason, "cancelled");
    assert.equal(await exists(trace), false);
  } finally { await manager.disposeAll(); await cleanupTmpDir(cwd); }
});

test("Stop aborts a pending evaluator and never accepts its late ALLOW", async () => {
  const cwd = await makeTmpDir();
  let evaluating!: () => void;
  const entered = new Promise<void>(resolve => { evaluating = resolve; });
  let aborted = false;
  const effectFile = path.join(cwd, "effect");
  const manager = managerFor(cwd, { requestPermission: "execute", effectFile, hangOnPrompt: true }, { evaluate: async (_request, signal) => {
    evaluating();
    signal!.addEventListener("abort", () => { aborted = true; }, { once: true });
    await pause(150);
    return allow;
  } });
  try {
    const running = manager.runPrompt(prompt(cwd));
    await entered;
    await manager.stop("run");
    assert.equal((await running).stopReason, "cancelled");
    await pause(175);
    assert.equal(aborted, true);
    assert.equal(await exists(effectFile), false);
  } finally { await manager.disposeAll(); await cleanupTmpDir(cwd); }
});

test("Stop escalates to SIGKILL for an adapter and child that ignore SIGTERM", async () => {
  const cwd = await makeTmpDir();
  const pidFile = path.join(cwd, "child.pid");
  const manager = managerFor(cwd, { hangOnPrompt: true, ignoreCancel: true, ignoreSigterm: true, spawnChild: true, childPidFile: pidFile });
  try {
    const running = manager.runPrompt(prompt(cwd));
    for (let i = 0; i < 100 && !await exists(pidFile); i++) await pause(10);
    assert.equal(await exists(pidFile), true);
    const termination = await manager.stop("run");
    assert.equal(termination.forced, true);
    assert.equal(termination.adapterExited, true);
    assert.equal(termination.descendantsExited, true);
    assert.equal((await running).stopReason, "cancelled");
  } finally { await manager.disposeAll(); await cleanupTmpDir(cwd); }
});

test("Kernel evaluation carries workspace binding and cancellation to HTTP", async () => {
  const controller = new AbortController();
  let headers: Record<string, string> | undefined;
  let fetchSignal: AbortSignal | undefined;
  const evaluator = new HelmKernelEvaluator({ apiKey: "fixture", tenantId: "tenant", principal: "principal", workspaceId: "workspace", fetch: async (_url, init) => {
    headers = init?.headers; fetchSignal = init?.signal;
    return { ok: true, status: 200, headers: { get: () => "receipt" }, json: async () => ({ verdict: "DENY", decision_id: "decision" }), text: async () => "" };
  } });
  await evaluator.evaluate({ ask: { title: "navigate", kind: "execute", isRead: false, sessionId: "s", toolInput: { rawInput: { url: "https://example.test" } }, action: { server: "browser", tool: "navigate", arguments: { url: "https://example.test" }, url: "https://example.test/" } }, tier: "standard", agent: "codex", cwd: "/tmp", policy: "ask" }, controller.signal);
  assert.equal(headers?.["X-Helm-Workspace-ID"], "workspace");
  assert.ok(fetchSignal);
});

test("Stop cancels configuration readback on a reused warm session", async () => {
  const cwd = await makeTmpDir();
  const configTrace = path.join(cwd, "configs");
  const promptTrace = path.join(cwd, "prompts");
  const manager = new AcpSessionManager({ sessionStore: new SessionStore(path.join(cwd, "sessions")), fsGuard: guardFor(cwd), evaluator: new FakeKernelEvaluator(), launchSpecFor: () => fakeLaunchSpec({ delayConfigAfter: 3, configTrace, promptTrace }), cancelGraceMs: 20 });
  try {
    await manager.runPrompt(prompt(cwd));
    const running = manager.runPrompt(prompt(cwd));
    for (let i = 0; i < 100; i++) {
      const trace = await fs.readFile(configTrace, "utf8").catch(() => "");
      if (trace.includes("3\n")) break;
      await pause(10);
    }
    const started = performance.now();
    const termination = await manager.stop("run");
    assert.equal((await running).stopReason, "cancelled");
    assert.equal(termination.adapterExited, true);
    assert.ok(performance.now() - started < 2000, "Stop must interrupt the new turn's configuration request");
    assert.equal(await fs.readFile(promptTrace, "utf8"), "prompt\n");
  } finally { await manager.disposeAll(); await cleanupTmpDir(cwd); }
});
