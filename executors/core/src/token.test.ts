import assert from "node:assert/strict";
import { test } from "node:test";
import { COALESCE_MS, MIN_VALID_MS, episodeHeaders, episodeToken } from "./commands/token.js";
import { checkout } from "./commands/checkout.js";
import { ExecutorError } from "./errors.js";
import { loadSlot } from "./state.js";
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
