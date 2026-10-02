// checkout: create an executor episode for one work item and keep it in the slot.

import { randomUUID } from "node:crypto";
import { Budget, callMachine, iso, requireCredentials } from "../auth.js";
import { episodesPath, parseEpisodeGrant } from "../contract.js";
import type { Ctx } from "../ctx.js";
import { ExecutorError } from "../errors.js";
import { errorDetail, failForStatus } from "../http.js";
import {
  clearPendingCheckout,
  ensureSlotDir,
  loadPendingCheckout,
  loadSlot,
  localMs,
  saveSlot,
  savePendingCheckout,
  skewFrom,
  slotLockPath,
  withLock,
  type SlotState,
} from "../state.js";

export const CHECKOUT_CLIENTS = ["claude-code", "codex", "openclaw"] as const;

const WORK_ITEM = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTEMPTS = 3;
const BUDGET_MS = 30_000;
export const MAX_WAIT_SECONDS = 1_200;
const FIRST_PAUSE_MS = 5_000;
const LONGEST_PAUSE_MS = 30_000;
/** How long an unconfirmed checkout's idempotency key is kept for a later run to reuse. */
const PENDING_MAX_AGE_MS = 3_600_000;

export interface CheckoutOptions {
  workItem: string;
  client: string;
  org?: string;
  /** Keep trying while the work item is not free (a 409), for this many seconds at most. Default 0: one try. */
  waitSeconds?: number;
  /** Progress lines for a person. They go to stderr. */
  say?(line: string): void;
}

export interface CheckoutResult {
  slot: SlotState;
  reused: boolean;
}

/** A slot's episode is live when it was not ended and its deadline is ahead. */
export function slotIsLive(slot: SlotState, now: number): boolean {
  return !slot.ended && localMs(slot, slot.deadline) > now;
}

export async function checkout(ctx: Ctx, options: CheckoutOptions): Promise<CheckoutResult> {
  if (!WORK_ITEM.test(options.workItem)) throw new ExecutorError("usage", "the work item id has characters that are not allowed");
  // The control plane keeps a work item's UUID in lower case; the slot comparison below must not depend on how it was typed.
  const opts = { ...options, workItem: UUID.test(options.workItem) ? options.workItem.toLowerCase() : options.workItem };
  if (!(CHECKOUT_CLIENTS as readonly string[]).includes(opts.client)) {
    throw new ExecutorError("usage", `--client must be one of ${CHECKOUT_CLIENTS.join(", ")}`);
  }
  const creds = requireCredentials(ctx);
  const org = opts.org?.trim() || ctx.env.HELM_EXECUTOR_ORG?.trim() || creds.org_id;
  if (!org) throw new ExecutorError("usage", "no organization: pass --org, set HELM_EXECUTOR_ORG, or run login with --org");

  const inspect = (): CheckoutResult | null => {
    const slot = loadSlot(ctx);
    if (!slot || !slotIsLive(slot, ctx.now())) return null;
    if (slot.work_item_id === opts.workItem) return { slot, reused: true };
    throw new ExecutorError("usage", `slot "${ctx.slot}" holds ${slot.work_item_id}; run stop first or use another HELM_EXECUTOR_SLOT`);
  };
  const early = inspect();
  if (early) return early;

  const wait = Math.min(Math.max(opts.waitSeconds ?? 0, 0), MAX_WAIT_SECONDS) * 1000;
  ensureSlotDir(ctx);
  const budget = new Budget(BUDGET_MS + wait);
  return withLock(slotLockPath(ctx), budget.left(), async () => {
    const again = inspect();
    if (again) return again;

    // One idempotency key for every attempt of this checkout, here and in a later run: when every answer was lost the
    // control plane may still have created the episode, and the same key gets it back instead of a 409 for an episode
    // nobody here holds.
    const pending = loadPendingCheckout(ctx);
    const created = pending ? Date.parse(pending.created_at) : Number.NaN;
    const resume =
      pending !== null && pending.work_item_id === opts.workItem && pending.client === opts.client && pending.org_id === org && ctx.now() >= created && ctx.now() - created < PENDING_MAX_AGE_MS;
    const key = resume && pending ? pending.key : randomUUID();
    if (!resume) savePendingCheckout(ctx, { key, work_item_id: opts.workItem, client: opts.client, org_id: org, created_at: iso(ctx.now()) });
    const waitUntil = ctx.now() + wait;
    let pause = FIRST_PAUSE_MS;
    let failures = 0;
    for (;;) {
      try {
        const res = await callMachine(ctx, budget, {
          method: "POST",
          path: episodesPath(creds.workspace_id, org, opts.workItem),
          body: { client: opts.client, idempotency_key: key },
          headers: { "Idempotency-Key": key },
          client: opts.client,
        });
        if (res.status === 409 && ctx.now() + pause <= waitUntil) {
          // The work item has a live episode, or a stopped one whose last token has not expired. Wait for it, only for this.
          opts.say?.(`the work item is not free yet (${errorDetail(res)}); trying again in ${Math.round(pause / 1000)} s`);
          await ctx.sleep(pause);
          pause = Math.min(pause * 2, LONGEST_PAUSE_MS);
          continue;
        }
        if (res.status !== 200 && res.status !== 201) {
          // The control plane has refused this key for good, so there is nothing for a later run to recover with it.
          if ([400, 403, 404, 410].includes(res.status)) clearPendingCheckout(ctx);
          if (res.status === 400 || res.status === 404) {
            // The path takes the retained work item's UUID. A Linear key such as HELM-910 is the usual mistake.
            const hint = UUID.test(opts.workItem) ? "" : "; the work item id is the UUID of the retained work item, not a Linear key";
            throw new ExecutorError("rejected", `the control plane did not create an episode: ${errorDetail(res)}${hint}`);
          }
          if (res.status === 410) {
            throw new ExecutorError("rejected", `the work item's episode or deadline has ended: ${errorDetail(res)}`);
          }
          if (res.status === 409) {
            // The work item has a live episode, or a stopped one whose last token has not expired yet (15 minutes at most).
            throw new ExecutorError("rejected", `the work item is not free: ${errorDetail(res)}; retry after an earlier episode's last token has expired`);
          }
          if (res.status === 403) {
            // Enrollment of a machine credential to a seat is server-side; login proves the credential and never enrolls it.
            throw new ExecutorError("rejected", `no authority to check out this work item: ${errorDetail(res)}; the organization owner must enroll this machine credential for a seat`);
          }
          failForStatus(res, "episode checkout");
        }
        const grant = parseEpisodeGrant(res.json);
        const now = ctx.now();
        const slot: SlotState = {
          slot: ctx.slot,
          client: opts.client,
          org_id: org,
          workspace_id: creds.workspace_id,
          work_item_id: grant.work_item_id,
          episode_id: grant.episode_id,
          deadline: grant.deadline,
          checked_out_at: iso(now),
          token: { value: grant.token, expires_at: grant.token_expires_at, minted_at: iso(now) },
          clock_skew_ms: skewFrom(res.serverDateMs, now),
        };
        saveSlot(ctx, slot);
        clearPendingCheckout(ctx);
        return { slot, reused: false };
      } catch (err) {
        if (err instanceof ExecutorError && err.code === "unavailable" && ++failures < ATTEMPTS) {
          await ctx.sleep(300 * failures);
          continue;
        }
        throw err;
      }
    }
  });
}
