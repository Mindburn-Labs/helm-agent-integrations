import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { cleanupTmpDir, FAKE_AGENT_FIXTURE, makeTmpDir } from "./test-utils.js";

const bridgeFile = fileURLToPath(new URL("./bridge.js", import.meta.url));
type Message = Record<string, any>;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function startBridge() {
  const child = spawn(process.execPath, [bridgeFile], { stdio: ["pipe", "pipe", "pipe"] });
  const messages: Message[] = [];
  let stderr = "";
  child.stderr.on("data", data => { stderr += String(data); });
  createInterface({ input: child.stdout }).on("line", line => messages.push(JSON.parse(line)));
  const exit = new Promise<number | null>(resolve => child.once("exit", resolve));
  const send = (message: Message) => child.stdin.write(JSON.stringify(message) + "\n");
  async function wait(predicate: (message: Message) => boolean): Promise<Message> {
    for (let i = 0; i < 500; i++) {
      const message = messages.find(predicate);
      if (message) return message;
      if (child.exitCode !== null) throw new Error(`bridge exited ${child.exitCode}: ${stderr}`);
      await pause(10);
    }
    throw new Error(`bridge response timeout: ${stderr}; ${JSON.stringify(messages).slice(-3000)}`);
  }
  return { child, messages, send, wait, async close() { child.stdin.end(); await exit; } };
}

function config(cwd: string, behavior: Message = {}) {
  return {
    runId: "episode", agent: "codex", cwd, prompt: "perform the action", policy: "ask", evaluator: "host", model: "selected-model", effort: "max",
    launch: { adapterEntry: FAKE_AGENT_FIXTURE, extraEnv: { FAKE_AGENT_BEHAVIOR: JSON.stringify(behavior) } },
    fsRoots: [{ path: cwd, read: true, write: false }], hostTimeoutMs: 5000, cancelGraceMs: 20,
    mcpServers: [{ name: "helm_browser", command: process.execPath, args: [], env: [] }],
  };
}

const behavior = { requestPermission: "execute", sparsePermission: true, toolName: "mcp.helm_browser.navigate_page", rawInput: { server: "helm_browser", tool: "navigate_page", arguments: { url: "https://example.test/forbidden" } } };

test("stdio bridge binds a real session before prompt and routes concrete policy asks through host", async () => {
  const cwd = await makeTmpDir();
  const bridge = startBridge();
  const trace = path.join(cwd, "prompt");
  try {
    bridge.send({ id: "run", method: "run", params: config(cwd, { ...behavior, promptTrace: trace }) });
    const session = await bridge.wait(message => message.type === "session");
    assert.match(session.sessionId, /^fake-session-pid\d+$/);
    assert.equal(await fs.stat(trace).then(() => true, () => false), false);
    bridge.send({ id: "wrong", method: "session_bound", params: { sessionId: "synthetic" } });
    assert.ok((await bridge.wait(message => message.id === "wrong")).error);
    bridge.send({ id: "bind", method: "session_bound", params: { sessionId: session.sessionId } });
    const permission = await bridge.wait(message => message.type === "permission");
    assert.deepEqual(permission.request.action, { server: "helm_browser", tool: "navigate_page", arguments: behavior.rawInput.arguments, url: "https://example.test/forbidden" });
    bridge.send({ id: "deny", method: "permission_result", params: { permissionId: permission.id, decision: { verdict: "DENY", decisionId: "real-kernel-deny", receiptId: "real-kernel-receipt" } } });
    const result = await bridge.wait(message => message.id === "run");
    assert.equal(result.result.stopReason, "end_turn");
    assert.equal(result.result.termination.adapterExited, true);
    assert.equal(result.result.termination.descendantsExited, true);
    assert.ok(bridge.messages.some(message => message.type === "event" && message.event.type === "tool_call_update" && message.event.rawOutput));
    bridge.send({ id: "late", method: "permission_result", params: { permissionId: permission.id, decision: { verdict: "ALLOW", decisionId: "d", receiptId: "r" } } });
    assert.ok((await bridge.wait(message => message.id === "late")).error);
  } finally { await bridge.close(); await cleanupTmpDir(cwd); }
});

test("stdio bridge rejects host ALLOW with no receipt and performs no effect", async () => {
  const cwd = await makeTmpDir();
  const bridge = startBridge();
  const effectFile = path.join(cwd, "effect");
  try {
    bridge.send({ id: "run", method: "run", params: config(cwd, { ...behavior, effectFile }) });
    const session = await bridge.wait(message => message.type === "session");
    bridge.send({ id: "bind", method: "session_bound", params: { sessionId: session.sessionId } });
    const permission = await bridge.wait(message => message.type === "permission");
    bridge.send({ id: "invalid", method: "permission_result", params: { permissionId: permission.id, decision: { verdict: "ALLOW" } } });
    assert.ok((await bridge.wait(message => message.id === "invalid")).error);
    assert.ok((await bridge.wait(message => message.id === "run")).result);
    assert.equal(await fs.stat(effectFile).then(() => true, () => false), false);
  } finally { await bridge.close(); await cleanupTmpDir(cwd); }
});

test("stdio Stop before session acknowledgement never sends a prompt", async () => {
  const cwd = await makeTmpDir();
  const bridge = startBridge();
  const trace = path.join(cwd, "prompt");
  try {
    bridge.send({ id: "run", method: "run", params: config(cwd, { promptTrace: trace }) });
    await bridge.wait(message => message.type === "session");
    bridge.send({ id: "stop", method: "stop", params: { runId: "episode" } });
    const result = await bridge.wait(message => message.id === "run");
    const stop = await bridge.wait(message => message.id === "stop");
    assert.equal(result.result.stopReason, "cancelled");
    assert.equal(stop.result.termination.descendantsExited, true);
    assert.equal(await fs.stat(trace).then(() => true, () => false), false);
  } finally { await bridge.close(); await cleanupTmpDir(cwd); }
});
