import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  EPISODE_MEDIA_TYPE,
  EXTENSION_URI,
  EpisodeError,
  OutcomeTracker,
  STATUS_MEDIA_TYPE,
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
  calls: Array<{ tool: string; arguments: unknown; result: { is_error?: boolean; structured?: unknown; text?: string } }>;
  expect: { observations: unknown[]; outcome: { state: string; status?: unknown; code?: string } };
}>;
const promptGolden = fixture("prompt.golden.json") as { episode: string; system: string; user: string };

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

test("outcome vectors shared with Python", () => {
  for (const testCase of outcomes) {
    const tracker = new OutcomeTracker();
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
