import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  EPISODE_MEDIA_TYPE,
  EXTENSION_URI,
  EpisodeError,
  OutcomeTracker,
  STATUS_MEDIA_TYPE,
  TARGET_REFUSAL_CODE,
  bindTarget,
  boundInputSchema,
  boundTargets,
  buildPrompts,
  episodeFromMessage,
  findStatusPayload,
  loadSchema,
  parseEpisode,
  renderAgentCard,
  requireSupportedApi,
  schemaIssues,
  statusMetadata,
  statusParts,
  statusPayload,
  type ToolResult,
} from "./index.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8"));
const cases = fixture("episode.cases.json") as { valid: Record<string, unknown>; invalid: Record<string, unknown> };
const outcomes = fixture("outcome.cases.json") as Array<{
  name: string;
  review_target?: string;
  calls: Array<{ tool: string; arguments: unknown; result: { is_error?: boolean; structured?: unknown; text?: string } }>;
  expect: { observations: unknown[]; outcome: { state: string; status?: unknown; code?: string } };
}>;
const promptGolden = fixture("prompt.golden.json") as { episode: string; system: string; user: string };
const bindings = fixture("binding.cases.json") as {
  episodes: Array<{ name: string; episode: string; targets: Record<string, string> }>;
  calls: Array<{
    name: string;
    episode: string;
    tool: string;
    arguments: Record<string, unknown> | null;
    expect: { arguments?: unknown; refused?: string; text?: string };
  }>;
  schemas: Array<{ name: string; episode: string; tool: string; schema: unknown; expect: unknown }>;
};

test("valid episodes parse", () => {
  for (const [name, raw] of Object.entries(cases.valid)) {
    const episode = parseEpisode(raw);
    assert.equal(episode.credentialsEnv, "HELM_EPISODE_TOKEN", name);
    assert.ok(episode.deadline instanceof Date && !Number.isNaN(episode.deadline.getTime()), name);
  }
});

test("full episode fields", () => {
  const episode = parseEpisode(cases.valid.full);
  assert.equal(episode.continuation, 2);
  assert.equal(episode.seat.key, "engineer_1");
  assert.equal(episode.tools.allowed.at(-1), "helm_work_report");
  assert.equal(episode.model.api, "anthropic-messages");
  assert.equal(episode.deadline.toISOString(), "2026-10-01T12:00:00.000Z");
});

test("minimal episode defaults and offset deadlines", () => {
  const episode = parseEpisode(cases.valid.minimal);
  assert.deepEqual([episode.continuation, episode.context, episode.seat.role], [0, {}, ""]);
  assert.equal(episode.deadline.toISOString(), "2026-10-01T09:00:00.500Z");
});

test("base url loses its trailing slash and unknown members are ignored", () => {
  assert.equal(parseEpisode(cases.valid.responses_api).model.baseUrl, "https://helm-gateway-worker.helm.svc:8443");
});

test("invalid episodes are rejected", () => {
  for (const [name, raw] of Object.entries(cases.invalid)) {
    assert.throws(
      () => parseEpisode(raw),
      (error: unknown) => error instanceof EpisodeError && error.code === "INVALID_EPISODE",
      name,
    );
  }
});

test("schema issues name the path", () => {
  const issues = schemaIssues("episode.v1", cases.invalid.unknown_api);
  assert.ok(issues.some((issue) => issue.startsWith("model/api:")), issues.join("\n"));
});

test("episode from a message", () => {
  const message = { parts: [{ text: "goal" }, { data: cases.valid.full, mediaType: EPISODE_MEDIA_TYPE }] };
  assert.equal(episodeFromMessage(message).seat.key, "engineer_1");
  assert.throws(() => episodeFromMessage({ parts: [{ text: "goal" }] }), EpisodeError);
  assert.throws(
    () => episodeFromMessage({ parts: [{ data: cases.valid.full, mediaType: "application/json" }] }),
    EpisodeError,
  );
});

test("unsupported model api", () => {
  const episode = parseEpisode(cases.valid.full);
  requireSupportedApi(episode, ["anthropic-messages"]);
  assert.throws(
    () => requireSupportedApi(episode, ["openai-responses"]),
    (error: unknown) => error instanceof EpisodeError && error.code === "UNSUPPORTED_MODEL_API",
  );
});

test("prompts match the golden file shared with Python", () => {
  const { system, user } = buildPrompts(parseEpisode((cases.valid as Record<string, unknown>)[promptGolden.episode]));
  assert.equal(system, promptGolden.system);
  assert.equal(user, promptGolden.user);
});

test("the model receives its bound work target instead of guessing a seat key", () => {
  for (const name of ["full", "minimal"]) {
    const episode = parseEpisode((cases.valid as Record<string, unknown>)[name]);
    const { system } = buildPrompts(episode);
    for (const id of ["work:" + episode.workItemId, episode.episodeId,
      episode.organizationId, episode.organizationVersionId, episode.seat.id]) {
      assert.ok(system.includes(id), `missing runtime binding ${id}`);
    }
    assert.ok(!system.includes("work:" + episode.seat.key));
  }
});

test("continuation keeps human answers and review work IDs", () => {
  const raw = structuredClone((cases.valid as Record<string, any>).full);
  raw.context.helm_input_answers = [{ question: "Which notes?", answer: "Use the approved revision." }];
  raw.context.helm_review_children = ["c9ab331d-e3b0-4ca1-bf63-ecbc9b7cd81a"];
  const { user } = buildPrompts(parseEpisode(raw));
  assert.ok(user.includes("Use the approved revision."));
  assert.ok(user.includes("c9ab331d-e3b0-4ca1-bf63-ecbc9b7cd81a"));
});

test("outcome vectors shared with Python", () => {
  for (const testCase of outcomes) {
    const tracker = new OutcomeTracker(testCase.review_target ?? null);
    const seen = testCase.calls.map((call) => {
      const result: ToolResult = {
        isError: call.result.is_error ?? false,
        structured: call.result.structured,
        text: call.result.text ?? null,
      };
      const observation = tracker.observe(call.tool, call.arguments, result);
      return { kind: observation.kind, stop: observation.stop, ...(observation.reason ? { reason: observation.reason } : {}) };
    });
    assert.deepEqual(seen, testCase.expect.observations, testCase.name);
    const outcome = tracker.outcome("final words");
    assert.equal(outcome.state, testCase.expect.outcome.state, testCase.name);
    if (testCase.expect.outcome.status) assert.deepEqual(outcome.status, testCase.expect.outcome.status, testCase.name);
    if (testCase.expect.outcome.code) assert.equal(outcome.status.error?.code, testCase.expect.outcome.code, testCase.name);
  }
});

test("mirrors validate against their schemas", () => {
  const tracker = new OutcomeTracker();
  const escalated = tracker.observe(
    "github_pull_request_create_draft",
    { title: "t" },
    { structured: { status: "escalated", attempt_id: "att_1" } },
  );
  assert.deepEqual(escalated.proposal, {
    schema: "helm.proposal.v1",
    tool: "github_pull_request_create_draft",
    arguments: { title: "t" },
    status: "escalated",
    attempt_id: "att_1",
  });
  assert.deepEqual(schemaIssues("proposal.v1", escalated.proposal), []);
  const reported = tracker.observe(
    "helm_work_report",
    { status: "blocked", summary: "s", outputs: [{ kind: "pr", ref: "7" }, { kind: "x" }] },
    { structured: { status: "succeeded" } },
  );
  assert.deepEqual(reported.report?.outputs, [{ kind: "pr", ref: "7" }]);
  assert.deepEqual(schemaIssues("report.v1", reported.report), []);
});

test("bound targets come from the episode, as in Python", () => {
  for (const testCase of bindings.episodes) {
    assert.deepEqual(boundTargets(parseEpisode(cases.valid[testCase.episode])), testCase.targets, testCase.name);
  }
});

test("binding vectors shared with Python", () => {
  for (const testCase of bindings.calls) {
    const targets = boundTargets(parseEpisode(cases.valid[testCase.episode]));
    const original = structuredClone(testCase.arguments);
    const { arguments: sent, refusal } = bindTarget(testCase.tool, testCase.arguments, targets);
    assert.deepEqual(testCase.arguments, original, `${testCase.name}: the model's arguments are not mutated`);
    if (testCase.expect.refused !== undefined) {
      const structured = refusal?.structured as Record<string, string> | undefined;
      assert.equal(refusal?.isError, true, testCase.name);
      assert.equal(structured?.status, "invalid", testCase.name);
      assert.equal(structured?.reason_code, TARGET_REFUSAL_CODE, testCase.name);
      assert.ok(structured?.message.includes(testCase.expect.refused), testCase.name);
      // Only the bound target is named; the mistyped one is not echoed back.
      assert.ok(!structured?.message.includes(String(testCase.arguments?.target)), testCase.name);
      assert.deepEqual(JSON.parse(refusal?.text ?? ""), structured, testCase.name);
      if (testCase.expect.text !== undefined) assert.equal(refusal?.text, testCase.expect.text, testCase.name);
      assert.deepEqual(sent, testCase.arguments ?? {}, testCase.name);
    } else {
      assert.equal(refusal, undefined, testCase.name);
      assert.deepEqual(sent, testCase.expect.arguments, testCase.name);
    }
  }
});

test("schema vectors shared with Python", () => {
  for (const testCase of bindings.schemas) {
    const targets = boundTargets(parseEpisode(cases.valid[testCase.episode]));
    const original = structuredClone(testCase.schema);
    const listed = boundInputSchema(testCase.tool, testCase.schema, targets);
    assert.deepEqual(testCase.schema, original, `${testCase.name}: the listed schema is not mutated`);
    assert.deepEqual(listed, testCase.expect, testCase.name);
  }
});

test("a refusal is an ordinary tool error that stops nothing", () => {
  const targets = boundTargets(parseEpisode(cases.valid.full));
  const tracker = new OutcomeTracker();
  const wrong = { target: "work:0b7e3c1a-7ef7-4c6f-8a90-3e4f5a6b7c02", arguments: {} };
  const { refusal } = bindTarget("helm_work_report", wrong, targets);
  assert.ok(refusal);
  const seen = tracker.observe("helm_work_report", wrong, refusal);
  assert.deepEqual([seen.kind, seen.stop], ["error", false]);
  assert.equal(tracker.stopped, false);
  assert.equal(tracker.outcome().status.error?.code, "NO_REPORT");
});

test("an evaluator's omitted review target completes once bound", () => {
  const episode = parseEpisode(cases.valid.evaluation);
  const original = episode.evaluation?.work_item_id ?? "";
  const tracker = new OutcomeTracker(`work:${original}`);
  const { arguments: sent, refusal } = bindTarget(
    "helm_work_review",
    { arguments: { decision: "accept", reason: "Checked." } },
    boundTargets(episode),
  );
  assert.equal(refusal, undefined);
  const seen = tracker.observe("helm_work_review", sent, {
    structured: { status: "succeeded", attempt_id: "att-1", result: { child_id: original } },
  });
  assert.equal(seen.reason, "reviewed");
  assert.equal(tracker.outcome().state, "completed");
});

test("status payloads validate and round trip", () => {
  const payloads = [
    statusPayload({ waitingOn: { attempts: ["a"] } }),
    statusPayload({ waitingOn: { children: [] } }),
    statusPayload({ waitingOn: { input: { question: "q", options: [] } } }),
    statusPayload({ error: { code: "NO_REPORT", message: "m" } }),
    statusPayload({ report: { status: "done", summary: "s" } }),
  ];
  for (const payload of payloads) {
    assert.deepEqual(schemaIssues("status.v1", payload), [], JSON.stringify(payload));
    const parts = statusParts("text", payload);
    assert.equal(parts[1]?.mediaType, STATUS_MEDIA_TYPE);
    assert.deepEqual(findStatusPayload(parts), payload);
    assert.ok(!("schema" in statusMetadata(payload)));
  }
  assert.notDeepEqual(schemaIssues("status.v1", { schema: "helm.episode.status.v1", waiting_on: {} }), []);
  assert.notDeepEqual(schemaIssues("status.v1", { schema: "helm.episode.status.v1", error: { code: "OTHER", message: "m" } }), []);
  assert.notDeepEqual(schemaIssues("status.v1", statusPayload({ waitingOn: { attempts: [] } })), []);
});

test("agent card carries the required extension", () => {
  const card = renderAgentCard({
    framework: "langgraph",
    url: "http://worker:8080/",
    version: "1.2.3",
    modelApis: ["anthropic-messages", "openai-chat-completions"],
  }) as any;
  assert.deepEqual(card.supportedInterfaces[0], {
    url: "http://worker:8080/",
    protocolBinding: "JSONRPC",
    protocolVersion: "1.0",
  });
  const [extension] = card.capabilities.extensions;
  assert.equal(extension.uri, EXTENSION_URI);
  assert.equal(extension.required, true);
  assert.deepEqual(extension.params.model_apis, ["anthropic-messages", "openai-chat-completions"]);
  assert.equal(card.capabilities.streaming, true);
  assert.ok(card.defaultInputModes.includes(EPISODE_MEDIA_TYPE));
  assert.ok(!JSON.stringify(card).includes("{{"));
  assert.equal(card.name, "HELM worker (langgraph)");
});

test("schemas are loadable", () => {
  for (const name of ["episode.v1", "status.v1", "proposal.v1", "report.v1"]) {
    assert.ok("$id" in loadSchema(name), name);
  }
});
