// token and headers: a bearer token for the episode checked out in this slot. CONTRACT.md sections 3 and 4.

import { Budget, callMachine, iso } from "../auth.js";
import { episodeTokenPath, parseEpisodeTokenGrant } from "../contract.js";
import type { Ctx } from "../ctx.js";
import { ExecutorError } from "../errors.js";
import { failForStatus } from "../http.js";
import { loadSlot, saveSlot, slotLockPath, withLock, type SlotState } from "../state.js";

/** A printed token has at least this much validity left (less in the last stretch before the episode deadline). */
export const MIN_VALID_MS = 120_000;
/** A token minted this recently is returned as it is, so helpers that start together share one. */
export const COALESCE_MS = 15_000;
/** Claude Code gives up on an MCP headersHelper after 10 seconds. */
export const TOKEN_BUDGET_MS = 8_000;

function activeSlot(ctx: Ctx): SlotState {
  const slot = loadSlot(ctx);
  if (!slot) throw new ExecutorError("no_episode", `no episode is checked out in slot "${ctx.slot}"; run \`helm-executor checkout <work-item> --client <client>\``);
  if (slot.ended) throw new ExecutorError("episode_ended", `the episode ended: ${slot.ended.reason}`);
  if (ctx.now() >= Date.parse(slot.deadline)) throw new ExecutorError("episode_ended", "the episode deadline has passed");
  return slot;
}

/** The cached token when it is good enough to print, else null. `coalesce` also requires it to be fresh. */
function reusable(slot: SlotState, now: number, coalesce: boolean): string | null {
  const cached = slot.token;
  if (!cached) return null;
  const left = Date.parse(cached.expires_at) - now;
  const needed = Math.min(MIN_VALID_MS, Date.parse(slot.deadline) - now);
  if (left <= 0 || left < needed) return null;
  if (coalesce && now - Date.parse(cached.minted_at) >= COALESCE_MS) return null;
  return cached.value;
}

export async function episodeToken(ctx: Ctx): Promise<string> {
  const budget = new Budget(TOKEN_BUDGET_MS);
  const first = reusable(activeSlot(ctx), ctx.now(), true);
  if (first) return first;

  return withLock(slotLockPath(ctx), budget.left(), async () => {
    const slot = activeSlot(ctx);
    const shared = reusable(slot, ctx.now(), true);
    if (shared) return shared;
    try {
      const res = await callMachine(ctx, budget, {
        method: "POST",
        path: episodeTokenPath(slot.workspace_id, slot.org_id, slot.work_item_id, slot.episode_id),
        body: {},
        client: slot.client,
      });
      if (res.status === 200 || res.status === 201) {
        const grant = parseEpisodeTokenGrant(res.json, ctx.now());
        if (Date.parse(grant.token_expires_at) <= ctx.now()) {
          throw new ExecutorError("internal", "the control plane returned a token that is already expired");
        }
        saveSlot(ctx, { ...slot, token: { value: grant.token, expires_at: grant.token_expires_at, minted_at: iso(ctx.now()) } });
        return grant.token;
      }
      // 410: stopped or expired. 404: not ours or unknown. A 409 (binding changed or unresolved) is a refusal, not an ending:
      // it falls through to `rejected`, and no cached token is printed for it.
      if (res.status === 404 || res.status === 410) {
        const { token: _dropped, ...rest } = slot;
        saveSlot(ctx, { ...rest, ended: { at: iso(ctx.now()), reason: `the control plane answered ${res.status}` } });
        throw new ExecutorError("episode_ended", `the control plane says the episode is gone (HTTP ${res.status})`);
      }
      return failForStatus(res, "episode token");
    } catch (err) {
      // Control plane trouble must not end a session that still holds a good token.
      if (err instanceof ExecutorError && err.code === "unavailable") {
        const cached = reusable(slot, ctx.now(), false);
        if (cached) return cached;
      }
      throw err;
    }
  });
}

export async function episodeHeaders(ctx: Ctx): Promise<string> {
  return JSON.stringify({ Authorization: `Bearer ${await episodeToken(ctx)}` });
}
