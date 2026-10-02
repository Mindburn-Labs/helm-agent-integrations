// observe: post one hook event as an observed-only observation. It never throws to its caller and the CLI
// always exits 0 after it: a hook helper that fails must not block a tool call. CONTRACT.md section 5.

import { Budget, callMachine, iso } from "../auth.js";
import { observationsPath } from "../contract.js";
import type { Ctx } from "../ctx.js";
import { ExecutorError, failureLine } from "../errors.js";
import { errorDetail } from "../http.js";
import {
  OBSERVE_CLIENTS,
  OBSERVE_EVENTS,
  buildObservation,
  idempotencyKey,
  type ObserveClient,
  type ObserveEvent,
} from "../observation.js";
import { loadObserveRecord, loadSlot, saveObserveRecord } from "../state.js";

export const MAX_INPUT_BYTES = 8 << 20;
const BUDGET_MS = 5_000;
const POST_TIMEOUT_MS = 3_000;
const OK_RECORD_REFRESH_MS = 60_000;

export interface ObserveOptions {
  client: string | undefined;
  event: string | undefined;
  /** The raw hook stdin, or null when it exceeded MAX_INPUT_BYTES. */
  input: string | null;
}

export type ObserveOutcome =
  | { status: "posted" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; line: string };

function recordFailure(ctx: Ctx, reason: string): void {
  try {
    const rec = loadObserveRecord(ctx);
    saveObserveRecord(ctx, { ...rec, last_error_at: iso(ctx.now()), last_error: reason.slice(0, 200), dropped: rec.dropped + 1 });
  } catch {
    // The record is a hint for `status`. Losing it never matters more than not blocking the tool call.
  }
}

function recordSuccess(ctx: Ctx): void {
  try {
    const rec = loadObserveRecord(ctx);
    const now = ctx.now();
    const recovering = rec.last_error_at !== null && (rec.last_ok_at === null || rec.last_error_at >= rec.last_ok_at);
    const stale = rec.last_ok_at === null || now - Date.parse(rec.last_ok_at) > OK_RECORD_REFRESH_MS;
    if (recovering || stale) saveObserveRecord(ctx, { ...rec, last_ok_at: iso(now) });
  } catch {
    // See recordFailure.
  }
}

export async function observe(ctx: Ctx, opts: ObserveOptions): Promise<ObserveOutcome> {
  const fail = (code: ExecutorError["code"], reason: string): ObserveOutcome => {
    recordFailure(ctx, `${code}: ${reason}`);
    return { status: "failed", line: failureLine(code, reason) };
  };
  try {
    const client = OBSERVE_CLIENTS.find((c) => c === opts.client) as ObserveClient | undefined;
    if (!client) return { status: "failed", line: failureLine("usage", `--client must be one of ${OBSERVE_CLIENTS.join(", ")}`) };

    const slot = loadSlot(ctx);
    if (!slot) return { status: "skipped", reason: "no episode is checked out" };
    if (slot.ended || ctx.now() >= Date.parse(slot.deadline)) return { status: "skipped", reason: "the episode has ended" };

    if (opts.input === null) return fail("rejected", "hook input is larger than 8 MiB; skipped");
    let envelope: unknown;
    try {
      envelope = JSON.parse(opts.input);
    } catch {
      return fail("rejected", "hook input is not valid JSON");
    }
    const named = typeof envelope === "object" && envelope !== null ? (envelope as Record<string, unknown>).hook_event_name : undefined;
    const rawEvent = opts.event ?? (typeof named === "string" ? named : undefined);
    const event = OBSERVE_EVENTS.find((e) => e === rawEvent) as ObserveEvent | undefined;
    if (!event) return fail("rejected", `unsupported hook event "${String(rawEvent ?? "").slice(0, 40)}"`);

    const observation = buildObservation({
      client,
      event,
      envelope,
      slot,
      now: new Date(ctx.now()),
      summary: ctx.env.HELM_EXECUTOR_OBSERVE_SUMMARY?.trim().toLowerCase() !== "off",
    });
    const key = idempotencyKey(slot.episode_id, event, observation.tool?.use_id);

    const res = await callMachine(ctx, new Budget(BUDGET_MS), {
      method: "POST",
      path: observationsPath(slot.workspace_id, slot.org_id),
      body: observation,
      headers: key ? { "Idempotency-Key": key } : undefined,
      client,
      timeoutMs: POST_TIMEOUT_MS,
    });
    if (res.status >= 200 && res.status < 300) {
      recordSuccess(ctx);
      return { status: "posted" };
    }
    return fail(res.status === 429 || res.status >= 500 ? "unavailable" : "rejected", `observation not accepted: ${errorDetail(res)}`);
  } catch (err) {
    if (err instanceof ExecutorError) return fail(err.code, err.message);
    return fail("internal", err instanceof Error ? err.message : "unexpected failure");
  }
}
