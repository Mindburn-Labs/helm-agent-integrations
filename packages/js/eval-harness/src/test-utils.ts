/** Shared fixtures: the example pack, routes, and scripted specialist and judge clients. */

import { fileURLToPath } from "node:url";
import { canonicalSha256, releaseSha256, sha256Hex } from "./canonical.js";
import { loadEvalPack, type LoadedPack, type LoadedSpecialist } from "./pack.js";
import { defaultProfile, type QualificationProfile } from "./qualification.js";
import type { JudgeClient, JudgeOutcome, SpecialistClient, SpecialistOutcome } from "./replay.js";
import type { JudgeRequest } from "./judge.js";
import { JUDGEMENT_SCHEMA, TRANSCRIPT_SCHEMA, type EvalCase, type Route, type Transcript } from "./types.js";

export const EXAMPLE_PACK_PATH = fileURLToPath(new URL("../examples/lead-concierge/pack.json", import.meta.url));

export function examplePack(): { pack: LoadedPack; specialist: LoadedSpecialist } {
  const pack = loadEvalPack(EXAMPLE_PACK_PATH);
  const specialist = pack.specialists[0];
  if (!specialist) throw new Error("example pack has no specialist");
  return { pack, specialist };
}

export const CLAUDE_ROUTE: Route = { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium", family: "claude" };
export const GPT_ROUTE: Route = { provider: "openai", model: "gpt-example", effort: "medium", family: "gpt" };
export const GEMINI_ROUTE: Route = { provider: "google", model: "gemini-example", effort: null, family: "gemini" };

export const PROMPT_SHA = sha256Hex("example specialist instructions");

export function exampleRelease(pack: LoadedPack): string {
  return releaseSha256({
    specialist_id: "lead_concierge",
    components: { catalog: pack.catalog_sha256, instructions: PROMPT_SHA, allowlist: canonicalSha256(pack.specialists[0]?.allowlist) },
  });
}

export function exampleProfile(): QualificationProfile {
  return defaultProfile([GPT_ROUTE, CLAUDE_ROUTE]);
}

function materialize(value: unknown): unknown {
  return value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value;
}

/** The transcript a specialist that does exactly what the case expects would produce. */
export function faithfulTranscript(evalCase: EvalCase, specialist: LoadedSpecialist, input: { repetition: number; route: Route; catalog_sha256: string; release_sha256: string }): Transcript {
  const maxClass = new Map(specialist.allowlist.actions.map((entry) => [entry.action_id, entry.max_class]));
  const expected = evalCase.expected;
  return {
    schema_version: TRANSCRIPT_SCHEMA,
    case_id: evalCase.id,
    repetition: input.repetition,
    specialist_id: specialist.specialist_id,
    route: input.route,
    prompt_sha256: PROMPT_SHA,
    catalog_sha256: input.catalog_sha256,
    release_sha256: input.release_sha256,
    decision: expected.decision,
    escalate_to: expected.escalate_to,
    tool_calls: expected.actions.map((action) => ({
      action_id: action.action_id,
      args: (materialize(action.args_must_include) as Record<string, unknown>) ?? {},
      class: maxClass.get(action.action_id) ?? "read",
    })),
    receipts: expected.receipt
      ? [{
          outcome: expected.receipt.outcome,
          did: "Read the inquiry and the lead, and prepared the next step.",
          needs_from_you: expected.receipt.needs_from_you,
          sources: expected.receipt.must_cite.map((cite) => (cite === "signal" ? `signal/${evalCase.id}` : cite)),
        }]
      : [],
    drafts: expected.draft
      ? [{ id: "d1", audience: expected.draft.audience, language: expected.draft.language, text: "Thank you for reaching out. This reply was prepared with AI, and a person can call you instead." }]
      : [],
    final_text: "Prepared the step for review.",
    error: null,
  };
}

type Script = (evalCase: EvalCase, repetition: number) => SpecialistOutcome | null;

/** A specialist client that answers faithfully unless `script` returns another outcome. */
export function scriptedSpecialist(pack: LoadedPack, specialist: LoadedSpecialist, route: Route, release: string, script?: Script): SpecialistClient & { calls: number } {
  const cases = new Map([...specialist.golden.cases, ...specialist.redteam.cases].map((c) => [c.id, c]));
  const client = {
    calls: 0,
    async run(input: { case_id: string; repetition: number }): Promise<SpecialistOutcome> {
      client.calls += 1;
      const evalCase = cases.get(input.case_id);
      if (!evalCase) throw new Error(`unknown case ${input.case_id}`);
      const custom = script?.(evalCase, input.repetition);
      if (custom) return custom;
      return { kind: "transcript", transcript: faithfulTranscript(evalCase, specialist, { repetition: input.repetition, route, catalog_sha256: pack.catalog_sha256, release_sha256: release }), cost_usd: 0.02 };
    },
  };
  return client;
}

type JudgeScript = (request: JudgeRequest, route: Route, attempt: number) => JudgeOutcome | null;

/** A judge that gives full marks with no catastrophe unless `script` answers otherwise. */
export function scriptedJudge(script?: JudgeScript): JudgeClient & { calls: number; routes: Route[] } {
  const attempts = new Map<string, number>();
  const judge = {
    calls: 0,
    routes: [] as Route[],
    async judge(request: JudgeRequest, route: Route): Promise<JudgeOutcome> {
      judge.calls += 1;
      judge.routes.push(route);
      const key = `${request.case_id}#${request.repetition}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      const custom = script?.(request, route, attempt);
      if (custom) return custom;
      return {
        kind: "judgement",
        cost_usd: 0.01,
        judgement: {
          schema_version: JUDGEMENT_SCHEMA,
          case_id: request.case_id,
          repetition: request.repetition,
          judge: route,
          scores: { decision: 1, actions: 1, receipt: 1, draft: 1, escalation: 1 },
          catastrophes: [],
          rationale: "Matches the case.",
        },
      };
    },
  };
  return judge;
}
