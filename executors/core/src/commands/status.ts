// status and env: read-only views of the slot. Neither prints a credential.

import type { Ctx } from "../ctx.js";
import { ExecutorError } from "../errors.js";
import { normalizeBaseUrl } from "../http.js";
import { loadCredentials, loadObserveRecord, loadSlot, localMs, type Credentials, type SlotState } from "../state.js";

export interface StatusReport {
  schema: "helm.executor.status/v1";
  logged_in: boolean;
  workspace_id: string | null;
  cp_url: string | null;
  slot: string;
  episode: {
    episode_id: string;
    work_item_id: string;
    client: string;
    deadline: string;
    seconds_left: number;
    ended: string | null;
  } | null;
  observe: { last_ok_at: string | null; last_error_at: string | null; last_error: string | null };
  /** What needs a person's attention: an unreadable state file, an environment that disagrees with the login, a lost renewal. */
  problems: string[];
}

/** A state file that cannot be read is a problem to report, not a reason for `status` to fail. */
function tolerate<T>(problems: string[], read: () => T | null): T | null {
  try {
    return read();
  } catch (err) {
    problems.push(err instanceof ExecutorError ? err.message : "a state file could not be read");
    return null;
  }
}

function credentialProblems(ctx: Ctx, creds: Credentials): string[] {
  const out: string[] = [];
  const named = ctx.env.HELM_EXECUTOR_CP_URL?.trim();
  try {
    if (named && normalizeBaseUrl(named) !== normalizeBaseUrl(creds.cp_url)) {
      out.push(`HELM_EXECUTOR_CP_URL names ${normalizeBaseUrl(named)}, but this machine logged in to ${normalizeBaseUrl(creds.cp_url)}; run login for the new one`);
    }
  } catch (err) {
    if (err instanceof ExecutorError) out.push(err.message);
  }
  if (creds.refresh_in_doubt_at) out.push(`the answer to a credential renewal at ${creds.refresh_in_doubt_at} never arrived; if the next renewal is refused, log in again`);
  return out;
}

function seconds(slot: SlotState, now: number): number {
  return Math.max(0, Math.round((localMs(slot, slot.deadline) - now) / 1000));
}

export function statusReport(ctx: Ctx): StatusReport {
  const problems: string[] = [];
  const creds = tolerate(problems, () => loadCredentials(ctx));
  if (creds) problems.push(...credentialProblems(ctx, creds));
  const slot = tolerate(problems, () => loadSlot(ctx));
  const observe = loadObserveRecord(ctx);
  return {
    schema: "helm.executor.status/v1",
    logged_in: creds !== null,
    workspace_id: creds?.workspace_id ?? null,
    cp_url: creds?.cp_url ?? null,
    slot: ctx.slot,
    episode: slot
      ? {
          episode_id: slot.episode_id,
          work_item_id: slot.work_item_id,
          client: slot.client,
          deadline: slot.deadline,
          seconds_left: seconds(slot, ctx.now()),
          ended: slot.ended?.reason ?? null,
        }
      : null,
    observe: { last_ok_at: observe.last_ok_at, last_error_at: observe.last_error_at, last_error: observe.last_error },
    problems,
  };
}

export function renderStatus(report: StatusReport): string {
  const lines = [
    report.logged_in ? `logged in: yes (workspace ${report.workspace_id}, ${report.cp_url})` : "logged in: no",
    `slot: ${report.slot}`,
  ];
  const ep = report.episode;
  if (!ep) lines.push("episode: none");
  else if (ep.ended) lines.push(`episode: ${ep.work_item_id} (${ep.episode_id}, ${ep.client}) ended: ${ep.ended}`);
  else lines.push(`episode: ${ep.work_item_id} (${ep.episode_id}, ${ep.client}), ${ep.seconds_left} s left before the deadline`);
  const o = report.observe;
  lines.push(`observe: last ok ${o.last_ok_at ?? "never"}${o.last_error_at ? `; last error ${o.last_error_at}: ${o.last_error}` : ""}`);
  for (const problem of report.problems) lines.push(`problem: ${problem}`);
  return `${lines.join("\n")}\n`;
}

const OWN_KEYS = new Set(["helm.work_item_id", "helm.episode_id", "helm.executor"]);

// OpenTelemetry resource attribute values: percent-encode everything outside the unreserved set.
const attr = (v: string): string => encodeURIComponent(v);

export function otelResourceAttributes(ctx: Ctx): string {
  const slot = loadSlot(ctx);
  if (!slot) throw new ExecutorError("no_episode", `no episode is checked out in slot "${ctx.slot}"`);
  if (slot.ended) throw new ExecutorError("episode_ended", `the episode ended: ${slot.ended.reason}`);
  const kept = (ctx.env.OTEL_RESOURCE_ATTRIBUTES ?? "")
    .split(",")
    .map((pair) => pair.trim())
    .filter((pair) => pair !== "" && !OWN_KEYS.has(pair.split("=")[0] ?? ""));
  return [
    ...kept,
    `helm.work_item_id=${attr(slot.work_item_id)}`,
    `helm.episode_id=${attr(slot.episode_id)}`,
    `helm.executor=${attr(slot.client)}`,
  ].join(",");
}

export function renderEnv(value: string, format: "plain" | "shell" | "json"): string {
  if (format === "json") return `${JSON.stringify({ OTEL_RESOURCE_ATTRIBUTES: value })}\n`;
  if (format === "shell") return `export OTEL_RESOURCE_ATTRIBUTES='${value.replace(/'/g, "'\\''")}'\n`;
  return `OTEL_RESOURCE_ATTRIBUTES=${value}\n`;
}
