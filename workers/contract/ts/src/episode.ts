// The helm.episode.v1 payload: parsing, validation and the prompts derived from it.

import { EPISODE_MEDIA_TYPE, type ErrorCode, type ModelApi } from "./constants.js";
import { schemaIssues } from "./schemas.js";

export class EpisodeError extends Error {
  readonly issues: string[];
  constructor(
    readonly code: ErrorCode,
    message: string,
    issues: string[] = [],
  ) {
    super(message);
    this.name = "EpisodeError";
    this.issues = issues;
  }
}

export interface Seat {
  id: string;
  key: string;
  principalId: string;
  instructions: string;
  role: string;
  team: string;
}

export interface Episode {
  episodeId: string;
  workItemId: string;
  continuation: number;
  organizationId: string;
  organizationVersionId: string;
  seat: Seat;
  goal: string;
  context: Record<string, unknown>;
  acceptance: Record<string, unknown>;
  tools: { mcpUrl: string; allowed: string[] };
  model: { baseUrl: string; api: ModelApi; model: string; maxOutputTokens: number };
  budget: Record<string, unknown>;
  deadline: Date;
  credentialsEnv: string;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** Parse an RFC 3339 instant that carries a UTC offset (throws RangeError when malformed). */
export function parseRfc3339(value: string): Date {
  const text = value.trim();
  const parsed = RFC3339.test(text) ? new Date(text) : new Date(Number.NaN);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError(`not an RFC 3339 date-time with a UTC offset: ${JSON.stringify(value)}`);
  }
  return parsed;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Validate `value` against helm.episode.v1 and return the typed episode. Throws EpisodeError. */
export function parseEpisode(value: unknown): Episode {
  const issues = schemaIssues("episode.v1", value);
  if (issues.length > 0) {
    throw new EpisodeError("INVALID_EPISODE", "episode does not match helm.episode.v1", issues);
  }
  const raw = value as Json;
  let deadline: Date;
  try {
    deadline = parseRfc3339(raw.deadline);
  } catch (error) {
    throw new EpisodeError("INVALID_EPISODE", "episode deadline is not an RFC 3339 instant", [
      (error as Error).message,
    ]);
  }
  return {
    episodeId: raw.episode_id,
    workItemId: raw.work_item_id,
    continuation: raw.continuation ?? 0,
    organizationId: raw.organization?.id ?? "",
    organizationVersionId: raw.organization?.version_id ?? "",
    seat: {
      id: raw.seat.id,
      key: raw.seat.key,
      principalId: raw.seat.principal_id,
      instructions: raw.seat.instructions,
      role: raw.seat.role ?? "",
      team: raw.seat.team ?? "",
    },
    goal: raw.goal,
    context: raw.context ?? {},
    acceptance: raw.acceptance ?? {},
    tools: { mcpUrl: raw.tools.mcp_url, allowed: [...raw.tools.allowed] },
    model: {
      baseUrl: String(raw.model.base_url).replace(/\/+$/, ""),
      api: raw.model.api,
      model: raw.model.model,
      maxOutputTokens: raw.model.max_output_tokens,
    },
    budget: raw.budget ?? {},
    deadline,
    credentialsEnv: raw.credentials.env,
  };
}

/** The episode data part of a wire-format A2A message (`{parts: [...]}`), or undefined. */
export function findEpisodePart(parts: readonly Json[]): unknown {
  for (const part of parts) {
    if (part.mediaType === EPISODE_MEDIA_TYPE && "data" in part) return part.data;
  }
  return undefined;
}

/** Extract and parse the episode from a wire-format A2A message. */
export function episodeFromMessage(message: { parts?: readonly Json[] }): Episode {
  const raw = findEpisodePart(message.parts ?? []);
  if (raw === undefined) {
    throw new EpisodeError("INVALID_EPISODE", `message has no ${EPISODE_MEDIA_TYPE} data part`);
  }
  return parseEpisode(raw);
}

/** Throw EpisodeError(UNSUPPORTED_MODEL_API) unless the adapter can speak episode.model.api. */
export function requireSupportedApi(episode: Episode, supported: readonly string[]): void {
  if (!supported.includes(episode.model.api)) {
    throw new EpisodeError(
      "UNSUPPORTED_MODEL_API",
      `this worker supports ${supported.join(", ")}; the episode asks for ${episode.model.api}`,
    );
  }
}

// Python's json.dumps(sort_keys=True, separators=(",", ":")), so both languages render alike.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Json)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function utcSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

/** The system prompt and first user message every adapter gives its model. */
export function buildPrompts(episode: Episode): { system: string; user: string } {
  let who = `seat "${episode.seat.key}"`;
  if (episode.seat.role) {
    who += ` (${episode.seat.role}`;
    who += episode.seat.team ? `, team ${episode.seat.team})` : ")";
  }
  const system = [
    `You are the agent for ${who} in a HELM organization.`,
    "",
    episode.seat.instructions.trim(),
    "",
    "Rules:",
    "- You act only through the tools provided. They are the only way to read or change anything.",
    '- Every tool call is a proposal to the HELM gateway. When a tool returns status "escalated", ' +
      "a human must decide first: stop, and do not retry, work around it, or call other tools.",
    "- When your work is finished, or you cannot continue, call helm_work_report exactly once " +
      "with status done, blocked or failed and a short summary. The episode is not complete until you do.",
    `- Finish before ${utcSeconds(episode.deadline)}.`,
  ]
    .join("\n")
    .trim();

  const user = ["Goal:", episode.goal.trim()];
  const brief = String(episode.context.brief ?? "").trim();
  if (brief) user.push("", "Brief:", brief);
  const criteria = String(episode.acceptance.criteria ?? "").trim();
  if (criteria) user.push("", "Acceptance criteria:", criteria);
  const required = (episode.acceptance.required_effects as string[] | undefined) ?? [];
  if (required.length > 0) user.push("", `Required effects: ${required.join(", ")}`);
  for (const [key, title] of [
    ["prior_episodes", "Earlier episodes"],
    ["attempt_results", "Results of earlier attempts"],
    ["children", "Delegated work"],
  ] as const) {
    const items = (episode.context[key] as unknown[] | undefined) ?? [];
    if (items.length > 0) user.push("", `${title}:`, canonicalJson(items));
  }
  return { system, user: user.join("\n") };
}
