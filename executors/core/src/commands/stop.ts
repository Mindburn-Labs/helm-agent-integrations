// stop: end the slot's episode at the control plane and clear the slot.

import { Budget, callMachine } from "../auth.js";
import { episodeStopPath } from "../contract.js";
import type { Ctx } from "../ctx.js";
import { failForStatus } from "../http.js";
import { ExecutorError } from "../errors.js";
import { clearPendingCheckout, clearSlot, loadSlot, slotLockPath, withLock, type SlotState } from "../state.js";

const BUDGET_MS = 20_000;

/**
 * Returns false when the slot was already empty. `local` clears the slot without asking the control plane, and also
 * replaces a slot file that cannot be read. Otherwise the control plane is always asked, even for a slot marked ended:
 * only the control plane knows whether the episode is really over.
 */
export async function stop(ctx: Ctx, opts: { local: boolean }): Promise<boolean> {
  let slot: SlotState | null;
  try {
    slot = loadSlot(ctx);
  } catch (err) {
    if (opts.local && err instanceof ExecutorError && err.code === "no_episode") {
      clearSlot(ctx);
      return true;
    }
    throw err;
  }
  if (!slot) {
    // Nothing is checked out here. A checkout whose answers were all lost may still have an episode at the control plane,
    // and only its key can get it back, so only `--local`, which means forget everything held here, drops the key.
    if (opts.local) clearPendingCheckout(ctx);
    return false;
  }
  if (opts.local) {
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
    // An episode the control plane no longer knows (404) or reports ended (410) is stopped as far as we care. A 409 means
    // the release is unresolved, so the slot stays and the failure is reported.
    const gone = res.status === 404 || res.status === 410;
    if (!gone && (res.status < 200 || res.status >= 300)) failForStatus(res, "episode stop");
  });
  clearSlot(ctx);
  return true;
}
