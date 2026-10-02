import assert from "node:assert/strict";
import { test } from "node:test";
import { checkout } from "./commands/checkout.js";
import { otelResourceAttributes, renderEnv, renderStatus, statusReport } from "./commands/status.js";
import { stop } from "./commands/stop.js";
import { ExecutorError } from "./errors.js";
import { checkedOut, loggedIn, world } from "./test-utils.js";

const rejects = (fn: () => unknown, code: string): void => assert.throws(fn, (e: unknown) => e instanceof ExecutorError && e.code === code);

test("the resource attributes name the work item, the episode and the client, and keep what the launcher already set", async () => {
  const w = await world();
  try {
    const ctx = await checkedOut(w, "HELM-910", "codex");
    const episodeId = [...w.fake.episodes.values()][0]?.episodeId;
    assert.equal(otelResourceAttributes(ctx), `helm.work_item_id=HELM-910,helm.episode_id=${episodeId},helm.executor=codex`);

    const withTeam = w.ctx({ env: { OTEL_RESOURCE_ATTRIBUTES: "team.id=platform, helm.work_item_id=stale ,helm.executor=other,cost_center=eng-123" } });
    assert.equal(otelResourceAttributes(withTeam), `team.id=platform,cost_center=eng-123,helm.work_item_id=HELM-910,helm.episode_id=${episodeId},helm.executor=codex`);
  } finally {
    await w.close();
  }
});

test("values are percent-encoded and the shell form is safely quoted", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    await checkout(ctx, { workItem: "lane:a.b_c-1", client: "claude-code" });
    const attrs = otelResourceAttributes(ctx);
    assert.match(attrs, /^helm\.work_item_id=lane%3Aa\.b_c-1,/);
    assert.equal(renderEnv(attrs, "plain"), `OTEL_RESOURCE_ATTRIBUTES=${attrs}\n`);
    assert.equal(renderEnv("a=b'c", "shell"), "export OTEL_RESOURCE_ATTRIBUTES='a=b'\\''c'\n");
    assert.deepEqual(JSON.parse(renderEnv(attrs, "json")), { OTEL_RESOURCE_ATTRIBUTES: attrs });
  } finally {
    await w.close();
  }
});

test("env needs a live episode: none is no_episode, an ended one is episode_ended", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    rejects(() => otelResourceAttributes(ctx), "no_episode");
    await checkout(ctx, { workItem: "HELM-910", client: "claude-code" });
    [...w.fake.episodes.values()][0]!.stopped = true;
    const { episodeToken } = await import("./commands/token.js");
    w.clock.advance(60_000);
    await assert.rejects(episodeToken(ctx), (e: unknown) => e instanceof ExecutorError && e.code === "episode_ended");
    rejects(() => otelResourceAttributes(ctx), "episode_ended");
    await stop(ctx, { local: true });
    rejects(() => otelResourceAttributes(ctx), "no_episode");
  } finally {
    await w.close();
  }
});

test("status is honest about each state and never carries a credential", async () => {
  const w = await world();
  try {
    const empty = statusReport(w.ctx());
    assert.equal(empty.logged_in, false);
    assert.equal(empty.workspace_id, null);
    assert.equal(empty.episode, null);
    assert.equal(renderStatus(empty), "logged in: no\nslot: default\nepisode: none\nobserve: last ok never\n");

    const ctx = await checkedOut(w);
    const live = statusReport(ctx);
    assert.equal(live.logged_in, true);
    assert.equal(live.episode?.seconds_left, 3600);
    assert.equal(live.episode?.ended, null);
    w.clock.advance(600_000);
    assert.equal(statusReport(ctx).episode?.seconds_left, 3000);
    w.clock.advance(4_000_000);
    assert.equal(statusReport(ctx).episode?.seconds_left, 0, "past the deadline it reads zero, not negative");
    assert.match(renderStatus(live), /^logged in: yes \(workspace .*\)\nslot: default\nepisode: HELM-910 \(.*, claude-code\), 3600 s left before the deadline\n/);

    const text = JSON.stringify(live) + renderStatus(live);
    for (const secret of ["helm_at_", "helm_rt_", "eyJ"]) assert.ok(!text.includes(secret), secret);
  } finally {
    await w.close();
  }
});
