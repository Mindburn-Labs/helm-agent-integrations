/**
 * Replay runner.
 *
 * The runtime that hosts a specialist implements `SpecialistClient`: it loads
 * the specialist exactly as production does, on the route under test, serves
 * read actions from the case facts, and captures every other action without
 * executing it. The judge side implements `JudgeClient`. `runQualification`
 * owns the loop: repetitions, ceilings, abstention handling, hash checks,
 * judge selection and re-asks, scoring, and the report.
 */

import { classifyAbstention, checkCeiling, buildQualificationReport, validateProfile, type QualificationProfile, type QualificationReport, type UsageEntry } from "./qualification.js";
import { buildJudgeRequest, mergeJudgement, selectJudgeRoute, type JudgeRequest } from "./judge.js";
import { evaluateSuite, scoreRepetition, type RepetitionResult, type SuiteEvaluation } from "./scorer.js";
import { expectedCaseIds, validatePack, type LoadedPack, type LoadedSpecialist } from "./pack.js";
import { judgeDetectable } from "./validate.js";
import { parseCaseDuration, resolveTimeMarkers } from "./time.js";
import { TRANSCRIPT_SCHEMA, type CaseFact, type CaseSignal, type EvalCase, type Route, type Suite, type Transcript } from "./types.js";

export interface RunContext {
  case_id: string;
  /** The case clock as an ISO timestamp. */
  now: string;
  signal: CaseSignal & { at: string };
  /** Facts with markers resolved; anything not `owned` is data, never instruction. */
  facts: (CaseFact & { untrusted: boolean })[];
}

/** The context a specialist sees for one case: markers resolved, untrusted text labelled. */
export function buildRunContext(evalCase: EvalCase, clockMs: number, timeZone = "UTC"): RunContext {
  const at = (duration: string) => new Date(clockMs + parseCaseDuration(duration)).toISOString();
  return {
    case_id: evalCase.id,
    now: new Date(clockMs).toISOString(),
    signal: { ...evalCase.signal, at: at(evalCase.signal.at) },
    facts: evalCase.facts.map((fact) => ({
      ...fact,
      observed_at: at(fact.observed_at),
      data: resolveTimeMarkers(fact.data, clockMs, timeZone),
      untrusted: fact.trust !== "owned",
    })),
  };
}

/** Read actions are served from the case facts only; anything absent is not found. */
export function serveRead(context: RunContext, query: { kind?: string; fact_id?: string }): RunContext["facts"] {
  return context.facts.filter((fact) => (!query.kind || fact.kind === query.kind) && (!query.fact_id || fact.fact_id === query.fact_id));
}

export type SpecialistOutcome =
  | { kind: "transcript"; transcript: Transcript; cost_usd: number }
  | { kind: "abstain"; reason: string; cost_usd: number };

export interface SpecialistClient {
  run(input: { specialist_id: string; case_id: string; repetition: number; route: Route; context: RunContext }): Promise<SpecialistOutcome>;
}

export type JudgeOutcome = { kind: "judgement"; judgement: unknown; cost_usd: number } | { kind: "abstain"; reason: string; cost_usd: number };

export interface JudgeClient {
  judge(request: JudgeRequest, route: Route): Promise<JudgeOutcome>;
}

export interface RunOptions {
  pack: LoadedPack;
  specialist: LoadedSpecialist;
  route: Route;
  profile: QualificationProfile;
  /** Hashes of what the runner loaded; a repetition recorded under other hashes does not count. */
  release_sha256: string;
  prompt_sha256: string;
  client: SpecialistClient;
  judge: JudgeClient;
  instructions: string;
  clock_ms: number;
  ledger: UsageEntry[];
  now: () => number;
  /** Expected cost per call, checked against the ceilings before each call. */
  estimate_usd: { specialist: number; judge: number };
  /** Repetitions already scored at these hashes, from an earlier stage; they are not re-run. */
  resume?: RepetitionResult[];
}

export interface RunResult {
  status: "complete" | "paused" | "stopped";
  reason: string | null;
  results: RepetitionResult[];
  evaluation: SuiteEvaluation;
  report: QualificationReport;
}

function failedTranscript(evalCase: EvalCase, repetition: number, opts: RunOptions, error: string): Transcript {
  return {
    schema_version: TRANSCRIPT_SCHEMA,
    case_id: evalCase.id,
    repetition,
    specialist_id: opts.specialist.specialist_id,
    route: opts.route,
    prompt_sha256: opts.prompt_sha256,
    catalog_sha256: opts.pack.catalog_sha256,
    release_sha256: opts.release_sha256,
    decision: null,
    escalate_to: null,
    tool_calls: [],
    receipts: [],
    drafts: [],
    final_text: "",
    error,
  };
}

function sameRoute(a: Route | undefined, b: Route): boolean {
  return !!a && a.provider === b.provider && a.model === b.model && (a.effort ?? null) === (b.effort ?? null) && a.family === b.family;
}

function validCost(cost: unknown): cost is number {
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0;
}

export async function runQualification(opts: RunOptions): Promise<RunResult> {
  const { pack, specialist, profile } = opts;
  // A resumed repetition counts only when it ran as this release, prompt and route, and was
  // judged validly; one without a valid judgement runs again rather than staying stuck.
  const results: RepetitionResult[] = (opts.resume ?? []).filter(
    (result) =>
      result.judge_valid &&
      result.release_sha256 === opts.release_sha256 &&
      result.prompt_sha256 === opts.prompt_sha256 &&
      sameRoute(result.route, opts.route),
  );
  const done = new Set(results.map((result) => `${result.case_id}#${result.repetition}`));
  const detectable = judgeDetectable(pack.vocabulary, pack.action_catastrophes);
  const ctx = { catalog: pack.catalog, allowlist: specialist.allowlist, actionCatastrophes: pack.action_catastrophes };
  const judgeRoute = selectJudgeRoute(profile?.judge?.routes ?? [], opts.route, pack.manifest.case_author);
  const suites: [Suite, EvalCase[]][] = [
    ["golden", specialist.golden.cases],
    ["redteam", specialist.redteam.cases],
  ];

  const finish = (status: RunResult["status"], reason: string | null): RunResult => {
    const evaluation = evaluateSuite(results, specialist.rubric, expectedCaseIds(specialist));
    const report = buildQualificationReport({
      specialist_id: specialist.specialist_id,
      route: opts.route,
      judge_routes: judgeRoute ? [judgeRoute] : [],
      release_sha256: opts.release_sha256,
      prompt_sha256: opts.prompt_sha256,
      catalog_sha256: pack.catalog_sha256,
      rubric: specialist.rubric,
      evaluation,
    });
    return { status, reason, results, evaluation, report };
  };

  if (validateProfile(profile).length > 0) return finish("stopped", "invalid_profile");
  if (!pack.specialists.includes(specialist) || validatePack(pack, { repetitions: profile.repetitions, releaseBar: profile.release_bar }).length > 0) {
    return finish("stopped", "invalid_pack");
  }
  if (!judgeRoute) return finish("stopped", "no_independent_judge");
  if (specialist.rubric.repetitions !== profile.repetitions) return finish("stopped", "rubric_repetitions_differ_from_profile");

  const book = (kind: "specialist" | "judge", cost: unknown): boolean => {
    if (!validCost(cost)) return false;
    opts.ledger.push({ at_ms: opts.now(), kind, specialist_id: specialist.specialist_id, cost_usd: cost });
    return true;
  };

  for (const [suite, cases] of suites) {
    for (const evalCase of cases) {
      for (let repetition = 1; repetition <= profile.repetitions; repetition += 1) {
        if (done.has(`${evalCase.id}#${repetition}`)) continue;

        const allowed = checkCeiling(opts.ledger, { kind: "specialist", specialist_id: specialist.specialist_id, estimate_usd: opts.estimate_usd.specialist }, opts.now(), profile);
        if (!allowed.allowed) return finish("paused", allowed.reason);
        const context = buildRunContext(evalCase, opts.clock_ms, pack.manifest.time_zone);
        const outcome = await opts.client.run({ specialist_id: specialist.specialist_id, case_id: evalCase.id, repetition, route: opts.route, context });
        if (!book("specialist", outcome.cost_usd)) return finish("stopped", "invalid_usage");

        let transcript: Transcript;
        if (outcome.kind === "abstain") {
          const cls = classifyAbstention(outcome.reason, profile);
          if (cls === "pause") return finish("paused", outcome.reason);
          if (cls === "stop") return finish("stopped", outcome.reason);
          transcript = failedTranscript(evalCase, repetition, opts, outcome.reason);
        } else {
          transcript = outcome.transcript;
          const hashesMatch =
            transcript.prompt_sha256 === opts.prompt_sha256 &&
            transcript.catalog_sha256 === pack.catalog_sha256 &&
            transcript.release_sha256 === opts.release_sha256 &&
            sameRoute(transcript.route, opts.route);
          // A run under other hashes or on another route is not this release on this route: it is not recorded.
          if (!hashesMatch) continue;
        }

        const caps = scoreRepetition(evalCase, transcript, ctx);
        let merged: RepetitionResult | null = null;
        const claims = new Map<string, { id: string; evidence: string }>();
        for (let attempt = 1; attempt <= profile.judge.max_attempts; attempt += 1) {
          const judgeAllowed = checkCeiling(opts.ledger, { kind: "judge", specialist_id: specialist.specialist_id, estimate_usd: opts.estimate_usd.judge }, opts.now(), profile);
          if (!judgeAllowed.allowed) return finish("paused", judgeAllowed.reason);
          const request = buildJudgeRequest({ evalCase, suite, transcript, caps, rubric: specialist.rubric, vocabulary: pack.vocabulary, judgeDetectable: detectable, instructions: opts.instructions });
          const judged = await opts.judge.judge(request, judgeRoute);
          if (!book("judge", judged.cost_usd)) return finish("stopped", "invalid_usage");
          if (judged.kind === "abstain") {
            const cls = classifyAbstention(judged.reason, profile);
            if (cls === "pause") return finish("paused", judged.reason);
            if (cls === "stop") return finish("stopped", judged.reason);
            merged = mergeJudgement(caps, null, { suite, weights: specialist.rubric.weights, transcript, judge: judgeRoute, caseAuthor: pack.manifest.case_author, judgeDetectable: detectable });
            continue;
          }
          merged = mergeJudgement(caps, judged.judgement, { suite, weights: specialist.rubric.weights, transcript, judge: judgeRoute, caseAuthor: pack.manifest.case_author, judgeDetectable: detectable });
          for (const claim of merged.unverified_catastrophes) claims.set(claim.id, claim);
          if (merged.judge_valid) break;
        }
        if (merged) {
          // A claim a rejected answer made stays open unless a valid answer proved the same catastrophe.
          const proven = new Set(merged.catastrophes.map((hit) => hit.id));
          merged = { ...merged, unverified_catastrophes: [...claims.values()].filter((claim) => !proven.has(claim.id)) };
          results.push(merged);
          done.add(`${evalCase.id}#${repetition}`);
        }
      }
    }
  }
  return finish("complete", null);
}
