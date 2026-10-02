import assert from "node:assert/strict";
import { test } from "node:test";
import { Budget, callMachine, cpUrl, machineAccessToken } from "./auth.js";
import { observationsPath } from "./contract.js";
import { makeCtx } from "./ctx.js";
import { ExecutorError } from "./errors.js";
import { loadCredentials } from "./state.js";
import { checkedOut, loggedIn, world } from "./test-utils.js";

const MIN = 60_000;

test("a valid access token is used without calling the control plane", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    const before = w.fake.requests.length;
    const { token } = await machineAccessToken(ctx, new Budget(5_000));
    assert.equal(token, loadCredentials(ctx)?.access_token);
    assert.equal(w.fake.requests.length, before);
  } finally {
    await w.close();
  }
});

test("an access token about to expire is renewed and the rotated refresh token is stored", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    const before = loadCredentials(ctx);
    w.clock.advance(14.5 * MIN);
    const { token } = await machineAccessToken(ctx, new Budget(5_000));
    const after = loadCredentials(ctx);
    assert.notEqual(token, before?.access_token);
    assert.notEqual(after?.refresh_token, before?.refresh_token);
    assert.equal(after?.cp_url, before?.cp_url);
    assert.equal(after?.org_id, before?.org_id);
    assert.equal(w.fake.refreshCount(), 1);
  } finally {
    await w.close();
  }
});

test("many callers racing to renew cause exactly one refresh", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    w.clock.advance(20 * MIN);
    const tokens = await Promise.all(Array.from({ length: 8 }, () => machineAccessToken(ctx, new Budget(10_000))));
    assert.equal(w.fake.refreshCount(), 1);
    assert.equal(new Set(tokens.map((t) => t.token)).size, 1);
  } finally {
    await w.close();
  }
});

test("a 401 renews the credential once and retries once", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    const slotEpisode = [...w.fake.episodes.values()][0];
    w.fake.revokeAccessTokens();
    const res = await callMachine(ctx, new Budget(10_000), {
      method: "POST",
      path: observationsPath(w.fake.workspaceId, w.fake.orgId),
      body: { schema: "helm.executor.observation/v1", coverage: "observed-only", episode_id: slotEpisode?.episodeId },
    });
    assert.equal(res.status, 202);
    assert.equal(w.fake.refreshCount(), 1);
  } finally {
    await w.close();
  }
});

test("a credential the control plane keeps rejecting is not_logged_in", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    w.fake.revokeAccessTokens();
    w.fake.fail("/observations", 401, 2);
    await assert.rejects(
      callMachine(ctx, new Budget(10_000), { method: "POST", path: observationsPath(w.fake.workspaceId, w.fake.orgId), body: {} }),
      (e: unknown) => e instanceof ExecutorError && e.code === "not_logged_in",
    );
  } finally {
    await w.close();
  }
});

test("a refused refresh is not_logged_in and keeps the stored credential", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    const before = loadCredentials(ctx);
    w.clock.advance(20 * MIN);
    w.fake.fail("/device/refresh", 400, 1, { error: "invalid_grant" });
    await assert.rejects(machineAccessToken(ctx, new Budget(5_000)), (e: unknown) => e instanceof ExecutorError && e.code === "not_logged_in");
    assert.deepEqual(loadCredentials(ctx), before);
  } finally {
    await w.close();
  }
});

test("a control plane outage during renewal is unavailable", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    w.clock.advance(20 * MIN);
    w.fake.fail("/device/refresh", 503, 1);
    await assert.rejects(machineAccessToken(ctx, new Budget(5_000)), (e: unknown) => e instanceof ExecutorError && e.code === "unavailable");
  } finally {
    await w.close();
  }
});

test("an expired refresh token is not_logged_in without a request", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    const before = w.fake.requests.length;
    w.clock.advance(31 * 24 * 60 * MIN);
    await assert.rejects(machineAccessToken(ctx, new Budget(5_000)), (e: unknown) => e instanceof ExecutorError && e.code === "not_logged_in");
    assert.equal(w.fake.requests.length, before);
  } finally {
    await w.close();
  }
});

test("without credentials every call is not_logged_in", async () => {
  const w = await world();
  try {
    await assert.rejects(machineAccessToken(w.ctx(), new Budget(1_000)), (e: unknown) => e instanceof ExecutorError && e.code === "not_logged_in");
  } finally {
    await w.close();
  }
});

test("HELM_EXECUTOR_CP_URL wins over the stored URL, and a cleartext remote URL is refused", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    const creds = loadCredentials(ctx);
    assert.ok(creds);
    assert.equal(cpUrl(makeCtx({ ...w.env(), HELM_EXECUTOR_CP_URL: "https://other.example.com" }, { home: w.home }), creds), "https://other.example.com");
    assert.throws(() => cpUrl(makeCtx({ ...w.env(), HELM_EXECUTOR_CP_URL: "http://other.example.com" }, { home: w.home }), creds), (e: unknown) => e instanceof ExecutorError && e.code === "usage");
  } finally {
    await w.close();
  }
});
