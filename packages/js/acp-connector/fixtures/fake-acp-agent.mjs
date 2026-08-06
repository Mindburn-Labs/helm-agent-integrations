#!/usr/bin/env node
/**
 * Fake ACP agent for connector tests. Speaks ndJSON JSON-RPC over stdio.
 * Behavior is driven by FAKE_AGENT_BEHAVIOR (JSON env var):
 *   delayInitMs     — delay the initialize response (startup-deadline tests)
 *   loadSupported   — advertise agentCapabilities.loadSession
 *   requestPermission — on prompt, ask session/request_permission {kind}
 *   readFilePath    — on prompt, issue fs/read_text_file for this path
 *   writeFilePath   — on prompt, issue fs/write_text_file for this path
 *   hangOnPrompt    — never finish the prompt until session/cancel
 *   ignoreCancel    — never respond to the pending prompt even after cancel
 *   sessionId       — fixed session id (default "fake-session-1")
 *   forgeSession    — inbound fs/permission requests quote a session id the
 *                     connector never issued (session-binding tests)
 */
"use strict";

const behavior = JSON.parse(process.env.FAKE_AGENT_BEHAVIOR || "{}");
// pid is embedded so tests can tell a reused warm adapter from a fresh spawn.
const sessionId = (behavior.sessionId || "fake-session") + "-pid" + process.pid;
const inboundSessionId = behavior.forgeSession ? `forged-${sessionId}` : sessionId;
let nextId = 1;
let buffer = "";
const pending = new Map();
let pendingPromptId = null;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function respond(id, result) {
  send({ jsonrpc: "2.0", id, result: result ?? {} });
}
function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}
function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

async function handlePrompt(id, params) {
  try {
    if (behavior.readFilePath) {
      let note;
      try {
        const res = await request("fs/read_text_file", { sessionId: inboundSessionId, path: behavior.readFilePath });
        note = `read-ok:${res.content}`;
      } catch (err) {
        note = `read-denied:${err.message}`;
      }
      notify("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: note } },
      });
    }
    if (behavior.writeFilePath) {
      let note;
      try {
        await request("fs/write_text_file", { sessionId: inboundSessionId, path: behavior.writeFilePath, content: "engine-wrote-this" });
        note = "write-ok";
      } catch (err) {
        note = `write-denied:${err.message}`;
      }
      notify("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: note } },
      });
    }
    if (behavior.requestPermission) {
      const res = await request("session/request_permission", {
        sessionId: inboundSessionId,
        toolCall: { toolCallId: "tc-1", title: `${behavior.requestPermission} something`, kind: behavior.requestPermission },
        options: [
          { optionId: "opt-allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "opt-allow-always", name: "Always allow", kind: "allow_always" },
          { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
        ],
      });
      const outcome = res.outcome;
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `permission:${outcome.outcome}:${outcome.optionId ?? ""}` },
        },
      });
    }
    if (behavior.hangOnPrompt) {
      pendingPromptId = id; // finished only by session/cancel (or never, if ignoreCancel)
      return;
    }
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "turn-complete" } },
    });
    respond(id, { stopReason: "end_turn" });
  } catch (err) {
    respondError(id, -32603, err.message);
  }
}

function handleMessage(msg) {
  if (msg.id !== undefined && msg.id !== null && msg.method === undefined) {
    // response to one of our requests
    const entry = pending.get(msg.id);
    if (entry) {
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    }
    return;
  }
  switch (msg.method) {
    case "initialize": {
      const doRespond = () =>
        respond(msg.id, {
          protocolVersion: 1,
          agentInfo: { name: "fake-agent", version: "0.0.1" },
          agentCapabilities: { loadSession: behavior.loadSupported === true },
          authMethods: [],
        });
      if (behavior.delayInitMs) setTimeout(doRespond, behavior.delayInitMs);
      else doRespond();
      return;
    }
    case "session/new":
      respond(msg.id, { sessionId, configOptions: [], models: { availableModels: [] } });
      return;
    case "session/load":
      if (behavior.loadSupported) respond(msg.id, {});
      else respondError(msg.id, -32601, "session/load not supported");
      return;
    case "session/prompt":
      void handlePrompt(msg.id, msg.params || {});
      return;
    case "session/cancel":
      if (pendingPromptId !== null && !behavior.ignoreCancel) {
        const id = pendingPromptId;
        pendingPromptId = null;
        respond(id, { stopReason: "cancelled" });
      }
      return;
    case "session/set_config_option":
      respond(msg.id, { configOptions: [] });
      return;
    default:
      if (msg.id !== undefined && msg.id !== null) respondError(msg.id, -32601, `unknown method ${msg.method}`);
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const nl = buffer.indexOf("\n");
    if (nl < 0) return;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch {
      /* ignore malformed input */
    }
  }
});

process.stderr.write("fake-acp-agent ready\n");
