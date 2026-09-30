// What the agent's tool calls mean for the episode.
//
// The rules here are the worker half of the contract and are identical in every adapter:
//
//  * a tool result {status: "escalated", attempt_id} parks the episode (INPUT_REQUIRED, attempts);
//  * an applied helm_work_report ends it (COMPLETED);
//  * a successful helm_work_delegate / helm_work_request_input parks it on children / input;
//  * ending without an applied report is FAILED (NO_REPORT).
//
// Adapters feed every MCP tool result to OutcomeTracker.observe and stop their agent loop when
// the returned observation says so.

import {
  DELEGATE_TOOL,
  PROPOSAL_SCHEMA,
  REPORT_SCHEMA,
  REPORT_TOOL,
  REQUEST_INPUT_TOOL,
} from "./constants.js";
import { statusPayload, type ReportSummary, type StatusPayload, type WaitingOn } from "./status.js";

export type Kind = "ok" | "error" | "escalated";
export type StopReason = "escalated" | "reported" | "delegated" | "input_requested";

/** An MCP tool result reduced to what the rules need. */
export interface ToolResult {
  isError?: boolean;
  structured?: unknown;
  text?: string | null;
}

export interface Observation {
  kind: Kind;
  /** True when the agent loop must stop now (after the current tool batch, where grouped). */
  stop: boolean;
  reason?: StopReason;
  /** helm.proposal.v1 mirror of this call (absent for helm_work_report). */
  proposal?: Record<string, unknown>;
  /** helm.report.v1 mirror when this call was helm_work_report. */
  report?: Record<string, unknown>;
}

export interface Outcome {
  state: "completed" | "input_required" | "failed";
  text: string;
  status: StatusPayload;
}

// Result statuses that mean the effect did not happen, even when the tool call itself succeeded.
const NOT_APPLIED = new Set([
  "denied",
  "failed",
  "error",
  "rejected",
  "unknown",
  "escalated",
  "expired",
  "cancelled",
  "canceled",
]);
const CHILD_ID_KEYS = ["work_id", "child_id", "work_item_id", "id"] as const;
const REPORT_STATUSES = ["done", "blocked", "failed"] as const;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The result as a JSON object: structuredContent, else the text content parsed as JSON. */
export function resultPayload(result: ToolResult): Json | null {
  if (isObject(result.structured)) return result.structured;
  const text = (result.text ?? "").trim();
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isObject(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

function lowerStatus(payload: Json | null): string | null {
  const value = payload?.status;
  return typeof value === "string" ? value.toLowerCase() : null;
}

function childId(payload: Json | null): string | null {
  if (!payload) return null;
  for (const source of [payload, payload.child, payload.result]) {
    if (!isObject(source)) continue;
    for (const key of CHILD_ID_KEYS) {
      const value = source[key];
      if (typeof value === "string" && value) return value;
    }
  }
  return null;
}

export class OutcomeTracker {
  readonly attempts: string[] = [];
  readonly children: string[] = [];
  delegated = false;
  input: { question: string; options: string[] } | null = null;
  report: ReportSummary | null = null;

  get stopped(): boolean {
    return this.attempts.length > 0 || this.delegated || this.input !== null || this.report !== null;
  }

  observe(tool: string, argumentsValue: unknown, result: ToolResult): Observation {
    const args: Json = isObject(argumentsValue) ? argumentsValue : {};
    const payload = resultPayload(result);
    const status = lowerStatus(payload);
    const attemptId = payload?.attempt_id;

    let kind: Kind;
    if (status === "escalated" && typeof attemptId === "string" && attemptId) kind = "escalated";
    else if (result.isError || (status !== null && NOT_APPLIED.has(status))) kind = "error";
    else kind = "ok";

    if (kind === "escalated") {
      const id = attemptId as string;
      if (!this.attempts.includes(id)) this.attempts.push(id);
      return { kind, stop: true, reason: "escalated", proposal: proposal(tool, args, kind, id) };
    }

    if (tool === REPORT_TOOL) {
      const mirror = reportMirror(args);
      if (kind === "ok" && mirror) {
        this.report = { status: mirror.status as ReportSummary["status"], summary: mirror.summary as string };
        return { kind, stop: true, reason: "reported", report: mirror };
      }
      return { kind, stop: false, ...(mirror ? { report: mirror } : {}) };
    }

    let stop = false;
    let reason: StopReason | undefined;
    if (kind === "ok" && tool === DELEGATE_TOOL) {
      const child = childId(payload);
      if (child && !this.children.includes(child)) this.children.push(child);
      this.delegated = true;
      stop = true;
      reason = "delegated";
    } else if (kind === "ok" && tool === REQUEST_INPUT_TOOL) {
      const question = String(args.question ?? "").trim() || "input requested";
      const options = Array.isArray(args.options) ? args.options.map(String) : [];
      this.input = { question, options };
      stop = true;
      reason = "input_requested";
    }
    return { kind, stop, ...(reason ? { reason } : {}), proposal: proposal(tool, args, kind) };
  }

  /**
   * The terminal A2A state for a loop that ended normally.
   *
   * Escalated attempts always win: an approval must never be dropped. Then an applied report
   * completes the episode; then children / input park it; otherwise the report is missing.
   */
  outcome(lastText = ""): Outcome {
    if (this.attempts.length > 0) {
      const waitingOn: WaitingOn = { attempts: [...this.attempts] };
      if (this.delegated) waitingOn.children = [...this.children];
      if (this.input) waitingOn.input = this.input;
      return {
        state: "input_required",
        text: `Waiting for a human decision on ${this.attempts.length} escalated attempt(s).`,
        status: statusPayload({ waitingOn }),
      };
    }
    if (this.report) {
      return {
        state: "completed",
        text: this.report.summary || `Reported ${this.report.status}.`,
        status: statusPayload({ report: this.report }),
      };
    }
    if (this.delegated || this.input) {
      const waitingOn: WaitingOn = {};
      if (this.delegated) waitingOn.children = [...this.children];
      if (this.input) waitingOn.input = this.input;
      return {
        state: "input_required",
        text: this.delegated ? "Waiting for delegated work." : "Waiting for an answer.",
        status: statusPayload({ waitingOn }),
      };
    }
    const detail = lastText.trim() ? ` Last message: ${lastText.trim().slice(0, 500)}` : "";
    const message = `The agent finished without an applied ${REPORT_TOOL}.${detail}`;
    return {
      state: "failed",
      text: message,
      status: statusPayload({ error: { code: "NO_REPORT", message } }),
    };
  }
}

function proposal(tool: string, args: Json, kind: Kind, attemptId?: string): Json {
  return {
    schema: PROPOSAL_SCHEMA,
    tool,
    arguments: args,
    status: kind === "ok" ? "succeeded" : kind,
    ...(attemptId ? { attempt_id: attemptId } : {}),
  };
}

function reportMirror(args: Json): Json | null {
  const status = args.status;
  if (typeof status !== "string" || !(REPORT_STATUSES as readonly string[]).includes(status)) return null;
  const mirror: Json = { schema: REPORT_SCHEMA, status, summary: String(args.summary ?? "") };
  if (Array.isArray(args.outputs)) {
    mirror.outputs = args.outputs
      .filter((o): o is Json => isObject(o) && Boolean(o.kind) && Boolean(o.ref))
      .map((o) => ({ kind: String(o.kind), ref: String(o.ref) }));
  }
  return mirror;
}
