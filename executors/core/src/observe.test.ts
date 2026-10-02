import assert from "node:assert/strict";
import { test } from "node:test";
import { observe, type ObserveOutcome } from "./commands/observe.js";
import { statusReport } from "./commands/status.js";
import { stop } from "./commands/stop.js";
import { runCli } from "./main.js";
import { captureIo } from "./test-utils.js";
import { buildObservation, canonicalJson, idempotencyKey, inputDigest, summarize } from "./observation.js";
import type { Ctx } from "./ctx.js";
import { checkedOut, fakeSecrets, schemaValidator, world, type World } from "./test-utils.js";

const validObservation = schemaValidator("observation.schema.json");
const validInput = schemaValidator("observe-input.schema.json");

const claudePre = {
  session_id: "abc123",
  prompt_id: "550e8400-e29b-41d4-a716-446655440000",
  transcript_path: "/home/u/.claude/projects/x/t.jsonl",
  cwd: "/work/repo",
  permission_mode: "default",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git status --short", description: "status", timeout: 120000 },
  tool_use_id: "toolu_01ABC",
};
const claudePost = { ...claudePre, hook_event_name: "PostToolUse", tool_response: { stdout: "RESPONSE-MARKER-9a1", stderr: "", interrupted: false }, duration_ms: 12 };
const codexPre = {
  session_id: "thr_1",
  turn_id: "turn_1",
  transcript_path: null,
  cwd: "/work/repo",
  hook_event_name: "PreToolUse",
  model: "gpt-x",
  permission_mode: "default",
  tool_name: "Bash",
  tool_input: { command: "ls -la" },
  tool_use_id: "call_1",
};

async function post(ctx: Ctx, client: string, event: string | undefined, envelope: unknown): Promise<ObserveOutcome> {
  return observe(ctx, { client, event, input: typeof envelope === "string" ? envelope : JSON.stringify(envelope) });
}

const lastBody = (w: World): Record<string, unknown> => w.fake.observations.at(-1) as Record<string, unknown>;

test("the sample envelopes satisfy the stdin schema and the bodies posted satisfy the observation schema", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    const cases: [string, string, unknown][] = [
      ["claude-code", "PreToolUse", claudePre],
      ["claude-code", "PostToolUse", claudePost],
      ["claude-code", "PostToolUseFailure", { ...claudePost, hook_event_name: "PostToolUseFailure" }],
      ["claude-code", "SessionStart", { session_id: "abc123", hook_event_name: "SessionStart", source: "startup", cwd: "/work/repo" }],
      ["claude-code", "SessionEnd", { session_id: "abc123", hook_event_name: "SessionEnd", reason: "other" }],
      ["codex", "PreToolUse", codexPre],
      ["codex", "PostToolUse", { ...codexPre, hook_event_name: "PostToolUse", tool_response: { exit_code: 0 } }],
    ];
    for (const [client, event, envelope] of cases) {
      assert.equal(validInput(envelope), null, `${client} ${event} envelope`);
      assert.deepEqual(await post(ctx, client, event, envelope), { status: "posted" }, `${client} ${event}`);
      assert.equal(validObservation(lastBody(w)), null, `${client} ${event} body`);
    }
    assert.equal(w.fake.observations.length, cases.length);
  } finally {
    await w.close();
  }
});

test("the body is observed-only, takes the episode and work item from the slot, and the phase from the event", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    await post(ctx, "claude-code", "PreToolUse", { ...claudePre, episode_id: "forged", work_item_id: "forged" });
    const body = lastBody(w) as { coverage: string; client: string; event: string; episode_id: string; work_item_id: string; session_id: string; prompt_id: string; permission_mode: string; tool: Record<string, unknown> };
    assert.equal(body.coverage, "observed-only");
    assert.equal(body.client, "claude-code");
    assert.equal(body.event, "PreToolUse");
    assert.equal(body.episode_id, [...w.fake.episodes.values()][0]?.episodeId);
    assert.equal(body.work_item_id, "HELM-910");
    assert.equal(body.session_id, "abc123");
    assert.equal(body.prompt_id, claudePre.prompt_id);
    assert.equal(body.permission_mode, "default");
    assert.deepEqual(body.tool, { name: "Bash", use_id: "toolu_01ABC", phase: "before", input_digest: inputDigest(claudePre.tool_input), input_summary: "git status" });

    await post(ctx, "claude-code", "PostToolUse", claudePost);
    assert.equal((lastBody(w).tool as { phase: string; duration_ms: number }).phase, "after");
    assert.equal((lastBody(w).tool as { duration_ms: number }).duration_ms, 12);
    await post(ctx, "claude-code", "PostToolUseFailure", claudePost);
    assert.equal((lastBody(w).tool as { phase: string }).phase, "failed");
  } finally {
    await w.close();
  }
});

test("--event wins over hook_event_name, and hook_event_name is used when --event is absent", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    await post(ctx, "codex", "PostToolUse", { ...codexPre, hook_event_name: "PreToolUse" });
    assert.equal(lastBody(w).event, "PostToolUse");
    await post(ctx, "codex", undefined, codexPre);
    assert.equal(lastBody(w).event, "PreToolUse");
    assert.equal(lastBody(w).turn_id, "turn_1");
  } finally {
    await w.close();
  }
});

test("tool input and output never leave the machine; only a digest and the command's shape do", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    const command = `curl -H "Authorization: ${fakeSecrets.bearer}" https://x.example/${"a".repeat(400)}\nexport MY_TOKEN=hunter2hunter2 && echo ${fakeSecrets.openai}`;
    await post(ctx, "claude-code", "PostToolUse", { ...claudePost, tool_input: { command } });
    const text = JSON.stringify(lastBody(w));
    for (const leak of ["RESPONSE-MARKER-9a1", fakeSecrets.bearer, fakeSecrets.openai, "hunter2hunter2", "x.example", "/home/u/.claude", "/work/repo"]) {
      assert.ok(!text.includes(leak), `leaked ${leak.slice(0, 12)}`);
    }
    const tool = lastBody(w).tool as { input_summary: string; input_digest: string };
    assert.equal(tool.input_summary, "curl; export; echo");
    assert.equal(tool.input_digest, inputDigest({ command }));
  } finally {
    await w.close();
  }
});

test("a long command's shape is cut at 256 characters on one line", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    const command = Array.from({ length: 80 }, (_, i) => `tool${i} --flag value`).join(" &&\n");
    await post(ctx, "claude-code", "PreToolUse", { ...claudePre, tool_input: { command } });
    const summary = (lastBody(w).tool as { input_summary: string }).input_summary;
    assert.equal(summary.length, 256);
    assert.ok(summary.endsWith("…"));
    assert.ok(summary.startsWith("tool0; tool1; tool2"));
    assert.ok(!summary.includes("\n"));
  } finally {
    await w.close();
  }
});

test("HELM_EXECUTOR_OBSERVE_SUMMARY=off drops the summary and keeps the digest", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    const off = w.ctx({ env: { HELM_EXECUTOR_OBSERVE_SUMMARY: "off" } });
    assert.equal(off.home, ctx.home);
    await post(off, "claude-code", "PreToolUse", claudePre);
    const tool = lastBody(w).tool as Record<string, unknown>;
    assert.equal("input_summary" in tool, false);
    assert.equal(tool.input_digest, inputDigest(claudePre.tool_input));
  } finally {
    await w.close();
  }
});

test("summaries: file tools give the path relative to the working directory, apply_patch lists its files, other tools none", () => {
  assert.equal(summarize("Edit", { file_path: "/work/repo/src/a.ts" }, "/work/repo"), "src/a.ts");
  assert.equal(summarize("Write", { file_path: "/etc/hosts" }, "/work/repo"), "/etc/hosts");
  assert.equal(summarize("NotebookEdit", { notebook_path: "/work/repo/n.ipynb" }, "/work/repo/"), "n.ipynb");
  assert.equal(summarize("apply_patch", { input: "*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** Add File: b/c.ts\n+z\n*** End Patch" }, "/w"), "a.ts, b/c.ts");
  assert.equal(summarize("apply_patch", "*** Begin Patch\n*** Delete File: gone.ts\n*** End Patch", "/w"), "gone.ts");
  for (const name of ["Grep", "Glob", "WebFetch", "mcp__helm__github_repository_get", "Agent"]) assert.equal(summarize(name, { command: "x", file_path: "y", pattern: "z" }, "/w"), undefined);
  assert.equal(summarize("Bash", { command: "   " }, "/w"), undefined);
});

test("digests are over key-sorted JSON, so key order does not matter", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: undefined }], c: null } }), '{"a":{"c":null,"d":[1,{"z":1}]},"b":1}');
  assert.equal(inputDigest({ a: 1, b: 2 }), inputDigest({ b: 2, a: 1 }));
  assert.notEqual(inputDigest({ a: 1 }), inputDigest({ a: 2 }));
  assert.match(inputDigest(undefined), /^sha256:[0-9a-f]{64}$/);
});

test("MCP tools: the server comes from the envelope when present, else from the tool name", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    await post(ctx, "claude-code", "PreToolUse", { ...claudePre, tool_name: "mcp__helm__github_pull_request_create_draft", tool_input: { target: "x", arguments: {} }, mcp_server: { name: "helm-from-envelope", source: "managed" } });
    assert.equal((lastBody(w).tool as { mcp_server: string }).mcp_server, "helm-from-envelope");
    await post(ctx, "codex", "PreToolUse", { ...codexPre, tool_name: "mcp__helm__helm_attempt_get", tool_input: {} });
    assert.equal((lastBody(w).tool as { mcp_server: string }).mcp_server, "helm");
    assert.equal((lastBody(w).tool as { input_summary?: string }).input_summary, undefined);
    await post(ctx, "codex", "PreToolUse", codexPre);
    assert.equal("mcp_server" in (lastBody(w).tool as object), false);
  } finally {
    await w.close();
  }
});

test("subagent fields are passed through", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    await post(ctx, "claude-code", "PreToolUse", { ...claudePre, agent_id: "agent-7", agent_type: "Explore" });
    assert.equal(lastBody(w).agent_id, "agent-7");
    assert.equal(lastBody(w).agent_type, "Explore");
  } finally {
    await w.close();
  }
});

test("the idempotency key is deterministic per episode, event and tool call, and absent without a tool call id", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    const episodeId = [...w.fake.episodes.values()][0]!.episodeId;
    await post(ctx, "claude-code", "PreToolUse", claudePre);
    await post(ctx, "claude-code", "PostToolUse", claudePost);
    await post(ctx, "claude-code", "SessionEnd", { session_id: "abc123", hook_event_name: "SessionEnd" });
    const observed = w.fake.requests.filter((r) => r.path.endsWith("/observations"));
    assert.equal(observed[0]?.headers["idempotency-key"], idempotencyKey(episodeId, "PreToolUse", "toolu_01ABC"));
    assert.match(String(observed[0]?.headers["idempotency-key"]), /^obs-[0-9a-f]{32}$/);
    assert.notEqual(observed[0]?.headers["idempotency-key"], observed[1]?.headers["idempotency-key"]);
    assert.equal(observed[2]?.headers["idempotency-key"], undefined);
    assert.equal(observed[0]?.headers.authorization?.toString().startsWith("Bearer helm_at_"), true, "the machine credential, not the episode token");
  } finally {
    await w.close();
  }
});

test("nothing is posted without a live episode", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    const other = w.ctx({ slot: "empty" });
    assert.deepEqual(await post(other, "claude-code", "PreToolUse", claudePre), { status: "skipped", reason: "no episode is checked out" });
    w.clock.advance(3_600_000 + 1);
    assert.equal((await post(ctx, "claude-code", "PreToolUse", claudePre)).status, "skipped");
    assert.equal(w.fake.observations.length, 0);
    assert.equal(w.fake.requests.filter((r) => r.path.endsWith("/observations")).length, 0);
  } finally {
    await w.close();
  }
});

test("bad input is a failed outcome that is recorded, never a throw", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    const failed = async (o: Promise<ObserveOutcome>, pattern: RegExp): Promise<void> => {
      const r = await o;
      assert.equal(r.status, "failed");
      assert.match(r.status === "failed" ? r.line : "", pattern);
    };
    await failed(post(ctx, "claude-code", "PreToolUse", "not json"), /^helm-executor: rejected: hook input is not valid JSON\n$/);
    await failed(observe(ctx, { client: "claude-code", event: "PreToolUse", input: null }), /larger than 8 MiB/);
    await failed(post(ctx, "claude-code", "Stop", claudePre), /unsupported hook event "Stop"/);
    await failed(post(ctx, "claude-code", "PreToolUse", { tool_name: "Bash" }), /no session_id/);
    await failed(post(ctx, "claude-code", "PreToolUse", { session_id: "s" }), /no tool_name/);
    await failed(post(ctx, "claude-code", "PreToolUse", [1, 2]), /not a JSON object/);
    assert.equal((await post(ctx, "vim", "PreToolUse", claudePre)).status, "failed");
    assert.equal(w.fake.observations.length, 0);
    assert.equal(statusReport(ctx).observe.last_error !== null, true);
  } finally {
    await w.close();
  }
});

test("a control plane that is down or rejects is a failed outcome, is not retried, and shows in status", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    w.fake.fail("/observations", 503, 1);
    const down = await post(ctx, "claude-code", "PreToolUse", claudePre);
    assert.equal(down.status, "failed");
    w.fake.fail("/observations", 429, 1, { retryAfter: 30 });
    assert.equal((await post(ctx, "claude-code", "PreToolUse", claudePre)).status, "failed");
    w.fake.fail("/observations", 400, 1, { error: "invalid_observation" });
    assert.equal((await post(ctx, "claude-code", "PreToolUse", claudePre)).status, "failed");
    assert.equal(w.fake.requests.filter((r) => r.path.endsWith("/observations")).length, 3, "one attempt each");
    const report = statusReport(ctx);
    assert.match(report.observe.last_error ?? "", /invalid_observation/);
    assert.ok(report.observe.last_error_at);

    assert.equal((await post(ctx, "claude-code", "PreToolUse", claudePre)).status, "posted");
    const after = statusReport(ctx);
    assert.ok(after.observe.last_ok_at);
    assert.ok(after.observe.last_ok_at >= (after.observe.last_error_at ?? ""));
  } finally {
    await w.close();
  }
});

test("a stopped episode makes the control plane refuse the post; the outcome is failed and the slot is untouched", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    [...w.fake.episodes.values()][0]!.stopped = true;
    assert.equal((await post(ctx, "claude-code", "PreToolUse", claudePre)).status, "failed");
    await stop(ctx, { local: true });
  } finally {
    await w.close();
  }
});

test("buildObservation clips long identifiers to the schema limits", () => {
  const slot = { slot: "default", client: "claude-code", org_id: "o", workspace_id: "w", work_item_id: "W".repeat(300), episode_id: "E".repeat(300), deadline: "2026-10-08T13:00:00.000Z", checked_out_at: "2026-10-08T12:00:00.000Z" };
  const observation = buildObservation({ client: "claude-code", event: "PreToolUse", envelope: { ...claudePre, session_id: "S".repeat(400), tool_name: "T".repeat(400), tool_use_id: "U".repeat(400) }, slot, now: new Date("2026-10-08T12:00:00.000Z"), summary: true });
  assert.equal(validObservation(observation), null);
  assert.equal(observation.session_id.length, 256);
  assert.equal(observation.work_item_id.length, 128);
});

test("only a 202 is delivery: another 2xx, such as a proxy's page, is a dropped observation", async () => {
  const WS = "11111111-1111-4111-8111-111111111111";
  const ORG = "22222222-2222-4222-8222-222222222222";
  const w = await world({
    workspaceId: WS,
    orgId: ORG,
    routes: {
      [`POST /api/v1/workspaces/${WS}/organizations/${ORG}/observations`]: ({ res }) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html>sign in to the network</html>");
      },
    },
  });
  try {
    const ctx = await checkedOut(w);
    const outcome = await post(ctx, "claude-code", "PreToolUse", claudePre);
    assert.ok(outcome.status === "failed" && /HTTP 200, not the 202/.test(outcome.line), JSON.stringify(outcome));
    const status = statusReport(ctx);
    assert.equal(status.observe.last_ok_at, null, "it did not count as delivered");
    assert.match(status.observe.last_error ?? "", /not the 202/);
  } finally {
    await w.close();
  }
});

test("a misconfigured hook is counted where status shows it: a misspelled client, an unknown flag, a missing value", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    const run = async (args: string[]): Promise<{ code: number; err: string }> => {
      const cap = captureIo(JSON.stringify(claudePre));
      const code = await runCli(args, w.env(), cap.io, { now: w.clock.now, sleep: w.clock.sleep, home: w.home });
      return { code, err: cap.err() };
    };
    for (const [args, pattern] of [
      [["observe", "--client", "claud-code", "--event", "PreToolUse"], /--client must be one of/],
      [["observe", "--client", "claude-code", "--event", "PreToolUse", "--bogus"], /usage: /],
      [["observe", "--client"], /usage: /],
    ] as [string[], RegExp][]) {
      const before = statusReport(ctx).observe;
      const r = await run(args);
      assert.equal(r.code, 0, args.join(" "));
      assert.match(r.err, pattern);
      const after = statusReport(ctx).observe;
      assert.ok(after.last_error_at !== null && after.last_error?.includes("usage"), `${args.join(" ")} left no trace`);
      assert.notDeepEqual(after, before);
    }
    assert.equal(w.fake.observations.length, 0, "none of them posted anything");
  } finally {
    await w.close();
  }
});
