import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { login } from "./commands/login.js";
import { makeCtx } from "./ctx.js";
import { ExecutorError } from "./errors.js";
import { credentialsPath, loadCredentials } from "./state.js";
import { world } from "./test-utils.js";
import { startFakeCp } from "./testing/fake-cp.js";
import { writeFileSync } from "node:fs";

const rejects = (p: Promise<unknown>, code: string): Promise<void> => assert.rejects(p, (e: unknown) => e instanceof ExecutorError && e.code === code);

test("login stores a 0600 credential, prints the verification URL and code, and never a token", async () => {
  const w = await world();
  try {
    const said: string[] = [];
    const ctx = w.ctx();
    const creds = await login(ctx, { say: (line) => said.push(line) });
    assert.equal(statSync(credentialsPath(ctx)).mode & 0o777, 0o600);
    assert.equal(statSync(w.home).mode & 0o777, 0o700);
    assert.equal(creds.workspace_id, w.fake.workspaceId);
    assert.equal(creds.org_id, w.fake.orgId);
    assert.equal(creds.cp_url, w.fake.url);
    assert.match(creds.client_name, /^helm-executor@/);
    assert.deepEqual(loadCredentials(ctx), creds);
    const text = said.join("\n");
    assert.match(text, /device\?user_code=ABCD-2345/);
    assert.match(text, /ABCD-2345/);
    assert.ok(!text.includes(creds.access_token) && !text.includes(creds.refresh_token));
    // First poll is pending, second is approved.
    assert.equal(w.fake.requests.filter((r) => r.path.endsWith("/device/token")).length, 2);
  } finally {
    await w.close();
  }
});

test("login keeps polling through slow_down", async () => {
  const w = await world();
  try {
    w.fake.fail("/device/token", 400, 1, { error: "slow_down" });
    const before = w.clock.now();
    await login(w.ctx(), { say: () => undefined });
    // 1 s interval, then +5 s after slow_down.
    assert.ok(w.clock.now() - before >= 6_000);
  } finally {
    await w.close();
  }
});

test("login fails when the code expired, was denied, or was already used", async () => {
  const w = await world();
  try {
    for (const [error, pattern] of [
      ["expired_token", /expired/],
      ["access_denied", /denied/],
      ["invalid_grant", /already used|invalid/],
    ] as const) {
      w.fake.fail("/device/token", 400, 1, { error });
      await assert.rejects(login(w.ctx(), { say: () => undefined }), (e: unknown) => e instanceof ExecutorError && e.code === "rejected" && pattern.test(e.message));
    }
  } finally {
    await w.close();
  }
});

test("login rides out two control plane errors and gives up on the third", async () => {
  const w = await world();
  try {
    w.fake.fail("/device/token", 503, 2);
    await login(w.ctx(), { say: () => undefined });
    w.fake.fail("/device/token", 503, 3);
    await rejects(login(w.ctx(), { say: () => undefined }), "unavailable");
  } finally {
    await w.close();
  }
});

test("login needs a control plane URL and refuses a cleartext remote one", async () => {
  const w = await world();
  try {
    const noUrl = makeCtx({ HELM_EXECUTOR_HOME: w.home }, { now: w.clock.now, sleep: w.clock.sleep });
    await rejects(login(noUrl, { say: () => undefined }), "usage");
    await rejects(login(noUrl, { cpUrl: "http://cp.example.com", say: () => undefined }), "usage");
  } finally {
    await w.close();
  }
});

test("--org wins over the environment and an earlier login's organization", async () => {
  const w = await world();
  try {
    const first = await login(w.ctx(), { org: "org-from-flag", say: () => undefined });
    assert.equal(first.org_id, "org-from-flag");
    const again = await login(w.ctx(), { say: () => undefined });
    assert.equal(again.org_id, w.fake.orgId);
  } finally {
    await w.close();
  }
});

test("a login with no organization anywhere stores none", async () => {
  const w = await world();
  try {
    const ctx = makeCtx({ HELM_EXECUTOR_HOME: join(w.home, "..", "bare"), HELM_EXECUTOR_CP_URL: w.fake.url }, { now: w.clock.now, sleep: w.clock.sleep });
    const creds = await login(ctx, { say: () => undefined });
    assert.equal("org_id" in creds, false);
  } finally {
    await w.close();
  }
});

test("logging in to another control plane drops the stored organization; the same one keeps it", async () => {
  const w = await world();
  const other = await startFakeCp({ now: w.clock.now });
  try {
    const bare = (url: string): ReturnType<typeof makeCtx> => makeCtx({ HELM_EXECUTOR_HOME: w.home, HELM_EXECUTOR_CP_URL: url }, { now: w.clock.now, sleep: w.clock.sleep, home: w.home });
    const first = await login(bare(w.fake.url), { org: "org-of-the-first", say: () => undefined });
    assert.equal(first.org_id, "org-of-the-first");
    const same = await login(bare(w.fake.url), { say: () => undefined });
    assert.equal(same.org_id, "org-of-the-first", "the same control plane keeps its organization");
    const moved = await login(bare(other.url), { say: () => undefined });
    assert.equal("org_id" in moved, false, "the first control plane's organization does not follow the login to the second");
    assert.equal(moved.cp_url, other.url);
  } finally {
    await other.close();
    await w.close();
  }
});

test("login replaces a credentials file that cannot be read", async () => {
  const w = await world();
  try {
    const ctx = w.ctx();
    await login(ctx, { say: () => undefined });
    writeFileSync(credentialsPath(ctx), "{ torn");
    const again = await login(ctx, { say: () => undefined });
    assert.equal(again.workspace_id, w.fake.workspaceId);
    assert.deepEqual(loadCredentials(ctx), again);
  } finally {
    await w.close();
  }
});
