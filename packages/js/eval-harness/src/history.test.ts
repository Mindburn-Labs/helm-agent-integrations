/** History guard rails: classification by name, scrubbing, the prompt guard, point in time, aggregates. */

import test from "node:test";
import assert from "node:assert/strict";
import { createPromptGuard, createPseudonymizer, evaluateHistoryBars, pointInTime, publishShare, scrubText, unclassifiedFields, wilsonInterval } from "./history.js";

test("an unclassified export field stops the build and is reported by name only", () => {
  const classification = { record_types: { contact: { id: "identifier" as const, display_name: "identifier" as const, notes: "free_text" as const } }, never_copied: ["custom_*", "status"] };
  const record = { id: "c-1", display_name: "Robin Example", notes: "x", custom_color: "red", status: "won", spouse_name: "Kim Example" };
  const missing = unclassifiedFields("contact", record, classification);
  assert.deepEqual(missing, ["spouse_name"]);
  assert.ok(!JSON.stringify(missing).includes("Kim"));
  assert.deepEqual(unclassifiedFields("invoice", { total: 1 }, classification), ["total"]);
});

test("pseudonyms are stable, letters only, and keyed by the salt", () => {
  const a = createPseudonymizer("salt-one-salt-one");
  const b = createPseudonymizer("salt-two-salt-two");
  assert.equal(a("person", "Robin Example"), a("person", " robin example "));
  assert.notEqual(a("person", "Robin Example"), b("person", "Robin Example"));
  assert.match(a("person", "Robin Example"), /^person [a-z]{10}$/);
  assert.throws(() => createPseudonymizer("short"));
});

test("scrubbing removes dictionary values in any form and detectable patterns", () => {
  const result = scrubText("Robin's furnace: call (000) 555-0142 or robin@example.invalid before 2031-04-02. Ask the Robins.", { dictionary: ["Robin"] });
  assert.equal(result.text, "[redacted] furnace: call [redacted] or [redacted] before [redacted]. Ask the [redacted].");
  assert.deepEqual(result.patterns.sort(), ["date", "email", "phone"]);
});

test("text with a word outside the vocabulary is dropped, not passed", () => {
  const ordinary = new Set(["my", "husband", "will", "call", "about", "the", "leak"]);
  const kept = scrubText("Will call about the leak", { dictionary: [], isOrdinaryWord: (word) => ordinary.has(word.toLowerCase()) });
  assert.equal(kept.text, "Will call about the leak");
  const dropped = scrubText("my husband Bob will call", { dictionary: [], isOrdinaryWord: (word) => ordinary.has(word.toLowerCase()) });
  assert.equal(dropped.text, null);
});

test("the prompt guard refuses any original identifier or pattern, naming kinds not values", () => {
  const guard = createPromptGuard(["Robin Example", "12 Elm Row"]);
  assert.deepEqual(guard("lead person qwertyuiop asked about a leak"), { ok: true });
  const refused = guard("Contact ROBIN EXAMPLE at 12 elm row, robin@example.invalid");
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.deepEqual(refused.violations, ["dictionary_value x2", "email x1"]);
    assert.ok(!refused.violations.join(" ").toLowerCase().includes("robin"));
  }
});

test("a case holds only what was known at decision time, as offsets from it", () => {
  const decision = 1_000_000_000;
  const facts = pointInTime(
    [
      { id: "a", recorded_at_ms: decision - 3_600_000 },
      { id: "b", recorded_at_ms: decision },
      { id: "c", recorded_at_ms: decision + 1 },
    ],
    decision,
  );
  assert.deepEqual(facts, [
    { id: "a", observed_at: "-PT1H" },
    { id: "b", observed_at: "PT0M" },
  ]);
});

test("only aggregates are published, and small cells are suppressed", () => {
  assert.deepEqual(publishShare(2, 4), { n: 4, suppressed: true });
  assert.deepEqual(publishShare(3, 40), { n: 40, suppressed: true });
  assert.deepEqual(publishShare(38, 40), { n: 40, suppressed: true });
  const share = publishShare(20, 40);
  assert.equal(share.suppressed, false);
  assert.equal(share.value, 0.5);
  const interval = wilsonInterval(20, 40);
  assert.ok(interval.low > 0.34 && interval.low < 0.36 && interval.high > 0.64 && interval.high < 0.66);
});

test("history bars: a missed gating bar fails, too few records read insufficient, advisory bars only report", () => {
  const bars = [
    { metric: "auc", min: 0.7, gating: true },
    { metric: "dropped_share", max: 0.1, gating: false, min_n: 30 },
  ];
  const met = evaluateHistoryBars({ auc: { value: 0.75, n: 80 }, dropped_share: { value: 0.2, n: 12 } }, bars);
  assert.deepEqual(met.results.map((result) => result.status), ["met", "insufficient"]);
  assert.equal(met.gating_missed, false);
  const missed = evaluateHistoryBars({ auc: { value: 0.6, n: 80 } }, bars);
  assert.equal(missed.gating_missed, true);
  assert.equal(evaluateHistoryBars({}, [{ metric: "x", min: 1, gating: false }]).advisory, true);
});

test("matching survives plurals, odd whitespace, invisible characters and prototype names", () => {
  const guard = createPromptGuard(["Smith", "12 Elm Row"]);
  assert.equal(guard("The Smiths called").ok, false);
  assert.equal(guard("lives at 12  Elm\nRow").ok, false);
  assert.equal(guard("Sm​ith called").ok, false);
  assert.equal(scrubText("Sm​ith called", { dictionary: ["Smith"] }).text, "[redacted] called");
  const dates = scrubText("seen 3 March 2031 and March 3, 2031 and 2031/04/02 at the market", { dictionary: [] });
  assert.equal(dates.text, "seen [redacted] and [redacted] and [redacted] at the market");
  const classification = { record_types: { contact: { id: "identifier" as const } }, never_copied: [] };
  assert.deepEqual(unclassifiedFields("contact", { id: "c", constructor: "x", toString: "y" }, classification), ["constructor", "toString"]);
  assert.deepEqual(unclassifiedFields("constructor", { id: "c" }, classification), ["id"]);
  assert.throws(() => unclassifiedFields("contact", { id: "c" }, { ...classification, never_copied: ["*"] }));
});

test("a gating bar without enough records is reported as open, and a bar needs a bound", () => {
  const open = evaluateHistoryBars({ auc: { value: 0.9, n: 3 } }, [{ metric: "auc", min: 0.7, gating: true }]);
  assert.equal(open.gating_missed, false);
  assert.equal(open.gating_insufficient, true);
  assert.throws(() => evaluateHistoryBars({}, [{ metric: "auc", gating: true }]));
});
