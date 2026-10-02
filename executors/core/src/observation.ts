// Turn a client hook envelope into the observation body. Schemas: schema/observe-input.schema.json and
// schema/observation.schema.json; CONTRACT.md section 5 is the spec.
// Data minimization: the body carries a digest and a short summary of the tool input (the shape of a Bash command,
// the path of a file tool), never the input itself, never tool output, prompts, the transcript, the environment or
// the working directory.

import { createHash } from "node:crypto";
import { ExecutorError } from "./errors.js";
import { redactSecrets } from "./redact.js";
import { commandShape } from "./shape.js";
import type { SlotState } from "./state.js";

export const OBSERVE_CLIENTS = ["claude-code", "codex"] as const;
export const OBSERVE_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "SessionStart", "SessionEnd"] as const;

export type ObserveClient = (typeof OBSERVE_CLIENTS)[number];
export type ObserveEvent = (typeof OBSERVE_EVENTS)[number];

const PHASE: Partial<Record<ObserveEvent, "before" | "after" | "failed">> = {
  PreToolUse: "before",
  PostToolUse: "after",
  PostToolUseFailure: "failed",
};

export interface Observation {
  schema: "helm.executor.observation/v1";
  coverage: "observed-only";
  client: ObserveClient;
  event: ObserveEvent;
  observed_at: string;
  episode_id: string;
  work_item_id: string;
  session_id: string;
  turn_id?: string;
  prompt_id?: string;
  agent_id?: string;
  agent_type?: string;
  permission_mode?: string;
  tool?: {
    name: string;
    use_id?: string;
    mcp_server?: string;
    phase: "before" | "after" | "failed";
    input_digest: string;
    input_summary?: string;
    duration_ms?: number;
  };
}

const MAX_SUMMARY = 256;
const PATH_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v !== "" ? v.slice(0, max) : undefined);

/** JSON with object keys sorted and no whitespace. Used only to digest tool input. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  if (isRecord(value)) {
    const members = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function inputDigest(toolInput: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(toolInput)).digest("hex")}`;
}

/** The deterministic key for one tool call's event, or undefined when the call has no id. */
export function idempotencyKey(episodeId: string, event: string, toolUseId: string | undefined): string | undefined {
  if (!toolUseId) return undefined;
  return `obs-${createHash("sha256").update(`${episodeId}|${event}|${toolUseId}`).digest("hex").slice(0, 32)}`;
}

function patchPaths(toolInput: unknown): string | undefined {
  const source = typeof toolInput === "string" ? toolInput : isRecord(toolInput) ? Object.values(toolInput).find((v): v is string => typeof v === "string" && v.includes("*** Begin Patch")) : undefined;
  if (!source) return undefined;
  const paths = [...source.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]?.trim() ?? "");
  return paths.length > 0 ? paths.join(", ") : undefined;
}

function relativeTo(path: string, cwd: unknown): string {
  if (typeof cwd !== "string" || cwd === "") return path;
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export function summarize(toolName: string, toolInput: unknown, cwd: unknown): string | undefined {
  const input = isRecord(toolInput) ? toolInput : undefined;
  let raw: string | undefined;
  if (toolName === "Bash") {
    // The shape of the command, never its arguments: a command line is where credentials get typed.
    raw = typeof input?.command === "string" ? commandShape(input.command) : undefined;
  } else if (PATH_TOOLS.has(toolName)) {
    const path = input?.file_path ?? input?.notebook_path ?? input?.path;
    raw = typeof path === "string" ? relativeTo(path, cwd) : undefined;
  } else if (toolName === "apply_patch") {
    raw = patchPaths(toolInput);
  }
  if (!raw) return undefined;
  const one = redactSecrets(raw).replace(/\s+/g, " ").trim();
  if (one === "") return undefined;
  return one.length > MAX_SUMMARY ? `${one.slice(0, MAX_SUMMARY - 1)}…` : one;
}

function mcpServer(toolName: string, envelope: Json): string | undefined {
  if (isRecord(envelope.mcp_server)) {
    const named = text(envelope.mcp_server.name, 128);
    if (named) return named;
  }
  const parsed = /^mcp__([A-Za-z0-9_-]+?)__.+$/.exec(toolName);
  return parsed?.[1]?.slice(0, 128);
}

export interface BuildArgs {
  client: ObserveClient;
  event: ObserveEvent;
  envelope: unknown;
  slot: SlotState;
  now: Date;
  summary: boolean;
}

export function buildObservation(args: BuildArgs): Observation {
  const { client, event, envelope, slot } = args;
  if (!isRecord(envelope)) throw new ExecutorError("rejected", "hook input is not a JSON object");
  const sessionId = text(envelope.session_id, 256);
  if (!sessionId) throw new ExecutorError("rejected", "hook input has no session_id");

  const observation: Observation = {
    schema: "helm.executor.observation/v1",
    coverage: "observed-only",
    client,
    event,
    observed_at: args.now.toISOString(),
    episode_id: slot.episode_id.slice(0, 128),
    work_item_id: slot.work_item_id.slice(0, 128),
    session_id: sessionId,
  };
  for (const [key, from] of [
    ["turn_id", "turn_id"],
    ["prompt_id", "prompt_id"],
    ["agent_id", "agent_id"],
    ["agent_type", "agent_type"],
    ["permission_mode", "permission_mode"],
  ] as const) {
    const value = text(envelope[from], key === "permission_mode" ? 64 : 256);
    if (value) observation[key] = value;
  }

  const phase = PHASE[event];
  if (phase) {
    const name = text(envelope.tool_name, 256);
    if (!name) throw new ExecutorError("rejected", "hook input has no tool_name");
    const tool: NonNullable<Observation["tool"]> = { name, phase, input_digest: inputDigest(envelope.tool_input) };
    const useId = text(envelope.tool_use_id, 256);
    if (useId) tool.use_id = useId;
    const server = mcpServer(name, envelope);
    if (server) tool.mcp_server = server;
    if (args.summary) {
      const summary = summarize(name, envelope.tool_input, envelope.cwd);
      if (summary) tool.input_summary = summary;
    }
    if (typeof envelope.duration_ms === "number" && Number.isInteger(envelope.duration_ms) && envelope.duration_ms >= 0) {
      tool.duration_ms = envelope.duration_ms;
    }
    observation.tool = tool;
  }
  return observation;
}
