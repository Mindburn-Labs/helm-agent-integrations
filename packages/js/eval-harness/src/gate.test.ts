/** Route gate: fail closed until an owner-recorded, passed qualification names the exact route and release. */

import test from "node:test";
import assert from "node:assert/strict";
import { governingRecord, selectQualifiedRoute, verifyClose } from "./gate.js";
import type { QualificationRecord } from "./qualification.js";
import { CLAUDE_ROUTE, GEMINI_ROUTE, GPT_ROUTE } from "./test-utils.js";
import { RECORD_SCHEMA, type Route } from "./types.js";

const RELEASE = "1".repeat(64);

function record(route: Route, overrides: Partial<QualificationRecord> = {}): QualificationRecord {
  return {
    schema_version: RECORD_SCHEMA,
    qualification_id: `q-${route.family}`,
    specialist_id: "lead_concierge",
    route: { provider: route.provider, model: route.model, effort: route.effort ?? null },
    release_sha256: RELEASE,
    passed: true,
    report_sha256: "2".repeat(64),
    recorded_by: { role: "owner", ref: "person:owner-1" },
    sequence: 1,
    ...overrides,
  };
}

const base = { specialist_id: "lead_concierge", release_sha256: RELEASE, run_class: "live" as const, primary: CLAUDE_ROUTE };

test("eval and synthetic runs need no qualification", () => {
  for (const run_class of ["eval", "synthetic"] as const) {
    const result = selectQualifiedRoute({ ...base, run_class, qualifications: [] });
    assert.equal(result.allowed, true);
  }
});

test("live and shadow runs abstain no_qualified_route without a passed owner record", () => {
  for (const run_class of ["live", "shadow"] as const) {
    assert.equal(selectQualifiedRoute({ ...base, run_class, qualifications: [] }).allowed, false);
  }
  assert.equal(selectQualifiedRoute({ ...base, qualifications: [record(CLAUDE_ROUTE, { passed: false })] }).allowed, false);
  assert.equal(selectQualifiedRoute({ ...base, qualifications: [record(CLAUDE_ROUTE, { recorded_by: { role: "staff" as "owner", ref: "person:x" } })] }).allowed, false);
  assert.equal(selectQualifiedRoute({ ...base, qualifications: [record(CLAUDE_ROUTE, { report_sha256: "nope" })] }).allowed, false);
  assert.equal(selectQualifiedRoute({ ...base, release_sha256: null, qualifications: [record(CLAUDE_ROUTE)] }).allowed, false);
  assert.equal(selectQualifiedRoute({ ...base, run_class: "production" as "live", qualifications: [record(CLAUDE_ROUTE)] }).allowed, false);
  assert.equal(selectQualifiedRoute({ ...base, qualifications: [record(CLAUDE_ROUTE)] }).allowed, true);
});

test("an unqualified primary is not rescued by a qualified fallback; unqualified fallbacks are dropped", () => {
  const primaryMissing = selectQualifiedRoute({ ...base, fallbacks: [GPT_ROUTE], qualifications: [record(GPT_ROUTE)] });
  assert.equal(primaryMissing.allowed, false);
  const mixed = selectQualifiedRoute({ ...base, fallbacks: [GPT_ROUTE, GEMINI_ROUTE], qualifications: [record(CLAUDE_ROUTE), record(GEMINI_ROUTE)] });
  assert.equal(mixed.allowed, true);
  if (mixed.allowed) assert.deepEqual(mixed.fallbacks.map((hop) => hop.route.family), ["gemini"]);
});

test("an audit run skips routes of the family it reviews", () => {
  const audit = selectQualifiedRoute({ ...base, primary: GPT_ROUTE, fallbacks: [CLAUDE_ROUTE], reviewed_family: "gpt", qualifications: [record(GPT_ROUTE), record(CLAUDE_ROUTE)] });
  assert.equal(audit.allowed, false, "an auditor of the reviewed family never runs");
});

test("the latest record governs, and a tie at the top resolves to the failure", () => {
  const passed = record(CLAUDE_ROUTE, { sequence: 1 });
  const failed = record(CLAUDE_ROUTE, { qualification_id: "q-f", passed: false, sequence: 2 });
  const requalified = record(CLAUDE_ROUTE, { qualification_id: "q-r", sequence: 3 });
  assert.equal(governingRecord([passed, failed], "lead_concierge", CLAUDE_ROUTE, RELEASE)?.passed, false);
  assert.equal(governingRecord([passed, failed, requalified], "lead_concierge", CLAUDE_ROUTE, RELEASE)?.qualification_id, "q-r");
  const tie = record(CLAUDE_ROUTE, { qualification_id: "q-t", passed: false, sequence: 3 });
  assert.equal(governingRecord([requalified, tie], "lead_concierge", CLAUDE_ROUTE, RELEASE)?.passed, false);
});

test("at close, output is kept only under the governing passed record it names", () => {
  const passed = record(CLAUDE_ROUTE);
  const close = { specialist_id: "lead_concierge", release_sha256: RELEASE, run_class: "live" as const, route: CLAUDE_ROUTE, qualifications: [passed] };
  assert.deepEqual(verifyClose({ ...close, qualification_ref: "q-claude" }), { keep: true });
  assert.equal(verifyClose({ ...close, qualification_ref: null }).keep, false);
  assert.equal(verifyClose({ ...close, qualification_ref: "q-other" }).keep, false);
  assert.equal(verifyClose({ ...close, route: { ...CLAUDE_ROUTE, effort: "high" }, qualification_ref: "q-claude" }).keep, false);
  assert.equal(verifyClose({ ...close, run_class: "eval", qualification_ref: null }).keep, true);
});

test("a malformed record that claims the key governs as a failure", () => {
  const passed = record(CLAUDE_ROUTE, { sequence: 1 });
  const broken = record(CLAUDE_ROUTE, { qualification_id: "q-b", passed: false, sequence: 2, report_sha256: "short" });
  const result = selectQualifiedRoute({ ...base, qualifications: [passed, broken] });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.skipped, [{ route: CLAUDE_ROUTE, reason: "malformed_record" }]);
  assert.equal(governingRecord([passed, broken], "lead_concierge", CLAUDE_ROUTE, RELEASE), null);
  assert.equal(verifyClose({ specialist_id: "lead_concierge", release_sha256: RELEASE, run_class: "live", route: CLAUDE_ROUTE, qualification_ref: "q-claude", qualifications: [passed, broken] }).keep, false);
  const otherKey = record(GPT_ROUTE, { report_sha256: "short" });
  assert.equal(selectQualifiedRoute({ ...base, qualifications: [passed, otherKey] }).allowed, true, "a broken record for another route does not touch this one");
});
