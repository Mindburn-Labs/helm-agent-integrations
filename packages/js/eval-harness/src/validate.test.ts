/** Pack validation: each rule refuses a broken pack with a message that names the problem. */

import test from "node:test";
import assert from "node:assert/strict";
import { canonicalSha256, releaseSha256 } from "./canonical.js";
import { DEFAULT_CATASTROPHES, extendVocabulary } from "./catastrophes.js";
import { validatePack, type LoadedPack } from "./pack.js";
import { examplePack } from "./test-utils.js";
import { parseCaseDuration, resolveTimeMarkers, toCaseDuration } from "./time.js";

function mutated(change: (pack: LoadedPack) => void): string[] {
  const { pack } = examplePack();
  change(pack);
  return validatePack(pack, { repetitions: 3 });
}

function hasProblem(problems: string[], fragment: string): boolean {
  return problems.some((problem) => problem.includes(fragment));
}

test("cases may hold no calendar dates, real emails or phone numbers outside the fictional range", () => {
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.golden.cases[0]!.signal.content.text = "Visit on 2031-04-02 please"; }), "calendar date"));
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.golden.cases[0]!.signal.content.text = "Write to dana@gmail.com"; }), "reserved example domains"));
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.golden.cases[0]!.signal.content.text = "Call (212) 555-0199 or (212) 867-5309"; }), "555-0100 to 555-0199"));
});

test("time markers live only in fact data or expected", () => {
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.golden.cases[0]!.signal.content.when = { $case_time: "PT1H" }; }), "outside fact data"));
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.golden.cases[0]!.facts[0]!.data.when = { $case_epoch: 1 }; }), "not a time marker"));
});

test("suites keep their shape: attack only in red-team, ids by suite, forbidden never expected", () => {
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.golden.cases[0]!.attack = { category: "spam", vector: "x" }; }), "attack must be null"));
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.redteam.cases[0]!.attack = null; }), "needs attack.category"));
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.golden.cases[0]!.id = "lead_concierge.redteam.001"; }), "id must be"));
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.golden.cases[0]!.expected.forbidden_actions.push("lead.record_triage"); }), "both forbidden"));
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.golden.cases[0]!.catastrophic_if = []; }), "at least one catastrophe"));
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.golden.cases[0]!.catastrophic_if = ["not_a_catastrophe"]; }), "not in the vocabulary"));
});

test("receipt outcome follows the decision and the effect class of the expected actions", () => {
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.golden.cases[3]!.expected.receipt!.outcome = "succeeded"; }), "outcome must be null"));
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.golden.cases[5]!.expected.receipt!.outcome = "succeeded"; }), "outcome must be abstained"));
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.golden.cases[0]!.expected.receipt!.must_cite.push("lead/L-0000"); }), "not a case fact"));
});

test("an asserted identifier must be visible in the signal or the facts", () => {
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.golden.cases[0]!.expected.actions[0]!.args_must_include = { lead_id: "L-7777" }; }), "asserts lead_id"));
});

test("allowlist, catalog hash, coverage and action catastrophes are checked", () => {
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.allowlist.actions.push({ action_id: "price.quote", max_class: "commit" }); }), "never allowlisted"));
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.allowlist.actions[1]!.max_class = "commit"; }), "above the catalog class"));
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.golden.catalog_sha256 = "0".repeat(64); }), "catalog_sha256"));
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.golden.cases.pop(); }), "at least 10 required"));
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.redteam.cases.shift(); }), "prompt_injection"));
  assert.ok(hasProblem(mutated((p) => { p.action_catastrophes["lead.export"] = ["changes_payee_details"]; }), "not human_only"));
  assert.ok(hasProblem(mutated((p) => { p.action_catastrophes["price.quote"] = ["commits_price_or_terms"]; }), "not a mapped catastrophe"));
});

test("the default case policy is release grade; the example sets lower counts on purpose", () => {
  assert.ok(hasProblem(mutated((p) => { p.case_policy = { min_golden: 20, min_redteam: 10, min_redteam_categories: 4 }; }), "at least 20 required"));
});

test("a rubric may raise the bar, not lower it without a recorded owner decision", () => {
  assert.deepEqual(mutated((p) => { p.specialists[0]!.rubric.pass_bar.golden_mean = 0.95; }), []);
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.rubric.pass_bar.golden_mean = 0.8; }), "without a recorded owner decision"));
  assert.deepEqual(mutated((p) => { p.specialists[0]!.rubric.pass_bar.golden_mean = 0.8; p.specialists[0]!.rubric.bar_change_ref = "decision:owner-17"; }), []);
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.rubric.weights = { decision: 0.4, actions: 0.2, receipt: 0.2, draft: 0.1, escalation: 0.1 }; }), "weights_reason"));
  assert.ok(hasProblem(mutated((p) => { p.specialists[0]!.rubric.repetitions = 2; }), "differ from the qualification profile"));
});

test("a pack may extend the catastrophe vocabulary but not redefine it", () => {
  const extended = extendVocabulary([{ id: "misstates_permit_status", detection: "judge", definition: "States a permit is held when it is not." }]);
  assert.equal(extended.catastrophes.length, DEFAULT_CATASTROPHES.catastrophes.length + 1);
  assert.throws(() => extendVocabulary([{ id: "fabricates_fact", detection: "judge", definition: "again" }]), /already defined/);
  assert.throws(() => extendVocabulary([{ id: "new_rule", detection: "deterministic", definition: "x" }]), /only mapped or judge/);
});

test("case durations and markers resolve against the clock without calendar input", () => {
  assert.equal(parseCaseDuration("-P3D"), -3 * 86_400_000);
  assert.equal(parseCaseDuration("PT1H30M"), 5_400_000);
  assert.throws(() => parseCaseDuration("P1Y"));
  assert.throws(() => parseCaseDuration("P"));
  assert.equal(toCaseDuration(-5_400_000), "-PT1H30M");
  assert.equal(toCaseDuration(0), "PT0M");
  const clock = Date.UTC(2030, 2, 10, 6, 30);
  const resolved = resolveTimeMarkers({ at: { $case_time: "-PT2H" }, due: { $case_date: "P1D" }, list: [{ $case_date: "-P10D" }] }, clock, "America/New_York");
  assert.deepEqual(resolved, { at: "2030-03-10T04:30:00.000Z", due: "2030-03-11", list: ["2030-02-28"] });
});

test("release hashes are canonical and change with any component", () => {
  const catalog = "a".repeat(64);
  const one = releaseSha256({ specialist_id: "x", components: { catalog, instructions: "b".repeat(64) } });
  const same = releaseSha256({ specialist_id: "x", components: { instructions: "b".repeat(64), catalog } });
  const other = releaseSha256({ specialist_id: "x", components: { catalog, instructions: "c".repeat(64) } });
  assert.equal(one, same);
  assert.notEqual(one, other);
  assert.throws(() => releaseSha256({ specialist_id: "x", components: { instructions: "b".repeat(64) } }), /catalog/);
  assert.equal(canonicalSha256({ b: 1, a: [true, null] }), canonicalSha256({ a: [true, null], b: 1 }));
  assert.throws(() => canonicalSha256({ a: Number.NaN }));
});
