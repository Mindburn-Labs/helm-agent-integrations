import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { test } from "node:test";
import { checkout } from "./commands/checkout.js";
import { stop } from "./commands/stop.js";
import { makeCtx } from "./ctx.js";
import { ExecutorError } from "./errors.js";
import { loadSlot, slotPath } from "./state.js";
import { checkedOut, loggedIn, world } from "./test-utils.js";

const rejects = (p: Promise<unknown>, code: string, pattern?: RegExp): Promise<void> =>
  assert.rejects(p, (e: unknown) => e instanceof ExecutorError && e.code === code && (pattern ? pattern.test(e.message) : true));

test("checkout creates an episode and keeps it, with its deadline and first token, in a 0600 slot file", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    const { slot, reused } = await checkout(ctx, { workItem: "HELM-910", client: "claude-code" });
    assert.equal(reused, false);
    assert.equal(slot.work_item_id, "HELM-910");
    assert.equal(slot.client, "claude-code");
    assert.equal(slot.org_id, w.fake.orgId);
    assert.equal(slot.workspace_id, w.fake.workspaceId);
    assert.equal(slot.deadline, new Date(w.clock.now() + 3_600_000).toISOString());
    assert.ok(slot.token?.value);
    assert.equal(statSync(slotPath(ctx)).mode & 0o777, 0o600);
    assert.deepEqual(loadSlot(ctx), slot);
    const request = w.fake.requests.find((r) => r.path.endsWith("/executor-episodes"));
    assert.equal(request?.headers.authorization?.toString().startsWith("Bearer helm_at_"), true);
    assert.deepEqual(Object.keys(request?.body as object).sort(), ["client", "idempotency_key"]);
  } finally {
    await w.close();
  }
});

test("checking out the same work item again in a live slot changes nothing and asks nothing", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    const before = w.fake.requests.length;
    const again = await checkout(ctx, { workItem: "HELM-910", client: "claude-code" });
    assert.equal(again.reused, true);
    assert.equal(w.fake.requests.length, before);
    assert.equal(w.fake.episodes.size, 1);
  } finally {
    await w.close();
  }
});

test("a different work item in an occupied slot is a usage error", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    await rejects(checkout(ctx, { workItem: "HELM-911", client: "claude-code" }), "usage", /holds HELM-910/);
  } finally {
    await w.close();
  }
});

test("slots are independent: two work items can be checked out at once", async () => {
  const w = await world();
  try {
    const a = await checkedOut(w, "HELM-910", "claude-code");
    const b = w.ctx({ slot: "codex-1" });
    await checkout(b, { workItem: "HELM-911", client: "codex" });
    assert.equal(w.fake.episodes.size, 2);
    await stop(a, { local: false });
    assert.equal(loadSlot(a), null);
    assert.ok(loadSlot(b));
  } finally {
    await w.close();
  }
});

test("changing executor on a work item: the second checkout is refused until the first session stops", async () => {
  const w = await world();
  try {
    const first = await checkedOut(w, "HELM-910", "claude-code");
    const second = w.ctx({ slot: "codex-1" });
    await rejects(checkout(second, { workItem: "HELM-910", client: "codex" }), "rejected", /already has a live episode/);
    assert.equal(loadSlot(second), null);
    await stop(first, { local: false });
    const { slot } = await checkout(second, { workItem: "HELM-910", client: "codex" });
    assert.equal(slot.client, "codex");
    assert.equal(w.fake.episodes.size, 2);
  } finally {
    await w.close();
  }
});

test("a slot past its deadline, or whose episode ended, is replaced by a new episode", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    const first = loadSlot(ctx)?.episode_id;
    w.clock.advance(3_600_000 + 1_000);
    const second = await checkout(ctx, { workItem: "HELM-911", client: "claude-code" });
    assert.notEqual(second.slot.episode_id, first);
    assert.equal(second.slot.work_item_id, "HELM-911");
    assert.equal(w.fake.episodes.size, 2);
  } finally {
    await w.close();
  }
});

test("a retry after a transient failure reuses the idempotency key and creates one episode", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    w.fake.fail("/executor-episodes", 503, 1);
    const { slot } = await checkout(ctx, { workItem: "HELM-910", client: "codex" });
    const attempts = w.fake.requests.filter((r) => r.path.endsWith("/executor-episodes"));
    assert.equal(attempts.length, 2);
    const keys = attempts.map((r) => (r.body as { idempotency_key: string }).idempotency_key);
    assert.equal(keys[0], keys[1]);
    assert.equal(attempts[1]?.headers["idempotency-key"], keys[1]);
    assert.equal(w.fake.episodes.size, 1);
    assert.equal(slot.client, "codex");
  } finally {
    await w.close();
  }
});

test("checkout gives up as unavailable after three failed attempts, and as rejected on a 404", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    w.fake.fail("/executor-episodes", 502, 3);
    await rejects(checkout(ctx, { workItem: "HELM-910", client: "claude-code" }), "unavailable");
    assert.equal(loadSlot(ctx), null);
    w.fake.fail("/executor-episodes", 404, 1, { error: "work_item_not_found" });
    await rejects(checkout(ctx, { workItem: "HELM-999", client: "claude-code" }), "rejected", /work_item_not_found/);
    w.fake.fail("/executor-episodes", 403, 1, { error: "no_authority" });
    await rejects(checkout(ctx, { workItem: "HELM-910", client: "claude-code" }), "rejected", /no authority.*enroll this machine credential/);
  } finally {
    await w.close();
  }
});

test("checkout validates its inputs before any request", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    const before = w.fake.requests.length;
    await rejects(checkout(ctx, { workItem: "../etc/passwd", client: "claude-code" }), "usage");
    await rejects(checkout(ctx, { workItem: "x y", client: "claude-code" }), "usage");
    await rejects(checkout(ctx, { workItem: "HELM-910", client: "vim" }), "usage");
    const noOrg = makeCtx({ HELM_EXECUTOR_HOME: w.home, HELM_EXECUTOR_CP_URL: w.fake.url }, { now: w.clock.now, sleep: w.clock.sleep, slot: "other" });
    // The stored credential carries the organization from login, so wipe it for this case.
    const { loadCredentials, saveCredentials } = await import("./state.js");
    const creds = loadCredentials(noOrg);
    assert.ok(creds);
    const { org_id: _org, ...withoutOrg } = creds;
    saveCredentials(noOrg, withoutOrg);
    await rejects(checkout(noOrg, { workItem: "HELM-910", client: "claude-code" }), "usage", /organization/);
    assert.equal(w.fake.requests.length, before);
  } finally {
    await w.close();
  }
});

test("checkout without a login is not_logged_in", async () => {
  const w = await world();
  try {
    await rejects(checkout(w.ctx(), { workItem: "HELM-910", client: "claude-code" }), "not_logged_in");
  } finally {
    await w.close();
  }
});

test("work item ids are percent-encoded in the request path", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    await checkout(ctx, { workItem: "a:b.c_d-1", client: "claude-code" });
    assert.ok(w.fake.requests.some((r) => r.path.endsWith("/work-items/a%3Ab.c_d-1/executor-episodes")));
  } finally {
    await w.close();
  }
});

test("stop ends the episode at the control plane and clears the slot; an already-ended episode still counts", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    assert.equal(await stop(ctx, { local: false }), true);
    assert.equal(loadSlot(ctx), null);
    assert.equal([...w.fake.episodes.values()][0]?.stopped, true);
    assert.equal(await stop(ctx, { local: false }), false);

    const again = await checkedOut(w, "HELM-911");
    [...w.fake.episodes.values()].at(-1)!.stopped = true;
    assert.equal(await stop(again, { local: false }), true);
    assert.equal(loadSlot(again), null);
  } finally {
    await w.close();
  }
});

test("stop keeps the slot when the control plane cannot be reached, and --local clears it anyway", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    w.fake.fail("/stop", 503, 1);
    await rejects(stop(ctx, { local: false }), "unavailable");
    assert.ok(loadSlot(ctx));
    assert.equal(await stop(ctx, { local: true }), true);
    assert.equal(loadSlot(ctx), null);
  } finally {
    await w.close();
  }
});

test("stop: a 404 or 410 counts as stopped, a 409 or 403 keeps the slot and is rejected", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w);
    for (const status of [409, 403]) {
      w.fake.fail("/stop", status, 1);
      await rejects(stop(ctx, { local: false }), "rejected");
      assert.ok(loadSlot(ctx), `slot kept on ${status}`);
    }
    w.fake.fail("/stop", 410, 1);
    assert.equal(await stop(ctx, { local: false }), true);
    assert.equal(loadSlot(ctx), null);
    const again = await checkedOut(w, "HELM-912");
    w.fake.fail("/stop", 404, 1);
    assert.equal(await stop(again, { local: false }), true);
    assert.equal(loadSlot(again), null);
  } finally {
    await w.close();
  }
});
