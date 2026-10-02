import assert from "node:assert/strict";
import { test } from "node:test";
import { COALESCE_MS, MIN_VALID_MS, episodeHeaders, episodeToken } from "./commands/token.js";
import { checkout } from "./commands/checkout.js";
import { stop } from "./commands/stop.js";
import { makeCtx } from "./ctx.js";
import { ExecutorError } from "./errors.js";
import { loadSlot, saveSlot, slotLockPath, withLock } from "./state.js";
import { checkedOut, loggedIn, world, type World } from "./test-utils.js";

const rejects = (p: Promise<unknown>, code: string): Promise<void> => assert.rejects(p, (e: unknown) => e instanceof ExecutorError && e.code === code);
const mints = (w: World): number => w.fake.requests.filter((r) => r.path.endsWith("/token") && r.path.includes("executor-episodes")).length;

test("a token minted a moment ago is shared, an older one is replaced by a fresh mint", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    const first = await episodeToken(ctx);
    assert.equal(mints(w), 0, "checkout already minted one");
    w.clock.advance(COALESCE_MS + 1_000);
    const second = await episodeToken(ctx);
    assert.notEqual(second, first);
    assert.equal(mints(w), 1);
    assert.equal(await episodeToken(ctx), second, "within the coalescing window");
    assert.equal(mints(w), 1);
  } finally {
    await w.close();
  }
});

test("callers that start together get one mint and one token", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    w.clock.advance(60_000);
    const tokens = await Promise.all(Array.from({ length: 6 }, () => episodeToken(ctx)));
    assert.equal(new Set(tokens).size, 1);
    assert.equal(mints(w), 1);
  } finally {
    await w.close();
  }
});

test("every token printed has at least 120 seconds of validity left", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    for (let i = 0; i < 5; i++) {
      w.clock.advance(5 * 60_000);
      await episodeToken(ctx);
      const left = Date.parse(loadSlot(ctx)!.token!.expires_at) - w.clock.now();
      assert.ok(left >= MIN_VALID_MS, `only ${left} ms left`);
    }
  } finally {
    await w.close();
  }
});

test("when the control plane is down a token with 120 seconds left is still printed, one with less is not", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    const original = loadSlot(ctx)!.token!.value;
    w.clock.advance(12 * 60_000);
    w.fake.fail("/token", 503, 1);
    assert.equal(await episodeToken(ctx), original);
    w.clock.advance(2 * 60_000);
    w.fake.fail("/token", 503, 1);
    await rejects(episodeToken(ctx), "unavailable");
    w.clock.advance(60_000);
    w.fake.fail("/token", 429, 1, { retryAfter: 1 });
    await rejects(episodeToken(ctx), "unavailable");
  } finally {
    await w.close();
  }
});

test("a stopped episode is episode_ended, remembered, and not asked about again", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    [...w.fake.episodes.values()][0]!.stopped = true;
    w.clock.advance(COALESCE_MS + 1_000);
    await rejects(episodeToken(ctx), "episode_ended");
    const slot = loadSlot(ctx);
    assert.ok(slot?.ended);
    assert.equal(slot?.token, undefined);
    const asked = mints(w);
    await rejects(episodeToken(ctx), "episode_ended");
    assert.equal(mints(w), asked);
  } finally {
    await w.close();
  }
});

test("past the episode deadline the answer is episode_ended without a request", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    w.clock.advance(3_600_000 + 1_000);
    const before = w.fake.requests.length;
    await rejects(episodeToken(ctx), "episode_ended");
    assert.equal(w.fake.requests.length, before);
  } finally {
    await w.close();
  }
});

test("in the last two minutes the token is valid until the deadline", async () => {
  const w = await world({ episodeDeadlineSeconds: 100 });
  try {
    const ctx = await loggedIn(w);
    const { slot } = await checkout(ctx, { workItem: "HELM-910", client: "claude-code" });
    w.clock.advance(20_000);
    const token = await episodeToken(ctx);
    assert.ok(token);
    assert.equal(loadSlot(ctx)!.token!.expires_at, slot.deadline);
  } finally {
    await w.close();
  }
});

test("a refused machine credential is not_logged_in, even when a cached token would still do", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    w.clock.advance(COALESCE_MS + 1_000);
    w.fake.revokeAccessTokens();
    w.fake.fail("/device/refresh", 400, 1, { error: "invalid_grant" });
    await rejects(episodeToken(ctx), "not_logged_in");
  } finally {
    await w.close();
  }
});

test("no episode is no_episode", async () => {
  const w = await world();
  try {
    await rejects(episodeToken(await loggedIn(w)), "no_episode");
  } finally {
    await w.close();
  }
});

test("headers is one Authorization key holding the same token", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    const headers = JSON.parse(await episodeHeaders(ctx)) as Record<string, string>;
    assert.deepEqual(Object.keys(headers), ["Authorization"]);
    assert.equal(headers.Authorization, `Bearer ${await episodeToken(ctx)}`);
    assert.equal(w.fake.episodeForToken(headers.Authorization)?.workItemId, "HELM-910");
  } finally {
    await w.close();
  }
});

test("a 409 is a refusal: rejected, no cached token is printed, and the episode is not marked ended", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    w.clock.advance(COALESCE_MS + 1_000);
    w.fake.fail("/executor-episodes", 409, 1, { error: "binding_changed" });
    await rejects(episodeToken(ctx), "rejected");
    assert.equal(loadSlot(ctx)?.ended, undefined);
    assert.ok(await episodeToken(ctx), "the next call mints normally once the control plane agrees");
  } finally {
    await w.close();
  }
});

test("a 403 is rejected too", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    w.clock.advance(COALESCE_MS + 1_000);
    w.fake.fail("/executor-episodes", 403, 1, { error: "enrollment_denied" });
    await rejects(episodeToken(ctx), "rejected");
    assert.equal(loadSlot(ctx)?.ended, undefined);
  } finally {
    await w.close();
  }
});

test("a 404 fails that call only, a 410 ends the slot for good, and stop still asks the control plane about an ended slot", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    w.clock.advance(COALESCE_MS + 1_000);
    w.fake.fail("/executor-episodes", 404, 1, { error: "episode_not_found" });
    await rejects(episodeToken(ctx), "episode_ended");
    assert.equal(loadSlot(ctx)?.ended, undefined, "a wrong host or a deploy in progress must not end the session");
    assert.ok(await episodeToken(ctx), "the next call mints normally");

    w.clock.advance(COALESCE_MS + 1_000);
    w.fake.fail("/executor-episodes", 410, 1, { error: "episode_stopped" });
    await rejects(episodeToken(ctx), "episode_ended");
    assert.ok(loadSlot(ctx)?.ended, "a 410 is final");
    const before = mints(w);
    await rejects(episodeToken(ctx), "episode_ended");
    assert.equal(mints(w), before, "and is not asked about again");

    const stops = (): number => w.fake.requests.filter((r) => r.path.endsWith("/stop")).length;
    assert.equal(await stop(ctx, { local: false }), true);
    assert.equal(stops(), 1, "stop asked the control plane although the slot was marked ended");
    assert.equal(loadSlot(ctx), null);
  } finally {
    await w.close();
  }
});

test("a helper that cannot get the lock in time still serves a good cached token", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    const cached = loadSlot(ctx)!.token!.value;
    w.clock.advance(COALESCE_MS + 1_000);
    let release: () => void = () => undefined;
    const held = withLock(slotLockPath(ctx), 5_000, () => new Promise<void>((resolve) => (release = resolve)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = mints(w);
    assert.equal(await episodeToken(ctx, 300), cached, "the other holder is mid-mint; the cache serves");
    assert.equal(mints(w), before);
    release();
    await held;

    saveSlot(ctx, { ...loadSlot(ctx)!, token: undefined });
    const held2 = withLock(slotLockPath(ctx), 5_000, () => new Promise<void>((resolve) => (release = resolve)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rejects(episodeToken(ctx, 300), "unavailable");
    release();
    await held2;
  } finally {
    await w.close();
  }
});

test("a clock set back is not trusted: the cached token is replaced, never printed on faith", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    const cached = loadSlot(ctx)!.token!.value;
    w.clock.advance(-2 * 3_600_000);
    const before = mints(w);
    const fresh = await episodeToken(ctx);
    assert.equal(mints(w), before + 1, "a token minted in the future is distrusted and replaced");
    assert.notEqual(fresh, cached);
    // With the control plane down as well, nothing can vouch for the cache, so nothing is printed.
    saveSlot(ctx, { ...loadSlot(ctx)!, token: { value: cached, expires_at: new Date(w.clock.now() + 3_600_000).toISOString(), minted_at: new Date(w.clock.now() - 60_000).toISOString() } });
    w.fake.fail("/executor-episodes", 503, 1);
    w.clock.advance(COALESCE_MS + 1_000);
    await rejects(episodeToken(ctx), "unavailable");
  } finally {
    await w.close();
  }
});

test("a machine clock far off the control plane's still gets usable tokens, judged by the control plane's clock", async () => {
  for (const offset of [20 * 60_000, -10 * 60_000]) {
    const w = await world();
    try {
      await loggedIn(w);
      const skewed = makeCtx(w.env(), { now: () => w.clock.now() + offset, sleep: w.clock.sleep, home: w.home, slot: "default" });
      await checkout(skewed, { workItem: "HELM-910", client: "claude-code" });
      const slot = loadSlot(skewed)!;
      assert.equal(slot.clock_skew_ms, -offset);
      const token = await episodeToken(skewed);
      assert.equal(token, slot.token!.value);
      w.clock.advance(5 * 60_000);
      assert.notEqual(await episodeToken(skewed), token, "a later call mints another, as it does with a true clock");
      assert.equal(loadSlot(skewed)!.clock_skew_ms, -offset);

      // When the control plane is down, a cached token that the control plane's clock says is dead is not printed
      // even though this machine's clock still calls it valid.
      w.clock.advance(14 * 60_000);
      w.fake.fail("/executor-episodes", 503, 1);
      await rejects(episodeToken(skewed), "unavailable");
    } finally {
      await w.close();
    }
  }
});

test("a token the control plane issues with too little life is not printed", async () => {
  const w = await world({ episodeTokenTtlSeconds: 30 });
  try {
    const ctx = await checkedOut(w);
    w.clock.advance(COALESCE_MS + 1_000);
    await assert.rejects(episodeToken(ctx), (e: unknown) => e instanceof ExecutorError && e.code === "internal" && /valid for only/.test(e.message));
  } finally {
    await w.close();
  }
});
