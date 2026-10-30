import assert from "node:assert/strict";
import { test } from "node:test";
import { checkout } from "./commands/checkout.js";
import { observe } from "./commands/observe.js";
import { otelResourceAttributes } from "./commands/status.js";
import { ExecutorError } from "./errors.js";
import { runCli } from "./main.js";
import { loadPendingCheckout, loadSlot } from "./state.js";
import { captureIo, loggedIn, schemaValidator, world } from "./test-utils.js";

const validObservation = schemaValidator("observation.schema.json");

test("checkout --host binds the request, slot, hook observation and env to the same host", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    const io = captureIo();
    assert.equal(await runCli(["checkout", "work-hosted", "--client", "codex", "--host", "console-runner", "--json"], w.env(), io.io, { now: w.clock.now, sleep: w.clock.sleep }), 0);
    assert.equal(JSON.parse(io.out()).executor_host, "console-runner");
    assert.equal(loadSlot(ctx)?.executor_host, "console-runner");
    const request = w.fake.requests.find((r) => r.path.endsWith("/executor-episodes"));
    assert.equal((request?.body as { executor_host?: string }).executor_host, "console-runner");
    assert.equal([...w.fake.episodes.values()][0]?.executorHost, "console-runner");
    const posted = await observe(ctx, { client: "codex", event: "SessionStart", input: JSON.stringify({ session_id: "session-hosted", executor_host: "untrusted-hook-value" }) });
    assert.equal(posted.status, "posted");
    const body = w.fake.observations[0];
    assert.equal(validObservation(body), null);
    assert.equal((body as { executor_host?: string }).executor_host, "console-runner");
    const attrs = otelResourceAttributes(w.ctx({ env: { OTEL_RESOURCE_ATTRIBUTES: "team.id=eng,helm.executor_host=forged" } }));
    assert.match(attrs, /(?:^|,)helm\.executor_host=console-runner(?:,|$)/);
    assert.ok(!attrs.includes("forged"));
    assert.equal((await checkout(ctx, { workItem: "work-hosted", client: "codex", host: "console-runner" })).reused, true);
    await assert.rejects(checkout(ctx, { workItem: "work-hosted", client: "codex" }), (e: unknown) => e instanceof ExecutorError && e.code === "usage");
  } finally { await w.close(); }
});

test("omitted host preserves legacy wire and strips a caller-supplied OTEL host", async () => {
  const w = await world();
  try {
    const ctx = await loggedIn(w);
    const { slot } = await checkout(ctx, { workItem: "work-bare", client: "codex" });
    assert.equal(Object.hasOwn(slot, "executor_host"), false);
    const request = w.fake.requests.find((r) => r.path.endsWith("/executor-episodes"));
    assert.equal(Object.hasOwn(request?.body as object, "executor_host"), false);
    const attrs = otelResourceAttributes(w.ctx({ env: { OTEL_RESOURCE_ATTRIBUTES: "helm.executor_host=forged" } }));
    assert.ok(!attrs.includes("executor_host"));
    assert.equal((await checkout(ctx, { workItem: "work-bare", client: "codex" })).reused, true);
    const count = w.fake.requests.length;
    for (const host of ["", "unknown", "Console-Runner", "console-runner "]) {
      const io = captureIo();
      assert.equal(await runCli(["checkout", "work-bare", "--client", "codex", "--host", host], w.env(), io.io), 2);
      assert.match(io.err(), /--host must be one of console-runner/);
    }
    assert.equal(w.fake.requests.length, count, "invalid hosts must fail before network access");
  } finally { await w.close(); }
});

test("a lost hosted checkout reuses its host-bound key; a different host gets a new key", async () => {
  for (const sameHost of [true, false]) {
    const w = await world();
    try {
      const ctx = await loggedIn(w);
      const opts = { workItem: "work-lost", client: "codex", host: "console-runner" };
      w.fake.dropResponse("/executor-episodes", 3);
      await assert.rejects(checkout(ctx, opts), (e: unknown) => e instanceof ExecutorError && e.code === "unavailable");
      const pending = loadPendingCheckout(ctx)!;
      assert.equal(pending.executor_host, "console-runner");
      if (sameHost) {
        const { slot } = await checkout(ctx, opts);
        assert.equal(slot.executor_host, "console-runner");
        assert.equal(w.fake.episodes.size, 1);
        assert.equal(loadPendingCheckout(ctx), null);
      } else {
        w.fake.fail("/executor-episodes", 503, 3);
        await assert.rejects(checkout(ctx, { workItem: opts.workItem, client: opts.client }), (e: unknown) => e instanceof ExecutorError && e.code === "unavailable");
        assert.notEqual(loadPendingCheckout(ctx)?.key, pending.key);
        assert.equal(Object.hasOwn(loadPendingCheckout(ctx)!, "executor_host"), false);
      }
    } finally { await w.close(); }
  }
});
