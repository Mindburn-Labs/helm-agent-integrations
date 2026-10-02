// stop: end the slot's episode at the control plane and clear the slot.

import { Budget, callMachine } from "../auth.js";
import { episodeStopPath } from "../contract.js";
import type { Ctx } from "../ctx.js";
import { failForStatus } from "../http.js";
import { clearSlot, loadSlot, slotLockPath, withLock } from "../state.js";

const BUDGET_MS = 20_000;

/** Returns false when the slot was already empty. `local` clears the slot without asking the control plane. */
export async function stop(ctx: Ctx, opts: { local: boolean }): Promise<boolean> {
  const slot = loadSlot(ctx);
  if (!slot) return false;
  if (opts.local || slot.ended) {
    clearSlot(ctx);
    return true;
  }
  const budget = new Budget(BUDGET_MS);
  await withLock(slotLockPath(ctx), budget.left(), async () => {
    const res = await callMachine(ctx, budget, {
      method: "POST",
      path: episodeStopPath(slot.workspace_id, slot.org_id, slot.work_item_id, slot.episode_id),
      body: {},
      client: slot.client,
    });
    // An episode the control plane no longer knows or has already ended is stopped as far as we care.
    const gone = res.status === 404 || res.status === 409 || res.status === 410;
    if (!gone && (res.status < 200 || res.status >= 300)) failForStatus(res, "episode stop");
  });
  clearSlot(ctx);
  return true;
}
