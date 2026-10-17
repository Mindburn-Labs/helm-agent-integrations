// Source-shaped, private trace parsing for the pinned T87/T98 client versions.
// This is a correlation aid. Only CP, Gateway and provider readbacks qualify a row.
import {createHash} from "node:crypto";

export const PINNED_CLIENT_VERSIONS = Object.freeze({
  "claude-code": "2.1.295",
  codex: "0.159.0-alpha.12.1",
  openclaw: "2026.9.6",
});

const MAX_TRACE_BYTES = 256 * 1024;
const string = value => typeof value === "string" && value.length > 0;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const check = (condition, message) => { if (!condition) throw new Error(`trace contract: ${message}`); };
const sha = value => createHash("sha256").update(value).digest("hex");

// Keep this byte-for-byte compatible with executors/core/src/observation.ts.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

export function hookRef(kind, value) {
  check(string(kind) && string(value), "a hook reference needs a kind and value");
  return `sha256:${sha(`helm.executor.hook.label.v1|${kind}|${value}`)}`;
}

function digest(input) { return `sha256:${sha(canonicalJson(input))}`; }
function bytes(value, name) {
  check(Buffer.isBuffer(value) && value.length <= MAX_TRACE_BYTES, `${name} must be a bounded raw Buffer`);
  return new TextDecoder("utf-8", {fatal: true}).decode(value);
}
function json(text, name) {
  try { return JSON.parse(text); } catch { throw new Error(`trace contract: invalid ${name} JSON`); }
}
function jsonl(text, name) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  check(lines.length > 0 && lines.every(line => line.trim() !== ""), `${name} is empty or has a blank line`);
  return lines.map((line, index) => {
    const value = json(line, `${name} line ${index + 1}`);
    check(object(value), `${name} line ${index + 1} is not an object`);
    return value;
  });
}
function tool(name, input, useId, origin, extras = {}) {
  check(string(name) && object(input), `${origin} needs a tool name and object arguments`);
  return {
    origin, name, name_ref: hookRef("tool", name),
    input_digest_candidate: digest(input),
    ...(string(useId) ? {use_id: useId, use_ref: hookRef("tool_use", useId)} : {}),
    ...extras,
  };
}

function claude(stdout) {
  const stream = jsonl(stdout, "Claude stream-json stdout");
  const calls = new Map();
  const results = new Map();
  let terminal;
  for (const event of stream) {
    if (event.type === "assistant") {
      check(object(event.message) && event.message.role === "assistant" && Array.isArray(event.message.content), "invalid Claude assistant event");
      for (const block of event.message.content) {
        if (block?.type !== "tool_use") continue;
        check(string(block.id) && !calls.has(block.id), "duplicate or missing Claude tool_use id");
        calls.set(block.id, tool(block.name, block.input, block.id, "claude.stream-json.tool_use", {
          parent_tool_use_id: event.parent_tool_use_id ?? null,
          // The private caller may inspect these bytes to verify the requested action.
          private_arguments: block.input,
        }));
      }
    } else if (event.type === "user" && object(event.message) && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (block?.type !== "tool_result") continue;
        check(string(block.tool_use_id) && !results.has(block.tool_use_id), "duplicate or missing Claude tool_result id");
        results.set(block.tool_use_id, {is_error: block.is_error === true});
      }
    } else if (event.type === "result") {
      check(!terminal, "multiple Claude result events");
      terminal = event;
    }
  }
  check(terminal && string(terminal.session_id), "missing Claude result or session id");
  for (const id of results.keys()) check(calls.has(id), "Claude result has no tool_use");
  const denials = new Set((terminal.permission_denials ?? []).map(item => item?.tool_use_id).filter(string));
  for (const id of denials) check(calls.has(id), "Claude permission denial has no tool_use");
  return {
    format: "claude.stream-json", session_id: terminal.session_id,
    terminal: {subtype: terminal.subtype ?? null, is_error: terminal.is_error === true},
    calls: [...calls.values()].map(call => ({...call,
      outcome: denials.has(call.use_id) ? "permission_denied" : results.has(call.use_id)
        ? results.get(call.use_id).is_error ? "tool_error" : "tool_result" : "unobserved_result"})),
    join: "tool_use.id may be compared to CP metadata.tool.use_ref; require matching input digest, name, episode and case window",
  };
}

function codex(stdout) {
  const stream = jsonl(stdout, "Codex exec JSONL stdout");
  const calls = new Map();
  let threadStarted = false, turnStarted = false, terminal;
  for (const event of stream) {
    if (event.type === "thread.started") {
      check(!threadStarted && string(event.thread_id), "duplicate or invalid Codex thread start");
      threadStarted = true;
    } else if (event.type === "turn.started") {
      check(!turnStarted, "duplicate Codex turn start");
      turnStarted = true;
    } else if (event.type === "turn.completed" || event.type === "turn.failed") {
      check(!terminal, "multiple Codex turn terminals");
      terminal = event.type;
    } else if (["item.started", "item.updated", "item.completed"].includes(event.type)) {
      const item = event.item;
      if (!object(item) || !["command_execution", "mcp_tool_call"].includes(item.type)) continue;
      check(string(item.id), "Codex tool item has no id");
      const prior = calls.get(item.id);
      check(!prior || prior.item_type === item.type, "Codex item id changed type");
      let next;
      if (item.type === "command_execution") {
        check(string(item.command), "Codex command item has no command");
        check(!prior || prior.private_command === item.command, "Codex command changed under one item id");
        next = {origin: "codex.exec.command_execution", item_type: item.type, item_id: item.id,
          private_command: item.command, command_sha256: sha(item.command),
          // The CLI item id is generated for JSONL and is not the hook tool_use_id.
          cp_use_ref: null, cp_input_digest: null};
      } else {
        check(string(item.server) && string(item.tool) && object(item.arguments), "Codex MCP item lacks server/tool/arguments");
        check(!prior || prior.server === item.server && prior.name === item.tool
          && prior.input_digest_candidate === digest(item.arguments), "Codex MCP arguments changed under one item id");
        next = {origin: "codex.exec.mcp_tool_call", item_type: item.type, item_id: item.id,
          ...tool(item.tool, item.arguments, undefined, "codex.exec.mcp_tool_call"), server: item.server,
          private_arguments: item.arguments, cp_use_ref: null};
      }
      next.status = item.status;
      next.seen_started = (prior?.seen_started ?? false) || event.type === "item.started";
      next.seen_completed = (prior?.seen_completed ?? false) || event.type === "item.completed";
      check(!prior?.seen_completed || event.type !== "item.completed", "duplicate Codex item completion");
      calls.set(item.id, next);
    }
  }
  check(threadStarted && turnStarted && terminal, "Codex JSONL lacks thread, turn or terminal event");
  return {format: "codex.exec-jsonl", terminal, calls: [...calls.values()],
    join: "item.id is not a hook use id; require a separately retained hook input ref or a unique CP name/input-digest match in the bound episode and case window"};
}

function openclaw(stdout, trajectory) {
  const envelope = json(stdout.trim(), "OpenClaw agent exec stdout");
  check(object(envelope) && typeof envelope.ok === "boolean" && ["ok", "error", "timeout"].includes(envelope.status)
    && envelope.ok === (envelope.status === "ok") && string(envelope.sessionId), "invalid OpenClaw agent exec envelope");
  const summary = envelope.toolSummary;
  if (summary !== undefined) check(object(summary) && Number.isSafeInteger(summary.calls) && summary.calls >= 0
    && Array.isArray(summary.tools) && summary.tools.every(string), "invalid OpenClaw toolSummary");
  const base = {format: "openclaw.agent-exec-json", session_id: envelope.sessionId,
    terminal: envelope.status, tool_summary: summary ? {calls: summary.calls, tools: summary.tools} : null,
    calls: [], tool_request_traced: false,
    join: "stdout is aggregate only; no per-call id or arguments are available"};
  if (trajectory === undefined) return base;
  check(object(trajectory) && object(trajectory.manifest) && Buffer.isBuffer(trajectory.events), "OpenClaw needs a trajectory manifest and raw events Buffer");
  const manifest = trajectory.manifest;
  check(manifest.traceSchema === "openclaw-trajectory" && manifest.schemaVersion === 1
    && manifest.sessionId === envelope.sessionId && manifest.traceId === envelope.sessionId
    && string(manifest.sessionKey) && manifest.sessionKey.endsWith(`:explicit:${envelope.sessionId}`),
    "OpenClaw trajectory identity differs from the exec envelope");
  check(manifest.warnings === undefined || Array.isArray(manifest.warnings) && manifest.warnings.length === 0,
    "OpenClaw trajectory export has parse warnings");
  const events = jsonl(bytes(trajectory.events, "OpenClaw trajectory events"), "OpenClaw trajectory events");
  check(manifest.eventCount === events.length, "OpenClaw trajectory count mismatch");
  const calls = new Map(), results = new Map();
  for (const event of events) {
    check(event.traceSchema === "openclaw-trajectory" && event.schemaVersion === 1
      && event.sessionId === envelope.sessionId && event.traceId === envelope.sessionId,
      "OpenClaw trajectory event identity mismatch");
    if (event.source === "transcript") check(event.sessionKey === manifest.sessionKey,
      "OpenClaw transcript event session key mismatch");
    if (event.type === "tool.call" && event.source === "transcript") {
      const item = event.data;
      check(object(item) && string(item.toolCallId) && !calls.has(item.toolCallId), "duplicate or invalid OpenClaw tool.call");
      check(string(event.ts) && Number.isFinite(Date.parse(event.ts)), "OpenClaw tool.call has no time");
      // Pinned exporter passes through typedBlock.arguments, which may be a JSON string.
      const input = typeof item.arguments === "string" ? json(item.arguments, "OpenClaw tool.call arguments") : item.arguments;
      calls.set(item.toolCallId, tool(item.name, input, item.toolCallId, "openclaw.trajectory.tool.call", {
        observed_at: event.ts, private_arguments: item.arguments,
        // Export redaction can alter arguments. Only an equal CP digest is a join.
        exported_arguments_may_be_redacted: true,
      }));
    } else if (event.type === "tool.result" && event.source === "transcript") {
      const item = event.data?.message;
      check(object(item) && item.role === "toolResult" && string(item.toolCallId) && !results.has(item.toolCallId),
        "duplicate or invalid OpenClaw tool.result");
      results.set(item.toolCallId, {is_error: item.isError === true, name: item.toolName});
    }
  }
  for (const [id, result] of results) check(calls.has(id) && result.name === calls.get(id).name,
    "OpenClaw tool.result has no matching tool.call");
  return {...base, format: "openclaw.trajectory-v1", tool_request_traced: calls.size > 0,
    trajectory_events_sha256: sha(trajectory.events),
    calls: [...calls.values()].map(call => ({...call,
      outcome: results.has(call.use_id) ? results.get(call.use_id).is_error ? "tool_error" : "tool_result" : "unobserved_result"})),
    join: "compare trajectory toolCallId/name refs and exported argument digest with CP observed-only row in the bound episode and case window; require native hook decision readback for DENY"};
}

/** Parse only the private, byte-pinned stdout/stderr for a single producer case. */
export function parseCaseTrace({client, version, stdout, stderr, trajectory}) {
  check(PINNED_CLIENT_VERSIONS[client] === version, "client version is not the reviewed pin");
  const out = bytes(stdout, "stdout"), err = bytes(stderr, "stderr");
  const parsed = client === "claude-code" ? claude(out) : client === "codex" ? codex(out) : openclaw(out, trajectory);
  return {...parsed, client, version, stdout_sha256: sha(stdout), stderr_sha256: sha(stderr), stderr_bytes: Buffer.byteLength(err)};
}
