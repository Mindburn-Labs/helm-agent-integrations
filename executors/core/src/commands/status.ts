// status and env: read-only views of the slot. Neither prints a credential.

import type { Ctx } from "../ctx.js";
import { ExecutorError } from "../errors.js";
import { loadCredentials, loadObserveRecord, loadSlot } from "../state.js";

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
}

export function statusReport(ctx: Ctx): StatusReport {
  const creds = loadCredentials(ctx);
  const slot = loadSlot(ctx);
  const observe = loadObserveRecord(ctx);
  return {
    schema: "helm.executor.status/v1",
    logged_in: creds !== null,
    workspace_id: creds?.workspace_id ?? null,
    cp_url: ctx.env.HELM_EXECUTOR_CP_URL?.trim() || creds?.cp_url || null,
    slot: ctx.slot,
    episode: slot
      ? {
          episode_id: slot.episode_id,
          work_item_id: slot.work_item_id,
          client: slot.client,
          deadline: slot.deadline,
          seconds_left: Math.max(0, Math.round((Date.parse(slot.deadline) - ctx.now()) / 1000)),
          ended: slot.ended?.reason ?? null,
        }
      : null,
    observe: { last_ok_at: observe.last_ok_at, last_error_at: observe.last_error_at, last_error: observe.last_error },
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
