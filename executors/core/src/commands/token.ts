// token and headers: a bearer token for the episode checked out in this slot. CONTRACT.md sections 3 and 4.

import { Budget, callMachine, iso } from "../auth.js";
import { episodeTokenPath, parseEpisodeTokenGrant } from "../contract.js";
import type { Ctx } from "../ctx.js";
import { ExecutorError } from "../errors.js";
import { failForStatus } from "../http.js";
import { loadSlot, localMs, saveSlot, skewFrom, slotLockPath, withLock, type SlotState } from "../state.js";

/** A printed token has at least this much validity left (less in the last stretch before the episode deadline). */
export const MIN_VALID_MS = 120_000;
/** A token minted this recently is returned as it is, so helpers that start together share one. */
export const COALESCE_MS = 15_000;
/** Claude Code gives up on an MCP headersHelper after 10 seconds. */
export const TOKEN_BUDGET_MS = 8_000;
/** The issuer caps a bearer at 15 minutes. A cached token claiming more means this machine's clock went backwards. */
const MAX_PLAUSIBLE_LEFT_MS = 20 * 60_000;

function activeSlot(ctx: Ctx): SlotState {
  const slot = loadSlot(ctx);
  if (!slot) throw new ExecutorError("no_episode", `no episode is checked out in slot "${ctx.slot}"; run \`helm-executor checkout <work-item> --client <client>\``);
  if (slot.ended) throw new ExecutorError("episode_ended", `the episode ended: ${slot.ended.reason}`);
  if (ctx.now() >= localMs(slot, slot.deadline)) throw new ExecutorError("episode_ended", "the episode deadline has passed");
  return slot;
}

/** How much validity a printed token must have: the floor, or less when the episode deadline comes first. */
function needed(slot: SlotState, now: number): number {
  return Math.min(MIN_VALID_MS, localMs(slot, slot.deadline) - now);
}

/** The cached token when it is good enough to print, else null. `coalesce` also requires it to be fresh. */
function reusable(slot: SlotState, now: number, coalesce: boolean): string | null {
  const cached = slot.token;
  if (!cached) return null;
  const age = now - Date.parse(cached.minted_at);
  // A token from the future, or one with more life than the issuer ever gives, is a sign that this clock was set back.
  if (age < 0) return null;
  const left = localMs(slot, cached.expires_at) - now;
  if (left <= 0 || left < needed(slot, now) || left > MAX_PLAUSIBLE_LEFT_MS) return null;
  if (coalesce && age >= COALESCE_MS) return null;
  return cached.value;
}

export async function episodeToken(ctx: Ctx, budgetMs = TOKEN_BUDGET_MS): Promise<string> {
  const budget = new Budget(budgetMs);
  const first = reusable(activeSlot(ctx), ctx.now(), true);
  if (first) return first;

  try {
    return await withLock(slotLockPath(ctx), budget.left(), () => mint(ctx, budget));
  } catch (err) {
    // Not getting the lock in time is control plane trouble in all but name: another helper is waiting on it. A good
    // cached token still serves.
    if (err instanceof ExecutorError && err.code === "unavailable") {
      const cached = reusable(activeSlot(ctx), ctx.now(), false);
      if (cached) return cached;
    }
    throw err;
  }
}

async function mint(ctx: Ctx, budget: Budget): Promise<string> {
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
      const now = ctx.now();
      const skew = skewFrom(res.serverDateMs, now);
      const grant = parseEpisodeTokenGrant(res.json, now, skew);
      const next: SlotState = { ...slot, clock_skew_ms: skew };
      const left = localMs(next, grant.token_expires_at) - now;
      if (left <= 0) throw new ExecutorError("internal", "the control plane returned a token that is already expired");
      if (left < needed(next, now)) {
        throw new ExecutorError("internal", `the control plane returned a token valid for only ${Math.round(left / 1000)} s; at least ${Math.round(MIN_VALID_MS / 1000)} s is needed`);
      }
      saveSlot(ctx, { ...next, token: { value: grant.token, expires_at: grant.token_expires_at, minted_at: iso(now) } });
      return grant.token;
    }
    // 410: stopped or expired, and final. 404: not ours or unknown, which a wrong host or a deploy in progress can also
    // answer, so it fails this call and is not remembered. A 409 (binding changed or unresolved) is a refusal, not an
    // ending: it falls through to `rejected`, and no cached token is printed for it.
    if (res.status === 410) {
      const { token: _dropped, ...rest } = slot;
      saveSlot(ctx, { ...rest, ended: { at: iso(ctx.now()), reason: "the control plane answered 410" } });
      throw new ExecutorError("episode_ended", "the control plane says the episode is gone (HTTP 410)");
    }
    if (res.status === 404) throw new ExecutorError("episode_ended", "the control plane does not know this episode (HTTP 404)");
    return failForStatus(res, "episode token");
  } catch (err) {
    // Control plane trouble must not end a session that still holds a good token.
    if (err instanceof ExecutorError && err.code === "unavailable") {
      const cached = reusable(slot, ctx.now(), false);
      if (cached) return cached;
    }
    throw err;
  }
}

export async function episodeHeaders(ctx: Ctx): Promise<string> {
  return JSON.stringify({ Authorization: `Bearer ${await episodeToken(ctx)}` });
}
