/** Earned autonomy: sample-size rule, agreement, promotion one step at a time, automatic fallback. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AUTONOMY_POLICY,
  STEPS,
  applyDemotion,
  checkStanding,
  compareLiveReview,
  compareShadow,
  errorRateUpperBound,
  evaluatePromotion,
  requiredCleanCases,
  stepForLevel,
  summarizeWindow,
  type ActionProfile,
  type AgreementDecision,
  type Comparison,
  type WindowKey,
} from "./autonomy.js";

const KEY: WindowKey = { specialist_id: "lead_concierge", action_id: "lead.record_triage", release_sha256: "1".repeat(64), policy_version: DEFAULT_AUTONOMY_POLICY.version };
const ACTION: ActionProfile = { delegable: true, human_only: false, protective: false, max_step: "review_regularly", severity: "standard", human_error_rate: 0.05 };

let batch = 0;

function decisions(spec: [Comparison, number][], overrides: Partial<AgreementDecision> = {}): AgreementDecision[] {
  const out: AgreementDecision[] = [];
  batch += 1;
  for (const [comparison, count] of spec) {
    for (let i = 0; i < count; i += 1) {
      out.push({ decision_id: `b${batch}-d${out.length}`, ...KEY, sequence: out.length, comparison, catastrophe: false, ...overrides });
    }
  }
  return out;
}

test("rule of three: n clean cases bound the error rate at 3/n; 600 clean cases prove 0.5%", () => {
  assert.equal(errorRateUpperBound(300, 0), 0.01);
  assert.equal(errorRateUpperBound(600, 0), 0.005);
  assert.equal(requiredCleanCases(0.005), 600);
  assert.equal(requiredCleanCases(0.05 / 10), 600, "a 5% human error rate and the 10x rule");
  assert.equal(requiredCleanCases(0.01), 300);
  assert.equal(errorRateUpperBound(0, 0), 1);
  assert.equal(errorRateUpperBound(10, 10), 1);
});

test("with errors, the bound is Clopper-Pearson: above the observed rate and shrinking with n", () => {
  const small = errorRateUpperBound(100, 1);
  const large = errorRateUpperBound(1000, 10);
  assert.ok(small > 0.01 && small < 0.05, String(small));
  assert.ok(large > 0.01 && large < small, String(large));
  // Exact check for one error in 100 at 95%: about 0.0466.
  assert.ok(Math.abs(small - 0.0466) < 0.0005, String(small));
  assert.throws(() => errorRateUpperBound(5, 6));
});

test("agreement: shadow runs compare action, object, values and recipient; live reviews map outcomes", () => {
  const proposal = { action_id: "customer_message.send", object: { lead: "L-1" }, values: { purpose: "acknowledge" }, recipient: "customer" };
  assert.equal(compareShadow(proposal, null), "unscored");
  assert.equal(compareShadow(proposal, { ...proposal, values: { purpose: "acknowledge" } }), "match");
  assert.equal(compareShadow(proposal, { ...proposal, values: { purpose: "decline" } }), "partial");
  assert.equal(compareShadow(proposal, { ...proposal, action_id: "note.add" }), "diverge");
  assert.equal(compareLiveReview("approved"), "match");
  assert.equal(compareLiveReview("declined"), "diverge");
  assert.equal(compareLiveReview("done_by_person"), "unscored");
});

test("the window counts only the current release and policy; refused closes count only against", () => {
  const list = [
    ...decisions([["match", 40], ["unscored", 5], ["diverge", 2]]),
    ...decisions([["match", 30]], { release_sha256: "2".repeat(64) }),
    ...decisions([["match", 3], ["partial", 1]], { close_refused: true }),
  ];
  const summary = summarizeWindow(list, KEY);
  assert.equal(summary.counted, 43);
  assert.equal(summary.matches, 40);
  assert.equal(summary.partials, 1);
  assert.equal(summary.diverges, 2);
  assert.equal(summary.unscored, 8);
  assert.equal(summary.errors, 3);
});

test("the D19 ladder maps the plan's A0 to A5 levels", () => {
  assert.deepEqual(STEPS.map((step) => step.backend_state), ["draft", "propose_only", "approval-required", "constrained-live", "certified-live"]);
  assert.equal(stepForLevel("A0"), "watch");
  assert.equal(stepForLevel("A2"), "suggest");
  assert.equal(stepForLevel("A3"), "ask_first");
  assert.equal(stepForLevel("A4"), "within_limits");
  assert.equal(stepForLevel("A5"), "review_regularly");
});

test("acting within limits needs 50 compared decisions, 95% matches, no catastrophe, and a qualified route", () => {
  const base = { current_step: "ask_first" as const, practice_only: false, key: KEY, action: ACTION, qualified: true };
  const ready = evaluatePromotion({ ...base, decisions: decisions([["match", 48], ["diverge", 2]]) });
  assert.equal(ready.eligible, true, ready.blocked_by.join("; "));
  assert.equal(ready.proposed_step, "within_limits");
  assert.equal(ready.requires_owner_decision, true);

  assert.equal(evaluatePromotion({ ...base, decisions: decisions([["match", 49]]) }).eligible, false);
  assert.equal(evaluatePromotion({ ...base, decisions: decisions([["match", 47], ["partial", 3]]) }).eligible, false);
  assert.equal(evaluatePromotion({ ...base, qualified: false, decisions: decisions([["match", 60]]) }).eligible, false);
  const withCatastrophe = decisions([["match", 60]]);
  withCatastrophe.push({ ...withCatastrophe[0]!, decision_id: "c", sequence: 99, comparison: "unscored", catastrophe: true });
  assert.ok(evaluatePromotion({ ...base, decisions: withCatastrophe }).blocked_by.some((reason) => reason.includes("catastrophe")));
  assert.equal(evaluatePromotion({ ...base, action: { ...ACTION, delegable: false }, decisions: decisions([["match", 60]]) }).eligible, false);
  assert.equal(evaluatePromotion({ ...base, action: { ...ACTION, max_step: "ask_first" }, decisions: decisions([["match", 60]]) }).eligible, false);
  assert.equal(evaluatePromotion({ ...base, action: { ...ACTION, protective: true }, decisions: decisions([["match", 60]]) }).eligible, false);
  assert.equal(evaluatePromotion({ ...base, key: { ...KEY, policy_version: "old" }, decisions: decisions([["match", 60]], { policy_version: "old" }) }).eligible, false);
});

test("review regularly needs the 10x rule: at a 5% human error rate, 600 clean decisions", () => {
  const base = { current_step: "within_limits" as const, practice_only: false, key: KEY, action: ACTION, qualified: true };
  const short = evaluatePromotion({ ...base, decisions: decisions([["match", 599]]) });
  assert.equal(short.eligible, false);
  assert.equal(short.required_clean_cases, 600);
  assert.equal(short.target_error_rate, 0.005);
  assert.equal(evaluatePromotion({ ...base, decisions: decisions([["match", 600]]) }).proposed_step, "review_regularly");
  assert.equal(evaluatePromotion({ ...base, decisions: decisions([["match", 900], ["diverge", 1]]) }).eligible, false, "one error needs far more than 900");
  assert.equal(evaluatePromotion({ ...base, action: { ...ACTION, human_error_rate: null }, decisions: decisions([["match", 5000]]) }).eligible, false);
  const strict = { ...DEFAULT_AUTONOMY_POLICY, severity_max_error_rate: { money: 0.001 } };
  const money = evaluatePromotion({ ...base, policy: strict, action: { ...ACTION, severity: "money" }, decisions: decisions([["match", 600]]) });
  assert.equal(money.eligible, false);
  assert.equal(money.required_clean_cases, 3000);
});

test("promotion is one step at a time, and practice-only moves to asks first before acting", () => {
  const base = { practice_only: false, key: KEY, action: ACTION, qualified: true, decisions: decisions([["match", 700]]) };
  assert.equal(evaluatePromotion({ ...base, current_step: "watch" }).proposed_step, "suggest");
  assert.equal(evaluatePromotion({ ...base, current_step: "suggest" }).proposed_step, "ask_first");
  assert.equal(evaluatePromotion({ ...base, current_step: "review_regularly" }).eligible, false);
  assert.equal(evaluatePromotion({ ...base, current_step: "ask_first", practice_only: true }).eligible, false);
});

test("a widened setting falls back to asks first on any trigger; a catastrophe also opens an exception", () => {
  for (const trigger of ["outcome_unknown", "readback_mismatch", "done_by_person", "undo_by_person", "policy_version_changed", "catalog_changed", "release_changed_unqualified", "no_qualified_route", "auditor_hold", "something_new"]) {
    const result = applyDemotion({ step: "within_limits", practice_only: false }, trigger);
    assert.equal(result.setting.step, "ask_first", trigger);
    assert.equal(result.requires_owner_confirmation, true);
    assert.equal(result.open_exception, false);
  }
  assert.equal(applyDemotion({ step: "review_regularly", practice_only: false }, "catastrophe").setting.step, "ask_first");
  assert.equal(applyDemotion({ step: "review_regularly", practice_only: false }, "catastrophe").open_exception, true);
  assert.equal(applyDemotion({ step: "ask_first", practice_only: false }, "readback_mismatch").changed, false);
});

test("a practice-only setting never gains autonomy on fallback: its practice stops instead", () => {
  const stopped = applyDemotion({ step: "suggest", practice_only: true }, "no_qualified_route");
  assert.deepEqual(stopped.setting, { step: "suggest", practice_only: true, practice_stopped: true });
  assert.equal(stopped.requires_owner_confirmation, true);
  assert.equal(applyDemotion({ step: "suggest", practice_only: true }, "done_by_person").changed, false);
});

test("standing: a widened setting whose window falls below its bar falls back", () => {
  const healthy = checkStanding({ setting: { step: "within_limits", practice_only: false }, decisions: decisions([["match", 95], ["diverge", 5]]), key: KEY, action: ACTION });
  assert.equal(healthy.changed, false);
  const slipping = checkStanding({ setting: { step: "within_limits", practice_only: false }, decisions: decisions([["match", 90], ["diverge", 10]]), key: KEY, action: ACTION });
  assert.equal(slipping.setting.step, "ask_first");
  assert.deepEqual(slipping.reasons, ["match share fell below the bar"]);
  const certified = checkStanding({ setting: { step: "review_regularly", practice_only: false }, decisions: decisions([["match", 650], ["diverge", 2]]), key: KEY, action: ACTION });
  assert.equal(certified.setting.step, "ask_first");
  assert.ok(certified.reasons.includes("error rate bound is above the target"));
});

test("a repeated decision counts once, and an unknown comparison reads as a divergence", () => {
  const one = decisions([["match", 1]])[0]!;
  const copies = Array.from({ length: 60 }, (_, i) => ({ ...one, sequence: i }));
  assert.equal(summarizeWindow(copies, KEY).counted, 1);
  const base = { current_step: "ask_first" as const, practice_only: false, key: KEY, action: ACTION, qualified: true };
  assert.equal(evaluatePromotion({ ...base, decisions: copies }).eligible, false);
  const odd = decisions([["match", 60]]).map((d, i) => (i < 5 ? { ...d, comparison: "Match" as Comparison } : d));
  const summary = summarizeWindow(odd, KEY);
  assert.equal(summary.diverges, 5);
  assert.equal(evaluatePromotion({ ...base, decisions: odd }).eligible, false);
  assert.throws(() => summarizeWindow(odd, KEY, { maxWindow: 0 }));
});

test("an invalid policy never widens a step", () => {
  const base = { current_step: "within_limits" as const, practice_only: false, key: KEY, action: ACTION, qualified: true, decisions: decisions([["match", 60]]) };
  const loose = { ...DEFAULT_AUTONOMY_POLICY, confidence: 0 };
  const verdict = evaluatePromotion({ ...base, policy: loose });
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blocked_by.some((reason) => reason.startsWith("invalid policy")));
  assert.equal(evaluatePromotion({ ...base, policy: { ...DEFAULT_AUTONOMY_POLICY, improvement_factor: 0.5 } }).eligible, false);
  assert.throws(() => errorRateUpperBound(10, 0, 1.5));
});

test("a practice-only setting that claims a widened step is narrowed, never kept", () => {
  const stray = applyDemotion({ step: "within_limits", practice_only: true }, "done_by_person");
  assert.equal(stray.setting.step, "ask_first");
  assert.equal(stray.changed, true);
  const standing = checkStanding({ setting: { step: "review_regularly", practice_only: true }, decisions: decisions([["match", 700]]), key: KEY, action: ACTION });
  assert.equal(standing.setting.step, "ask_first");
});

test("standing trips early on a bad start, on a catastrophe, and on a new policy version", () => {
  const early = checkStanding({ setting: { step: "within_limits", practice_only: false }, decisions: decisions([["match", 20], ["diverge", 20]]), key: KEY, action: ACTION });
  assert.equal(early.setting.step, "ask_first");
  const certified = checkStanding({ setting: { step: "review_regularly", practice_only: false }, decisions: decisions([["match", 95], ["diverge", 5]]), key: KEY, action: ACTION });
  assert.ok(certified.reasons.includes("error rate bound is above the target"));
  const withCatastrophe = decisions([["match", 60]]);
  withCatastrophe[3] = { ...withCatastrophe[3]!, catastrophe: true };
  const hit = checkStanding({ setting: { step: "within_limits", practice_only: false }, decisions: withCatastrophe, key: KEY, action: ACTION });
  assert.equal(hit.open_exception, true);
  const stale = checkStanding({ setting: { step: "within_limits", practice_only: false }, decisions: decisions([["match", 60]], { policy_version: "old" }), key: { ...KEY, policy_version: "old" }, action: ACTION });
  assert.ok(stale.reasons.includes("step policy version changed"));
});
