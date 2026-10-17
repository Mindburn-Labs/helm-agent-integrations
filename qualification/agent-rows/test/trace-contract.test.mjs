import {test} from "node:test";
import assert from "node:assert/strict";
import {hookRef, parseCaseTrace} from "../trace-contract.mjs";

const raw = value => Buffer.from(JSON.stringify(value));
const lines = (...values) => Buffer.from(values.map(value => JSON.stringify(value)).join("\n") + "\n");
const stderr = Buffer.from("diagnostic text is not a tool event\n");

test("Claude stream tool_use id and original input yield CP candidate refs", () => {
  const input = {command: "git push origin HEAD:refs/heads/g0-probe", description: "probe"};
  const parsed = parseCaseTrace({client: "claude-code", version: "2.1.295", stderr,
    stdout: lines(
      {type: "system", subtype: "init", session_id: "claude-session"},
      {type: "assistant", parent_tool_use_id: "parent-call", message: {role: "assistant", content: [
        {type: "tool_use", id: "toolu_probe", name: "Bash", input}]}},
      {type: "user", message: {role: "user", content: [
        {type: "tool_result", tool_use_id: "toolu_probe", is_error: true, content: "Denied"}]}},
      {type: "result", subtype: "success", session_id: "claude-session", is_error: false,
        permission_denials: [{tool_use_id: "toolu_probe", tool_name: "Bash"}]},
    )});
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].outcome, "permission_denied");
  assert.equal(parsed.calls[0].use_ref, hookRef("tool_use", "toolu_probe"));
  assert.equal(parsed.calls[0].name_ref, hookRef("tool", "Bash"));
  assert.equal(parsed.calls[0].parent_tool_use_id, "parent-call");
  assert.deepEqual(parsed.calls[0].private_arguments, input);
  assert.match(parsed.calls[0].input_digest_candidate, /^sha256:[a-f0-9]{64}$/);
  assert.equal(parsed.stderr_bytes, stderr.length);
});

test("Codex JSONL item ids remain display ids and never become CP hook use refs", () => {
  const parsed = parseCaseTrace({client: "codex", version: "0.159.0-alpha.12.1", stderr,
    stdout: lines(
      {type: "thread.started", thread_id: "thread-1"}, {type: "turn.started"},
      {type: "item.started", item: {id: "item_1", type: "command_execution", command: "bash -lc 'git push origin HEAD'", aggregated_output: "", exit_code: null, status: "in_progress"}},
      {type: "item.completed", item: {id: "item_1", type: "command_execution", command: "bash -lc 'git push origin HEAD'", aggregated_output: "denied", exit_code: 1, status: "failed"}},
      {type: "item.started", item: {id: "item_2", type: "mcp_tool_call", server: "helm", tool: "github_branch_create_from_changes", arguments: {target: "fake", count: 1}, result: null, error: null, status: "in_progress"}},
      {type: "item.completed", item: {id: "item_2", type: "mcp_tool_call", server: "helm", tool: "github_branch_create_from_changes", arguments: {count: 1, target: "fake"}, result: {content: []}, error: null, status: "completed"}},
      {type: "turn.completed", usage: {input_tokens: 1, output_tokens: 1}},
    )});
  assert.equal(parsed.calls.length, 2);
  assert.equal(parsed.calls[0].cp_use_ref, null);
  assert.equal(parsed.calls[0].cp_input_digest, null);
  assert.equal(parsed.calls[0].status, "failed");
  assert.equal(parsed.calls[1].cp_use_ref, null);
  assert.equal(parsed.calls[1].name_ref, hookRef("tool", "github_branch_create_from_changes"));
  assert.equal(parsed.calls[1].seen_completed, true);
  assert.match(parsed.join, /separately retained hook input/);
});

test("OpenClaw agent exec stdout is aggregate even when toolSummary says a call happened", () => {
  const parsed = parseCaseTrace({client: "openclaw", version: "2026.9.6", stderr,
    stdout: raw({ok: true, status: "ok", final: "Done", payloads: [{text: "Done"}],
      toolSummary: {calls: 1, tools: ["github_branch_create_from_changes"], totalToolTimeMs: 4},
      sessionId: "openclaw-session", model: "stub", provider: "stub"})});
  assert.equal(parsed.tool_summary.calls, 1);
  assert.deepEqual(parsed.calls, []);
  assert.equal(parsed.tool_request_traced, false);
  assert.match(parsed.join, /no per-call id/);
});

test("OpenClaw trajectory tool.call and tool.result keep source call identity separate from aggregate stdout", () => {
  const stdout = raw({ok: true, status: "ok", final: "Blocked", payloads: [{text: "Blocked"}],
    toolSummary: {calls: 1, tools: ["native_duplicate"]}, sessionId: "session-1", model: "stub", provider: "stub"});
  const events = lines(
    {traceSchema: "openclaw-trajectory", schemaVersion: 1, traceId: "session-1", source: "transcript",
      type: "tool.call", ts: "2026-10-04T10:00:00.000Z", sessionId: "session-1",
      sessionKey: "agent:main:explicit:session-1",
      data: {toolCallId: "call-1", name: "native_duplicate", arguments: {target: "fake-excluded"}}},
    {traceSchema: "openclaw-trajectory", schemaVersion: 1, traceId: "session-1", source: "transcript",
      type: "tool.result", ts: "2026-10-04T10:00:00.010Z", sessionId: "session-1",
      sessionKey: "agent:main:explicit:session-1",
      data: {message: {role: "toolResult", toolCallId: "call-1", toolName: "native_duplicate", isError: true}}},
  );
  const manifest = {traceSchema: "openclaw-trajectory", schemaVersion: 1, traceId: "session-1", sessionId: "session-1",
    sessionKey: "agent:main:explicit:session-1", eventCount: 2};
  const parsed = parseCaseTrace({client: "openclaw", version: "2026.9.6", stdout, stderr,
    trajectory: {manifest, events}});
  assert.equal(parsed.tool_request_traced, true);
  assert.match(parsed.trajectory_events_sha256, /^[a-f0-9]{64}$/);
  assert.equal(parsed.calls[0].use_ref, hookRef("tool_use", "call-1"));
  assert.equal(parsed.calls[0].outcome, "tool_error");
  assert.equal(parsed.calls[0].exported_arguments_may_be_redacted, true);
  assert.match(parsed.join, /native hook decision readback/);
  assert.throws(() => parseCaseTrace({client: "openclaw", version: "2026.9.6", stdout, stderr,
    trajectory: {manifest: {...manifest, sessionId: "other"}, events}}), /identity differs/);
  assert.throws(() => parseCaseTrace({client: "openclaw", version: "2026.9.6", stdout, stderr,
    trajectory: {manifest: {...manifest, warnings: ["truncated transcript"]}, events}}), /parse warnings/);
  const encodedEvents = lines({traceSchema: "openclaw-trajectory", schemaVersion: 1, traceId: "session-1",
    source: "transcript", type: "tool.call", ts: "2026-10-04T10:00:00.000Z", sessionId: "session-1",
    sessionKey: "agent:main:explicit:session-1",
    data: {toolCallId: "call-1", name: "native_duplicate", arguments: '{"target":"fake-excluded"}'}});
  const encoded = parseCaseTrace({client: "openclaw", version: "2026.9.6", stdout, stderr,
    trajectory: {manifest: {...manifest, eventCount: 1}, events: encodedEvents}});
  assert.equal(encoded.calls[0].input_digest_candidate, parsed.calls[0].input_digest_candidate);
});

test("the parser rejects changed versions, malformed events and ambiguous call identities", () => {
  assert.throws(() => parseCaseTrace({client: "codex", version: "0.163.0-alpha.10.2",
    stdout: lines({type: "thread.started", thread_id: "x"}), stderr}), /not the reviewed pin/);
  assert.throws(() => parseCaseTrace({client: "claude-code", version: "2.1.295",
    stdout: lines({type: "assistant", message: {role: "assistant", content: [
      {type: "tool_use", id: "same", name: "Bash", input: {command: "a"}},
      {type: "tool_use", id: "same", name: "Bash", input: {command: "b"}}]}},
      {type: "result", session_id: "x"}), stderr}), /duplicate or missing Claude tool_use id/);
  assert.throws(() => parseCaseTrace({client: "openclaw", version: "2026.9.6",
    stdout: Buffer.from("startup warning\n{}"), stderr}), /invalid OpenClaw agent exec stdout JSON/);
});
