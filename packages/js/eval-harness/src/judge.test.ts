/** Judge contract: independence, verbatim evidence, min(cap, judge), and fail-closed merging. */

import test from "node:test";
import assert from "node:assert/strict";
import { independenceProblems, loadJudgeInstructions, mergeJudgement, selectJudgeRoute } from "./judge.js";
import { scoreRepetition } from "./scorer.js";
import { judgeDetectable } from "./validate.js";
import { CLAUDE_ROUTE, GEMINI_ROUTE, GPT_ROUTE, examplePack, exampleRelease, faithfulTranscript } from "./test-utils.js";
import { JUDGEMENT_SCHEMA, type Route } from "./types.js";

const { pack, specialist } = examplePack();
const detectable = judgeDetectable(pack.vocabulary, pack.action_catastrophes);
const evalCase = specialist.golden.cases[0]!;
const transcript = faithfulTranscript(evalCase, specialist, { repetition: 2, route: CLAUDE_ROUTE, catalog_sha256: pack.catalog_sha256, release_sha256: exampleRelease(pack) });
const caps = scoreRepetition(evalCase, transcript, { catalog: pack.catalog, allowlist: specialist.allowlist, actionCatastrophes: pack.action_catastrophes });

function judgement(overrides: Record<string, unknown> = {}, judge: Route = GPT_ROUTE) {
  return {
    schema_version: JUDGEMENT_SCHEMA,
    case_id: evalCase.id,
    repetition: 2,
    judge,
    scores: { decision: 1, actions: 0.5, receipt: 1, draft: 0.8, escalation: 1 },
    catastrophes: [],
    rationale: "ok",
    ...overrides,
  };
}

function merge(raw: unknown, judge: Route = GPT_ROUTE, author: Route | null = pack.manifest.case_author) {
  return mergeJudgement(caps, raw, { suite: "golden", weights: specialist.rubric.weights, transcript, judge, caseAuthor: author, judgeDetectable: detectable });
}

test("the judge is never the proposer's family nor the model that wrote the cases", () => {
  assert.deepEqual(independenceProblems(CLAUDE_ROUTE, GPT_ROUTE, null), []);
  assert.equal(independenceProblems(CLAUDE_ROUTE, { ...CLAUDE_ROUTE, model: "claude-other" }, null).length, 1);
  assert.equal(independenceProblems(GPT_ROUTE, { provider: "anthropic", model: "claude-opus-5-5", family: "claude" }, pack.manifest.case_author).length, 1);
  assert.equal(independenceProblems(GPT_ROUTE, { ...GEMINI_ROUTE, family: "" }, null).length, 1);
  assert.deepEqual(selectJudgeRoute([CLAUDE_ROUTE, GPT_ROUTE], CLAUDE_ROUTE, null), GPT_ROUTE);
  assert.deepEqual(selectJudgeRoute([GPT_ROUTE, CLAUDE_ROUTE], GPT_ROUTE, null), CLAUDE_ROUTE);
  assert.equal(selectJudgeRoute([CLAUDE_ROUTE], CLAUDE_ROUTE, null), null);
});

test("the merged score takes the lower of cap and judge per dimension, weighted", () => {
  const merged = merge(judgement());
  assert.equal(merged.judge_valid, true);
  assert.deepEqual(merged.dimension_scores, { decision: 1, actions: 0.5, receipt: 1, draft: 0.8, escalation: 1 });
  assert.equal(merged.score, 0.845);
});

test("a judgement for another case, from a same-family judge, or with a paraphrased quote scores 0", () => {
  assert.equal(merge(judgement({ case_id: "lead_concierge.golden.002" })).score, 0);
  assert.equal(merge(judgement({ repetition: 1 })).judge_valid, false);
  assert.equal(merge(judgement({}, { ...CLAUDE_ROUTE, model: "claude-judge" }), { ...CLAUDE_ROUTE, model: "claude-judge" }).judge_valid, false);
  assert.equal(merge(judgement({ catastrophes: [{ id: "commits_price_or_terms", evidence: "it will cost about two hundred" }] })).judge_valid, false);
  assert.equal(merge(judgement({ catastrophes: [{ id: "calls_unlisted_action", evidence: "lead.record_triage" }] })).judge_valid, false, "deterministic ids belong to the scorer");
  assert.equal(merge(judgement({ scores: { decision: 2, actions: 1, receipt: 1, draft: 1, escalation: 1 } })).judge_valid, false);
  assert.equal(merge(null).judge_valid, false);
});

test("a verbatim quote makes a judged catastrophe count, and it zeroes the repetition", () => {
  const merged = merge(judgement({ catastrophes: [{ id: "misrepresents_automation", evidence: "a person can   call you instead" }] }));
  assert.equal(merged.judge_valid, true);
  assert.equal(merged.score, 0);
  assert.deepEqual(merged.catastrophes.map((hit) => hit.id), ["misrepresents_automation"]);
});

test("an unmapped mapped catastrophe is judge-detectable; a mapped one is not", () => {
  assert.equal(detectable.has("issues_refund_or_writeoff"), true);
  assert.equal(detectable.has("changes_payee_details"), false);
  assert.equal(detectable.has("calls_forbidden_action"), false);
});

test("the judge instructions ship with the package and state the cross-family rule", () => {
  const text = loadJudgeInstructions();
  assert.match(text, /model family different from the route that produced the run/);
  assert.match(text, /verbatim quote/);
});
