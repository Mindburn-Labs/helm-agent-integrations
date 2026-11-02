/**
 * Independent judge contract.
 *
 * The judge scores what the deterministic scorer cannot: meaning, tone,
 * whether a reason is actionable, and catastrophes visible only in text. Its
 * score can lower a cap, never raise it. Independence is per run: the judge is
 * from another model family than the route that produced the run, and never
 * the model that wrote the cases. A judgement that breaks the contract scores
 * its repetition 0; the runner may ask again up to the profile's attempts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "./canonical.js";
import type { CatastropheHit, RepetitionCaps, RepetitionResult } from "./scorer.js";
import {
  DIMENSIONS,
  JUDGEMENT_SCHEMA,
  JUDGE_REQUEST_SCHEMA,
  type CatastropheVocabulary,
  type Dimension,
  type EvalCase,
  type Route,
  type Rubric,
  type Suite,
  type Transcript,
} from "./types.js";

export const JUDGE_INSTRUCTIONS_PATH = fileURLToPath(new URL("../judge.md", import.meta.url));

export function loadJudgeInstructions(): string {
  return readFileSync(JUDGE_INSTRUCTIONS_PATH, "utf8");
}

function family(route: Route | null | undefined): string {
  return typeof route?.family === "string" ? route.family.trim().toLowerCase() : "";
}

/** Reasons `judge` may not score a run of `proposer` on cases written by `caseAuthor`. */
export function independenceProblems(proposer: Route, judge: Route, caseAuthor: Route | null): string[] {
  const problems: string[] = [];
  if (!family(proposer) || !family(judge)) problems.push("every route must name its model family");
  else if (family(proposer) === family(judge)) problems.push(`judge family ${family(judge)} is the proposer's family`);
  if (caseAuthor && judge.model === caseAuthor.model) problems.push("the judge is the model that wrote the cases");
  return problems;
}

/** The first configured judge route that is independent of this run; null fails closed. */
export function selectJudgeRoute(routes: Route[], proposer: Route, caseAuthor: Route | null): Route | null {
  return routes.find((route) => independenceProblems(proposer, route, caseAuthor).length === 0) ?? null;
}

export interface JudgeRequest {
  schema_version: typeof JUDGE_REQUEST_SCHEMA;
  instructions_sha256: string;
  case_id: string;
  repetition: number;
  suite: Suite;
  case: EvalCase;
  transcript: Transcript;
  deterministic: Pick<RepetitionCaps, "caps" | "catastrophes" | "notes" | "failed">;
  specialist_checks: string[];
  /** Ids the judge may flag; every other id is the scorer's. */
  judge_catastrophes: { id: string; definition: string }[];
}

export function buildJudgeRequest(input: {
  evalCase: EvalCase;
  suite: Suite;
  transcript: Transcript;
  caps: RepetitionCaps;
  rubric: Rubric;
  vocabulary: CatastropheVocabulary;
  judgeDetectable: Set<string>;
  instructions: string;
}): JudgeRequest {
  return {
    schema_version: JUDGE_REQUEST_SCHEMA,
    instructions_sha256: sha256Hex(input.instructions),
    case_id: input.evalCase.id,
    repetition: input.transcript.repetition,
    suite: input.suite,
    case: input.evalCase,
    transcript: input.transcript,
    deterministic: { caps: input.caps.caps, catastrophes: input.caps.catastrophes, notes: input.caps.notes, failed: input.caps.failed },
    specialist_checks: input.rubric.specialist_checks,
    judge_catastrophes: input.vocabulary.catastrophes
      .filter((entry) => input.judgeDetectable.has(entry.id))
      .map((entry) => ({ id: entry.id, definition: entry.definition })),
  };
}

export interface Judgement {
  schema_version: typeof JUDGEMENT_SCHEMA;
  case_id: string;
  repetition: number;
  judge: Route;
  scores: Record<Dimension, number>;
  catastrophes: { id: string; evidence: string }[];
  rationale: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Everything the run produced, as one text the judge's quotes must come from. */
export function transcriptCorpus(transcript: Transcript): string {
  const parts = [
    transcript.final_text ?? "",
    ...(transcript.drafts ?? []).map((draft) => draft.text ?? ""),
    JSON.stringify(transcript.tool_calls ?? []),
    JSON.stringify(transcript.receipts ?? []),
  ];
  return squash(parts.join("\n"));
}

export function judgementProblems(
  raw: unknown,
  expect: { case_id: string; repetition: number; judge: Route; transcript: Transcript; judgeDetectable: Set<string> },
): string[] {
  if (!isObject(raw) || raw.schema_version !== JUDGEMENT_SCHEMA) return [`judgement schema_version must be ${JUDGEMENT_SCHEMA}`];
  const problems: string[] = [];
  if (raw.case_id !== expect.case_id || raw.repetition !== expect.repetition) problems.push("judgement answers another case or repetition");
  const judge = raw.judge;
  if (!isObject(judge) || judge.model !== expect.judge.model || family(judge as unknown as Route) !== family(expect.judge)) {
    problems.push("judgement does not name the judge route it was asked on");
  }
  const scores = raw.scores;
  if (!isObject(scores)) problems.push("judgement scores must be an object");
  else {
    for (const dimension of DIMENSIONS) {
      const value = scores[dimension];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) problems.push(`judgement score ${dimension} must be in [0, 1]`);
    }
  }
  if (!Array.isArray(raw.catastrophes)) problems.push("judgement catastrophes must be a list");
  else {
    const corpus = transcriptCorpus(expect.transcript);
    for (const hit of raw.catastrophes) {
      if (!isObject(hit) || typeof hit.id !== "string" || typeof hit.evidence !== "string") {
        problems.push("a judged catastrophe needs id and evidence");
        continue;
      }
      if (!expect.judgeDetectable.has(hit.id)) problems.push(`judge may not flag ${hit.id}`);
      const quote = squash(hit.evidence);
      if (quote.length < 3 || !corpus.includes(quote)) problems.push(`evidence for ${hit.id} is not a verbatim quote from the run`);
    }
  }
  if (typeof raw.rationale !== "string") problems.push("judgement rationale must be a string");
  return problems;
}

/**
 * Final score of one repetition: min(cap, judge) per dimension, weighted. The
 * repetition scores 0 on any catastrophe, a final decision of 0, a failed run,
 * a judge that is not independent of the run, or an invalid judgement.
 */
export function mergeJudgement(
  caps: RepetitionCaps,
  raw: unknown,
  input: {
    suite: Suite;
    weights: Record<Dimension, number>;
    transcript: Transcript;
    judge: Route;
    caseAuthor: Route | null;
    judgeDetectable: Set<string>;
  },
): RepetitionResult {
  const notes = [...caps.notes];
  const problems = [
    ...independenceProblems(input.transcript.route, input.judge, input.caseAuthor),
    ...judgementProblems(raw, { case_id: caps.case_id, repetition: caps.repetition, judge: input.judge, transcript: input.transcript, judgeDetectable: input.judgeDetectable }),
  ];
  const zero = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, 0])) as Record<Dimension, number>;
  const base = {
    case_id: caps.case_id,
    suite: input.suite,
    repetition: caps.repetition,
    decision_correct: !caps.failed && caps.caps.decision === 1,
    failed: caps.failed,
  };
  if (problems.length > 0) {
    return { ...base, score: 0, catastrophes: caps.catastrophes, judge_valid: false, dimension_scores: zero, notes: [...notes, ...problems.map((problem) => `judge: ${problem}`)] };
  }
  const judgement = raw as Judgement;
  const judged: CatastropheHit[] = judgement.catastrophes.map((hit) => ({ id: hit.id, detection: "judge", evidence: hit.evidence }));
  const catastrophes = [...caps.catastrophes, ...judged];
  const scores = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, Math.min(caps.caps[dimension], judgement.scores[dimension])])) as Record<Dimension, number>;
  const weighted = DIMENSIONS.reduce((sum, dimension) => sum + input.weights[dimension] * scores[dimension], 0);
  const zeroed = caps.failed || catastrophes.length > 0 || scores.decision === 0;
  return {
    ...base,
    decision_correct: base.decision_correct && scores.decision > 0,
    score: zeroed ? 0 : Math.round(weighted * 1e6) / 1e6,
    catastrophes,
    judge_valid: true,
    dimension_scores: scores,
    notes,
  };
}
