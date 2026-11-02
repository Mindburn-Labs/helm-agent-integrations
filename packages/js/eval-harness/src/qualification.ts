/**
 * Qualification profile and report.
 *
 * A specialist release qualifies on one route at a time: its golden and
 * red-team suites, every case repeated `repetitions` times on that route,
 * judged by an independent family, meet the release bar. The profile fixes the
 * repetitions, the bar, the judge routes, how gateway abstentions are treated,
 * and the cost ceilings per rolling window. The report is what an owner reads
 * before recording a qualification; an incomplete suite records nothing.
 */

import { SHA256_HEX } from "./canonical.js";
import type { SuiteEvaluation } from "./scorer.js";
import { DEFAULT_RELEASE_BAR, MIN_REPETITIONS, barLoweredFields } from "./validate.js";
import { PROFILE_SCHEMA, RECORD_SCHEMA, REPORT_SCHEMA, type ReleaseBar, type Route, type Rubric } from "./types.js";

export interface Ceiling {
  calls: number;
  cost_usd: number;
  cost_usd_per_call: number;
}

export type AbstentionClass = "pause" | "stop" | "score";

export interface QualificationProfile {
  schema_version: typeof PROFILE_SCHEMA;
  repetitions: number;
  release_bar: ReleaseBar;
  judge: {
    /** Tried in order; the first independent of the run is used. Cover at least two families. */
    routes: Route[];
    max_attempts: number;
  };
  /**
   * Every abstention reason the gateway can return, classified once. `pause`
   * re-runs the repetition on resume, `stop` ends the run, and `score` makes a
   * failed repetition; only `invalid_output` may be scored. An unknown reason
   * stops the run.
   */
  abstentions: Record<AbstentionClass, string[]>;
  ceilings: {
    window_hours: number;
    specialist: Ceiling;
    judge: Ceiling;
    team: Ceiling;
  };
  /** Qualification books on its own ledger namespace, apart from production. */
  ledger: { namespace: string; per_stage: boolean; requires_run_tag: boolean };
}

export const DEFAULT_ABSTENTIONS: Readonly<Record<AbstentionClass, string[]>> = Object.freeze({
  pause: ["rate_limited", "provider_error", "call_ceiling", "cost_ceiling"],
  stop: ["auth_failed", "credential_missing", "provider_disabled", "kill_switch", "configuration_error", "ledger_unavailable", "model_mismatch", "aborted"],
  score: ["invalid_output"],
});

/** A profile without judge routes; a deployment supplies the routes it has. */
export function defaultProfile(judgeRoutes: Route[]): QualificationProfile {
  return {
    schema_version: PROFILE_SCHEMA,
    repetitions: 3,
    release_bar: { ...DEFAULT_RELEASE_BAR },
    judge: { routes: judgeRoutes, max_attempts: 2 },
    abstentions: {
      pause: [...DEFAULT_ABSTENTIONS.pause],
      stop: [...DEFAULT_ABSTENTIONS.stop],
      score: [...DEFAULT_ABSTENTIONS.score],
    },
    ceilings: {
      window_hours: 24,
      specialist: { calls: 600, cost_usd: 60, cost_usd_per_call: 1 },
      judge: { calls: 900, cost_usd: 40, cost_usd_per_call: 0.5 },
      team: { calls: 6000, cost_usd: 400, cost_usd_per_call: 1 },
    },
    ledger: { namespace: "eval", per_stage: true, requires_run_tag: true },
  };
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function validateProfile(profile: QualificationProfile): string[] {
  const problems: string[] = [];
  if (profile?.schema_version !== PROFILE_SCHEMA) return [`profile schema_version must be ${PROFILE_SCHEMA}`];
  if (!Number.isInteger(profile.repetitions) || profile.repetitions < MIN_REPETITIONS) problems.push(`repetitions must be an integer of at least ${MIN_REPETITIONS}`);
  const lowered = barLoweredFields(profile.release_bar, DEFAULT_RELEASE_BAR);
  if (lowered.length > 0) problems.push(`release_bar lowers ${lowered.join(", ")} below the default bar`);
  for (const key of ["golden_mean", "golden_case_median_floor", "redteam_mean"] as const) {
    const value = profile.release_bar?.[key];
    if (typeof value !== "number" || value > 1) problems.push(`release_bar.${key} must be in [0, 1]`);
  }
  const families = new Set((profile.judge?.routes ?? []).map((route) => route.family?.trim().toLowerCase()).filter(Boolean));
  if (families.size < 2) problems.push("judge routes must cover at least two model families, so every proposer has an independent judge");
  if (!Number.isInteger(profile.judge?.max_attempts) || profile.judge.max_attempts < 1) problems.push("judge.max_attempts must be a positive integer");
  const classified = new Map<string, AbstentionClass>();
  for (const cls of ["pause", "stop", "score"] as const) {
    for (const reason of profile.abstentions?.[cls] ?? []) {
      if (classified.has(reason)) problems.push(`abstention ${reason} is classified twice`);
      classified.set(reason, cls);
    }
  }
  const scored = profile.abstentions?.score ?? [];
  if (scored.length !== 1 || scored[0] !== "invalid_output") problems.push("only invalid_output may be scored as a failed repetition");
  const ceilings = profile.ceilings;
  if (!positive(ceilings?.window_hours)) problems.push("ceilings.window_hours must be positive");
  for (const scope of ["specialist", "judge", "team"] as const) {
    const ceiling = ceilings?.[scope];
    if (!ceiling || !positive(ceiling.calls) || !positive(ceiling.cost_usd) || !positive(ceiling.cost_usd_per_call)) {
      problems.push(`ceilings.${scope} needs positive calls, cost_usd and cost_usd_per_call`);
    }
  }
  if (ceilings && ceilings.team && ceilings.specialist && ceilings.team.cost_usd < ceilings.specialist.cost_usd) {
    problems.push("the team cost ceiling is below one specialist's");
  }
  if (!profile.ledger?.namespace || profile.ledger.namespace === "production" || !profile.ledger.per_stage || !profile.ledger.requires_run_tag) {
    problems.push("qualification books on an isolated, per-stage, tagged ledger namespace");
  }
  return problems;
}

/** How a gateway abstention is treated. Unknown reasons stop the run (fail closed). */
export function classifyAbstention(reason: string, profile: QualificationProfile): AbstentionClass {
  for (const cls of ["score", "pause", "stop"] as const) if (profile.abstentions[cls].includes(reason)) return cls;
  return "stop";
}

export interface UsageEntry {
  at_ms: number;
  kind: "specialist" | "judge";
  specialist_id: string;
  cost_usd: number;
}

export type CeilingCheck = { allowed: true } | { allowed: false; reason: "call_ceiling" | "cost_ceiling"; scope: "specialist" | "judge" | "team" | "per_call" | "ledger" };

/**
 * Whether one more call fits the rolling window. `estimate_usd` is the call's
 * expected cost; it is checked against the per-call cap and added to the
 * window's spend before comparing.
 */
export function checkCeiling(
  ledger: UsageEntry[],
  next: { kind: "specialist" | "judge"; specialist_id: string; estimate_usd: number },
  nowMs: number,
  profile: QualificationProfile,
): CeilingCheck {
  const ceilings = profile.ceilings;
  const scoped = next.kind === "judge" ? ceilings.judge : ceilings.specialist;
  if (!(next.estimate_usd >= 0) || next.estimate_usd > scoped.cost_usd_per_call) return { allowed: false, reason: "cost_ceiling", scope: "per_call" };
  // An entry that cannot be summed would make every comparison false: the ledger is unusable.
  if (!Number.isFinite(nowMs) || ledger.some((entry) => !Number.isFinite(entry?.at_ms) || !Number.isFinite(entry?.cost_usd) || entry.cost_usd < 0)) {
    return { allowed: false, reason: "cost_ceiling", scope: "ledger" };
  }
  const since = nowMs - ceilings.window_hours * 3_600_000;
  // Entries dated after now (clock skew) still count.
  const window = ledger.filter((entry) => entry.at_ms > since);
  const own = window.filter((entry) => entry.kind === next.kind && entry.specialist_id === next.specialist_id);
  const sum = (entries: UsageEntry[]) => entries.reduce((total, entry) => total + entry.cost_usd, 0);
  if (own.length + 1 > scoped.calls) return { allowed: false, reason: "call_ceiling", scope: next.kind };
  if (sum(own) + next.estimate_usd > scoped.cost_usd) return { allowed: false, reason: "cost_ceiling", scope: next.kind };
  if (window.length + 1 > ceilings.team.calls) return { allowed: false, reason: "call_ceiling", scope: "team" };
  if (sum(window) + next.estimate_usd > ceilings.team.cost_usd) return { allowed: false, reason: "cost_ceiling", scope: "team" };
  return { allowed: true };
}

export type Verdict = "qualified" | "not_qualified" | "incomplete";

export interface QualificationReport {
  schema_version: typeof REPORT_SCHEMA;
  specialist_id: string;
  route: Route;
  judge_routes: Route[];
  release_sha256: string;
  prompt_sha256: string;
  catalog_sha256: string;
  repetitions: number;
  pass_bar: ReleaseBar;
  verdict: Verdict;
  result: SuiteEvaluation;
  weakest_cases: { case_id: string; suite: string; mean: number; decisions: (0 | 1)[] }[];
}

export function buildQualificationReport(input: {
  specialist_id: string;
  route: Route;
  judge_routes: Route[];
  release_sha256: string;
  prompt_sha256: string;
  catalog_sha256: string;
  rubric: Rubric;
  evaluation: SuiteEvaluation;
}): QualificationReport {
  const evaluation = input.evaluation;
  const verdict: Verdict = !evaluation.complete ? "incomplete" : evaluation.passed ? "qualified" : "not_qualified";
  const weakest = [...evaluation.cases].sort((a, b) => a.mean - b.mean || a.case_id.localeCompare(b.case_id)).slice(0, 5);
  return {
    schema_version: REPORT_SCHEMA,
    specialist_id: input.specialist_id,
    route: input.route,
    judge_routes: input.judge_routes,
    release_sha256: input.release_sha256,
    prompt_sha256: input.prompt_sha256,
    catalog_sha256: input.catalog_sha256,
    repetitions: input.rubric.repetitions,
    pass_bar: input.rubric.pass_bar,
    verdict,
    result: evaluation,
    weakest_cases: weakest.map((c) => ({ case_id: c.case_id, suite: c.suite, mean: c.mean, decisions: c.decisions })),
  };
}

/**
 * What an owner records after reading a report: one row per (specialist,
 * route, release). Passing on one route qualifies no other. `sequence` orders
 * records for the same key; the store that keeps them assigns it.
 */
export interface QualificationRecord {
  schema_version: typeof RECORD_SCHEMA;
  qualification_id: string;
  specialist_id: string;
  route: { provider: string; model: string; effort: string | null };
  release_sha256: string;
  passed: boolean;
  /** SHA-256 of the written report file. */
  report_sha256: string;
  recorded_by: { role: "owner"; ref: string };
  sequence: number;
}

/** The record an owner would write for a report, or null when the suite is incomplete. */
export function recordFromReport(
  report: QualificationReport,
  input: { qualification_id: string; report_sha256: string; owner_ref: string; sequence: number },
): QualificationRecord | null {
  if (report.verdict === "incomplete") return null;
  if (!SHA256_HEX.test(input.report_sha256)) throw new Error("report_sha256 must be a lowercase SHA-256");
  return {
    schema_version: RECORD_SCHEMA,
    qualification_id: input.qualification_id,
    specialist_id: report.specialist_id,
    route: { provider: report.route.provider, model: report.route.model, effort: report.route.effort ?? null },
    release_sha256: report.release_sha256,
    passed: report.verdict === "qualified",
    report_sha256: input.report_sha256,
    recorded_by: { role: "owner", ref: input.owner_ref },
    sequence: input.sequence,
  };
}
