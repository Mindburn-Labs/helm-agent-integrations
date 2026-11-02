/** Qualification profile: validation, abstention classes, rolling cost ceilings, records. */

import test from "node:test";
import assert from "node:assert/strict";
import { buildQualificationReport, checkCeiling, classifyAbstention, recordFromReport, validateProfile, type UsageEntry } from "./qualification.js";
import { evaluateSuite } from "./scorer.js";
import { CLAUDE_ROUTE, GPT_ROUTE, exampleProfile, examplePack } from "./test-utils.js";

test("a profile must not lower the bar, must judge across families, and scores only invalid output", () => {
  assert.deepEqual(validateProfile(exampleProfile()), []);
  const lowered = exampleProfile();
  lowered.release_bar.redteam_mean = 0.9;
  assert.ok(validateProfile(lowered).some((problem) => problem.includes("redteam_mean")));
  const oneFamily = exampleProfile();
  oneFamily.judge.routes = [GPT_ROUTE];
  assert.ok(validateProfile(oneFamily).some((problem) => problem.includes("two model families")));
  const scored = exampleProfile();
  scored.abstentions.score.push("rate_limited");
  assert.ok(validateProfile(scored).some((problem) => problem.includes("classified twice")));
  const shared = exampleProfile();
  shared.ledger.namespace = "production";
  assert.ok(validateProfile(shared).some((problem) => problem.includes("isolated")));
});

test("abstentions pause, stop or score; anything unknown stops", () => {
  const profile = exampleProfile();
  assert.equal(classifyAbstention("rate_limited", profile), "pause");
  assert.equal(classifyAbstention("cost_ceiling", profile), "pause");
  assert.equal(classifyAbstention("model_mismatch", profile), "stop");
  assert.equal(classifyAbstention("invalid_output", profile), "score");
  assert.equal(classifyAbstention("a_reason_nobody_classified", profile), "stop");
});

test("ceilings hold per specialist, per judge, per team and per call over the rolling window", () => {
  const profile = exampleProfile();
  profile.ceilings = {
    window_hours: 24,
    specialist: { calls: 3, cost_usd: 1, cost_usd_per_call: 0.5 },
    judge: { calls: 5, cost_usd: 1, cost_usd_per_call: 0.2 },
    team: { calls: 6, cost_usd: 2, cost_usd_per_call: 0.5 },
  };
  const now = 100 * 3_600_000;
  const at = (hoursAgo: number) => now - hoursAgo * 3_600_000;
  const ledger: UsageEntry[] = [
    { at_ms: at(30), kind: "specialist", specialist_id: "a", cost_usd: 0.4 },
    { at_ms: at(2), kind: "specialist", specialist_id: "a", cost_usd: 0.4 },
    { at_ms: at(1), kind: "specialist", specialist_id: "a", cost_usd: 0.4 },
  ];
  assert.deepEqual(checkCeiling(ledger, { kind: "specialist", specialist_id: "a", estimate_usd: 0.1 }, now, profile), { allowed: true }, "the entry 30 hours ago is outside the window");
  assert.deepEqual(checkCeiling(ledger, { kind: "specialist", specialist_id: "a", estimate_usd: 0.3 }, now, profile), { allowed: false, reason: "cost_ceiling", scope: "specialist" });
  assert.deepEqual(checkCeiling(ledger, { kind: "specialist", specialist_id: "a", estimate_usd: 0.6 }, now, profile), { allowed: false, reason: "cost_ceiling", scope: "per_call" });
  const busy = [...ledger, { at_ms: at(0.5), kind: "specialist" as const, specialist_id: "a", cost_usd: 0 }];
  assert.deepEqual(checkCeiling(busy, { kind: "specialist", specialist_id: "a", estimate_usd: 0 }, now, profile), { allowed: false, reason: "call_ceiling", scope: "specialist" });
  const team = [...ledger, ...[1, 2, 3, 4].map((i) => ({ at_ms: at(i / 10), kind: "judge" as const, specialist_id: "b", cost_usd: 0.1 }))];
  assert.deepEqual(checkCeiling(team, { kind: "judge", specialist_id: "c", estimate_usd: 0.1 }, now, profile), { allowed: false, reason: "call_ceiling", scope: "team" });
});

test("an incomplete report records nothing; a complete one records the exact route and release", () => {
  const { specialist } = examplePack();
  const incomplete = buildQualificationReport({
    specialist_id: "lead_concierge",
    route: CLAUDE_ROUTE,
    judge_routes: [GPT_ROUTE],
    release_sha256: "3".repeat(64),
    prompt_sha256: "4".repeat(64),
    catalog_sha256: "5".repeat(64),
    rubric: specialist.rubric,
    evaluation: evaluateSuite([], specialist.rubric, { golden: ["x"], redteam: ["y"] }),
  });
  assert.equal(incomplete.verdict, "incomplete");
  assert.equal(recordFromReport(incomplete, { qualification_id: "q", report_sha256: "6".repeat(64), owner_ref: "person:o", sequence: 1 }), null);
  const complete = { ...incomplete, verdict: "not_qualified" as const };
  assert.throws(() => recordFromReport(complete, { qualification_id: "q", report_sha256: "bad", owner_ref: "person:o", sequence: 1 }));
  const row = recordFromReport(complete, { qualification_id: "q", report_sha256: "6".repeat(64), owner_ref: "person:o", sequence: 1 });
  assert.deepEqual(row?.route, { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" });
  assert.equal(row?.passed, false);
});
