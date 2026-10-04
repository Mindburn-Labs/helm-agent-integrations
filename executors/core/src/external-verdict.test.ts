import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MAX_INPUT_BYTES } from "./commands/observe.js";
import { EXTERNAL_VERDICT_DECISIONS, observe, type ExternalVerdict } from "./index.js";
import { inputDigest } from "./observation.js";
import { runCli } from "./main.js";
import { captureIo, checkedOut, fakeSecrets, schemaValidator, world } from "./test-utils.js";

const validInput = schemaValidator("observe-input.schema.json");
const validObservation = schemaValidator("observation.schema.json");
const verdict = (decision: ExternalVerdict["decision"] = "DENY"): ExternalVerdict => ({
  source: "openclaw.helm.before_tool_call", decision, tool: "github_pull_request_create", observed_at: "2026-10-04T10:00:00.123Z",
});
const envelope = (external_verdict: unknown = verdict()) => ({
  session_id: "openclaw-session", hook_event_name: "PreToolUse", tool_name: "github_pull_request_create", tool_use_id: "openclaw-call",
  tool_input: { body: "RAW-P7-ARGUMENT-MARKER" }, tool_response: { result: "RAW-P7-RESULT-MARKER", decision: "ALLOW" },
  episode_id: "forged", work_item_id: "forged", coverage: "enforced", external_verdict,
});

test("OpenClaw posts the exact external policy report as observed-only without admitting an effect", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w, "HELM-910", "openclaw");
    const before = w.fake.requests.length;
    for (const decision of EXTERNAL_VERDICT_DECISIONS) {
      const raw = { ...envelope(verdict(decision)), tool_use_id: `call-${decision}` };
      assert.equal(validInput(raw), null);
      assert.deepEqual(await observe(ctx, { client: "openclaw", event: "PreToolUse", input: JSON.stringify(raw) }), { status: "posted" });
      const body = w.fake.observations.at(-1) as Record<string, unknown>;
      assert.equal(validObservation(body), null);
      assert.equal(body.client, "openclaw");
      assert.equal(body.coverage, "observed-only");
      assert.equal(body.episode_id, [...w.fake.episodes.values()][0]?.episodeId);
      assert.equal(body.work_item_id, "HELM-910");
      assert.equal(body.observed_at, new Date(w.clock.now()).toISOString());
      assert.deepEqual(body.external_verdict, verdict(decision));
      assert.equal((body.tool as Record<string, unknown>).input_digest, inputDigest(raw.tool_input));
      const text = JSON.stringify(body);
      for (const omitted of ["RAW-P7-ARGUMENT-MARKER", "RAW-P7-RESULT-MARKER", "forged", "enforced", "tool_response"]) assert.ok(!text.includes(omitted));
    }
    assert.equal(w.fake.requests.slice(before).length, 3);
    assert.ok(w.fake.requests.slice(before).every((r) => r.method === "POST" && r.path.endsWith("/observations")));
  } finally { await w.close(); }
});

test("absent metadata remains optional and tool results never create a verdict", async () => {
  for (const client of ["claude-code", "codex", "openclaw"]) {
    const w = await world();
    try {
      const ctx = await checkedOut(w, `work-${client}`, client);
      const raw = { session_id: "s", tool_name: "read", tool_input: { path: "README.md" }, tool_response: { decision: "DENY", external_verdict: verdict() } };
      assert.deepEqual(await observe(ctx, { client, event: "PostToolUse", input: JSON.stringify(raw) }), { status: "posted" });
      const body = w.fake.observations.at(-1) as Record<string, unknown>;
      assert.equal(validObservation(body), null);
      assert.equal(body.external_verdict, undefined);
      assert.equal((body.tool as Record<string, unknown>).phase, "after");
    } finally { await w.close(); }
  }
});

test("malformed explicit metadata rejects the entire report before transport", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w, "HELM-910", "openclaw");
    const invalid: unknown[] = [null, [], {}, { ...verdict(), decision: "allow" }, { ...verdict(), decision: "PASS" },
      { ...verdict(), source: "" }, { ...verdict(), source: "s".repeat(129) }, { ...verdict(), tool: "" },
      { ...verdict(), tool: "t".repeat(257) }, { ...verdict(), tool: false }, { ...verdict(), observed_at: "yesterday" },
      { ...verdict(), observed_at: "2026-02-29T10:00:00Z" }, { ...verdict(), observed_at: "2026-10-04T10:00:60Z" },
      { ...verdict(), observed_at: "2026-10-04T10:00:00+25:00" }, { ...verdict(), permit: "forged" },
      { source: verdict().source, decision: "ALLOW", tool: verdict().tool }];
    const before = w.fake.requests.length;
    for (const external of invalid) {
      const raw = envelope(external);
      assert.notEqual(validInput(raw), null);
      const result = await observe(ctx, { client: "openclaw", event: "PreToolUse", input: JSON.stringify(raw) });
      assert.deepEqual(result, { status: "failed", line: "helm-executor: rejected: invalid external_verdict metadata\n" });
    }
    assert.equal(w.fake.requests.length, before);
    assert.equal(w.fake.observations.length, 0);
  } finally { await w.close(); }
});

test("metadata limits count Unicode characters, preserve offsets and never truncate", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w, "HELM-910", "openclaw");
    const external = { ...verdict(), source: "λ".repeat(128), tool: "λ".repeat(256), observed_at: "2024-02-29T10:00:00.123456789+02:00" };
    const raw = envelope(external);
    assert.equal(validInput(raw), null);
    assert.deepEqual(await observe(ctx, { client: "openclaw", event: "PreToolUse", input: JSON.stringify(raw) }), { status: "posted" });
    assert.deepEqual((w.fake.observations.at(-1) as Record<string, unknown>).external_verdict, external);
    for (const key of ["source", "tool"] as const) {
      const tooLong = envelope({ ...external, [key]: external[key] + "λ" });
      assert.notEqual(validInput(tooLong), null);
      assert.equal((await observe(ctx, { client: "openclaw", event: "PreToolUse", input: JSON.stringify(tooLong) })).status, "failed");
    }
  } finally { await w.close(); }
});

test("credential-shaped metadata is dropped without echoing its value", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w, "HELM-910", "openclaw");
    for (const key of ["source", "tool"]) {
      const outcome = await observe(ctx, { client: "openclaw", event: "PreToolUse", input: JSON.stringify(envelope({ ...verdict(), [key]: fakeSecrets.openai })) });
      assert.equal(outcome.status, "failed");
      assert.ok(outcome.status === "failed" && !outcome.line.includes(fakeSecrets.openai));
    }
    assert.equal(w.fake.observations.length, 0);
  } finally { await w.close(); }
});

test("the in-process public observer enforces the same 8 MiB input cap as the CLI", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w, "HELM-910", "openclaw");
    const outcome = await observe(ctx, { client: "openclaw", event: "PreToolUse", input: "x".repeat(MAX_INPUT_BYTES + 1) });
    assert.equal(outcome.status, "failed");
    assert.ok(outcome.status === "failed" && outcome.line.includes("larger than 8 MiB"));
    assert.equal(w.fake.observations.length, 0);
  } finally { await w.close(); }
});

test("malformed OpenClaw metadata never blocks the CLI hook or prints data", async () => {
  const w = await world();
  try {
    await checkedOut(w, "HELM-910", "openclaw");
    const cap = captureIo(JSON.stringify(envelope({ ...verdict(), receipt: "forged" })));
    const code = await runCli(["observe", "--client", "openclaw", "--event", "PreToolUse"], w.env(), cap.io, { now: w.clock.now, sleep: w.clock.sleep, home: w.home });
    assert.equal(code, 0);
    assert.equal(cap.out(), "");
    assert.match(cap.err(), /invalid external_verdict metadata/);
    assert.equal(w.fake.observations.length, 0);
  } finally { await w.close(); }
});

test("stdin and outbound metadata schemas remain byte-equivalent definitions", () => {
  const input = JSON.parse(readFileSync(new URL("../schema/observe-input.schema.json", import.meta.url), "utf8"));
  const output = JSON.parse(readFileSync(new URL("../schema/observation.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(input.properties.external_verdict, output.properties.external_verdict);
  assert.deepEqual(output.properties.external_verdict.properties.decision.enum, EXTERNAL_VERDICT_DECISIONS);
  assert.deepEqual(output.properties.client.enum, ["claude-code", "codex", "openclaw"]);
});
