import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Budget, callMachine, cpUrl, machineAccessToken } from "./auth.js";
import { observe } from "./commands/observe.js";
import { episodeToken } from "./commands/token.js";
import { observationsPath } from "./contract.js";
import { makeCtx } from "./ctx.js";
import { ExecutorError } from "./errors.js";
import { loadCredentials, saveCredentials } from "./state.js";
import { httpJson } from "./http.js";
import { statusReport } from "./commands/status.js";
import { checkedOut, loggedIn, world } from "./test-utils.js";
import { startFakeCp } from "./testing/fake-cp.js";

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

test("a credential is bound to the control plane that issued it: the environment may name that one and no other", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    const creds = loadCredentials(ctx);
    assert.ok(creds);
    const refused = (url: string): unknown => assert.throws(() => cpUrl(makeCtx({ ...w.env(), HELM_EXECUTOR_CP_URL: url }, { home: w.home }), creds), (e: unknown) => e instanceof ExecutorError && e.code === "usage");
    assert.equal(cpUrl(makeCtx({ ...w.env(), HELM_EXECUTOR_CP_URL: `${w.fake.url}/` }, { home: w.home }), creds), w.fake.url, "the same origin, spelled with a slash");
    assert.equal(cpUrl(makeCtx({ ...w.env(), HELM_EXECUTOR_CP_URL: undefined }, { home: w.home }), creds), w.fake.url, "no override");
    refused("https://other.example.com");
    refused("http://other.example.com");
    assert.throws(
      () => cpUrl(makeCtx({ ...w.env(), HELM_EXECUTOR_CP_URL: "https://other.example.com" }, { home: w.home }), creds),
      (e: unknown) => e instanceof ExecutorError && e.message.includes("https://other.example.com") && e.message.includes(w.fake.url),
    );
  } finally {
    await w.close();
  }
});

test("a different control plane in the environment gets no request at all: nothing carries the credential to it", async () => {
  const w = await world();
  const stranger = await startFakeCp();
  try {
    await checkedOut(w);
    const hijacked = w.ctx({ env: { HELM_EXECUTOR_CP_URL: stranger.url } });
    // A hook with a valid access token would post the observation, bearer and all, to whatever host the environment names.
    const hook = JSON.stringify({ session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "toolu_1" });
    const outcome = await observe(hijacked, { client: "claude-code", event: "PreToolUse", input: hook });
    assert.ok(outcome.status === "failed" && /usage/.test(outcome.line), JSON.stringify(outcome));
    // An expired access token would send the refresh token.
    w.clock.advance(20 * MIN);
    await assert.rejects(episodeToken(hijacked), (e: unknown) => e instanceof ExecutorError && e.code === "usage");
    assert.equal(stranger.requests.length, 0, "the other host saw nothing");
    assert.equal(w.fake.refreshCount(), 0);
  } finally {
    await stranger.close();
    await w.close();
  }
});

const refreshRequests = (w: Awaited<ReturnType<typeof world>>): number => w.fake.requests.filter((r) => r.path.endsWith("/auth/device/refresh")).length;

test("a renewal whose answer is lost is remembered, and the refusal that follows says so; a renewal that never left is not", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    w.clock.advance(20 * MIN);
    w.fake.dropResponse("/auth/device/refresh", 1);
    await assert.rejects(machineAccessToken(ctx, new Budget(5_000)), (e: unknown) => e instanceof ExecutorError && e.code === "unavailable" && e.outcomeUnknown);
    assert.equal(w.fake.refreshCount(), 1, "the control plane rotated the token and the answer was lost");
    assert.ok(loadCredentials(ctx)?.refresh_in_doubt_at);
    assert.ok(statusReport(ctx).problems.some((p) => /never arrived/.test(p)));

    await assert.rejects(
      machineAccessToken(ctx, new Budget(5_000)),
      (e: unknown) => e instanceof ExecutorError && e.code === "not_logged_in" && /whose answer never arrived/.test(e.message) && /helm-executor login/.test(e.message),
    );
  } finally {
    await w.close();
  }

  // A control plane nobody listens on is a failure before the request left: nothing was rotated, nothing is in doubt.
  const nobody = await world();
  try {
    const ctx = await loggedIn(nobody);
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    saveCredentials(ctx, { ...loadCredentials(ctx)!, cp_url: `http://127.0.0.1:${port}` });
    const offline = makeCtx({ HELM_EXECUTOR_HOME: nobody.home }, { now: nobody.clock.now, sleep: nobody.clock.sleep, home: nobody.home, slot: "default" });
    nobody.clock.advance(20 * MIN);
    await assert.rejects(machineAccessToken(offline, new Budget(5_000)), (e: unknown) => e instanceof ExecutorError && e.code === "unavailable" && !e.outcomeUnknown);
    assert.equal(loadCredentials(offline)?.refresh_in_doubt_at, undefined);
  } finally {
    await nobody.close();
  }
});


test("a successful renewal clears the doubt", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    saveCredentials(ctx, { ...loadCredentials(ctx)!, refresh_in_doubt_at: "2026-10-08T11:00:00.000Z" });
    w.clock.advance(20 * MIN);
    await machineAccessToken(ctx, new Budget(5_000));
    assert.equal(loadCredentials(ctx)?.refresh_in_doubt_at, undefined);
    assert.deepEqual(statusReport(ctx).problems, []);
  } finally {
    await w.close();
  }
});

test("a renewal is not started with too little time left to see it through", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    w.clock.advance(20 * MIN);
    const before = refreshRequests(w);
    await assert.rejects(machineAccessToken(ctx, new Budget(1_500)), (e: unknown) => e instanceof ExecutorError && e.code === "unavailable" && /not enough time/.test(e.message));
    assert.equal(refreshRequests(w), before, "no request was sent");
    assert.equal(w.fake.refreshCount(), 0);
  } finally {
    await w.close();
  }
});

test("a refused renewal uses the credentials another process stored meanwhile instead of logging the machine out", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    const stale = loadCredentials(ctx)!;
    w.clock.advance(20 * MIN);
    w.fake.delay("/auth/device/refresh", 250, 1);
    const pending = machineAccessToken(ctx, new Budget(5_000));
    await new Promise((resolve) => setTimeout(resolve, 60));
    // While the first renewal is in flight, another process rotates the same refresh token and stores the result.
    const rival = await httpJson({ method: "POST", url: `${w.fake.url}/api/v1/auth/device/refresh`, body: { grant_type: "refresh_token", refresh_token: stale.refresh_token }, timeoutMs: 2_000 });
    assert.equal(rival.status, 200);
    const grant = rival.json as { access_token: string; refresh_token: string };
    saveCredentials(ctx, { ...stale, access_token: grant.access_token, refresh_token: grant.refresh_token, access_expires_at: new Date(w.clock.now() + 900_000).toISOString() });
    const { token } = await pending;
    assert.equal(token, grant.access_token);
    assert.equal(loadCredentials(ctx)?.refresh_token, grant.refresh_token);
  } finally {
    await w.close();
  }
});

test("a hook never renews the credential: it uses what is left of the access token, and drops the observation after that", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    const hook = JSON.stringify({ session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "toolu_1" });
    w.clock.advance(14.5 * MIN);
    const near = await observe(ctx, { client: "claude-code", event: "PreToolUse", input: hook });
    assert.equal(near.status, "posted", "30 s of life left is enough to post with");
    w.clock.advance(60_000);
    const expired = await observe(ctx, { client: "claude-code", event: "PreToolUse", input: hook });
    assert.ok(expired.status === "failed" && /unavailable/.test(expired.line), JSON.stringify(expired));
    assert.equal(refreshRequests(w), 0, "a hook sent no refresh request");
    assert.equal(w.fake.refreshCount(), 0);
    await episodeToken(ctx);
    assert.equal(w.fake.refreshCount(), 1, "the next token call renews it");
    assert.equal((await observe(ctx, { client: "claude-code", event: "PreToolUse", input: hook })).status, "posted");
  } finally {
    await w.close();
  }
});
