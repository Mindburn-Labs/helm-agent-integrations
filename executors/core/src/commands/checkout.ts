// checkout: create an executor episode for one work item and keep it in the slot.

import { randomUUID } from "node:crypto";
import { Budget, callMachine, iso, requireCredentials } from "../auth.js";
import { episodesPath, parseEpisodeGrant } from "../contract.js";
import type { Ctx } from "../ctx.js";
import { ExecutorError } from "../errors.js";
import { errorDetail, failForStatus } from "../http.js";
import { loadSlot, saveSlot, slotLockPath, ensureSlotDir, withLock, type SlotState } from "../state.js";

export const CHECKOUT_CLIENTS = ["claude-code", "codex", "openclaw"] as const;

const WORK_ITEM = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ATTEMPTS = 3;
const BUDGET_MS = 30_000;

export interface CheckoutOptions {
  workItem: string;
  client: string;
  org?: string;
}

export interface CheckoutResult {
  slot: SlotState;
  reused: boolean;
}

/** A slot's episode is live when it was not ended and its deadline is ahead. */
export function slotIsLive(slot: SlotState, now: number): boolean {
  return !slot.ended && Date.parse(slot.deadline) > now;
}

export async function checkout(ctx: Ctx, opts: CheckoutOptions): Promise<CheckoutResult> {
  if (!WORK_ITEM.test(opts.workItem)) throw new ExecutorError("usage", "the work item id has characters that are not allowed");
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

  ensureSlotDir(ctx);
  const budget = new Budget(BUDGET_MS);
  return withLock(slotLockPath(ctx), budget.left(), async () => {
    const again = inspect();
    if (again) return again;

    // One idempotency key for every attempt of this checkout, so a retry after a lost response is the same request.
    const key = randomUUID();
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await callMachine(ctx, budget, {
          method: "POST",
          path: episodesPath(creds.workspace_id, org, opts.workItem),
          body: { client: opts.client, idempotency_key: key },
          headers: { "Idempotency-Key": key },
          client: opts.client,
        });
        if (res.status !== 200 && res.status !== 201) {
          if (res.status === 404) {
            throw new ExecutorError("rejected", `the control plane did not create an episode: ${errorDetail(res)}`);
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
        };
        saveSlot(ctx, slot);
        return { slot, reused: false };
      } catch (err) {
        if (err instanceof ExecutorError && err.code === "unavailable" && attempt < ATTEMPTS) {
          await ctx.sleep(300 * attempt);
          continue;
        }
        throw err;
      }
    }
  });
}
