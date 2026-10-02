// The helpers run inside Claude Code and Codex, which give up on them: an MCP headersHelper after 10 seconds, a hook
// that blocks a tool call for as long as it runs. These tests hang the control plane and check the documented caps.

import assert from "node:assert/strict";
import { test } from "node:test";
import { observe } from "./commands/observe.js";
import { episodeToken } from "./commands/token.js";
import { ExecutorError } from "./errors.js";
import { COALESCE_MS } from "./commands/token.js";
import { checkedOut, world } from "./test-utils.js";

const hook = JSON.stringify({ session_id: "s", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "true" }, tool_use_id: "toolu_1" });
const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const start = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - start };
};

test("a control plane that never answers cannot hold the helpers past their caps", async () => {
  const [a, b, c] = await Promise.all([world(), world(), world()]);
  try {
    // observe: gives up on a hung post after 3 seconds, well inside its 5 second budget, and reports a failed outcome.
    const observing = await checkedOut(a);
    a.fake.delay("/observations", 30_000);

    // token with a good cached token: the hung mint is abandoned and the cached token is printed.
    const cached = await checkedOut(b);
    const original = (await episodeToken(cached)) as string;
    b.clock.advance(COALESCE_MS + 1_000);
    b.fake.delay("/token", 30_000);

    // token with nothing usable cached: unavailable, inside the 8 second cap.
    const bare = await checkedOut(c);
    c.clock.advance(14.5 * 60_000);
    c.fake.delay("/token", 30_000);

    const [o, t1, t2] = await Promise.all([
      timed(() => observe(observing, { client: "claude-code", event: "PostToolUse", input: hook })),
      timed(() => episodeToken(cached)),
      timed(async () => {
        try {
          return await episodeToken(bare);
        } catch (err) {
          return err;
        }
      }),
    ]);
    assert.equal(o.value.status, "failed");
    assert.ok(o.ms < 4_500, `observe took ${o.ms} ms`);
    assert.equal(t1.value, original);
    assert.ok(t1.ms < 7_500, `token with a cache took ${t1.ms} ms`);
    assert.ok(t2.value instanceof ExecutorError && t2.value.code === "unavailable");
    assert.ok(t2.ms < 8_500, `token without a cache took ${t2.ms} ms`);
  } finally {
    await Promise.all([a.close(), b.close(), c.close()]);
  }
});
