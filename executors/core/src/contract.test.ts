import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEpisodeGrant, parseEpisodeTokenGrant, parseMachineToken } from "./contract.js";
import { ExecutorError } from "./errors.js";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const mismatch = (fn: () => unknown, field: string): void =>
  assert.throws(fn, (e: unknown) => e instanceof ExecutorError && e.code === "internal" && e.message.includes(`"${field}"`));

test("the refresh answer may carry token_expires_at, expires_in, or the whole create body", () => {
  assert.deepEqual(parseEpisodeTokenGrant({ token: "t", token_expires_at: "2026-10-08T12:15:00.000Z" }, NOW), { token: "t", token_expires_at: "2026-10-08T12:15:00.000Z" });
  assert.deepEqual(parseEpisodeTokenGrant({ token: "t", expires_in: 900 }, NOW), { token: "t", token_expires_at: "2026-10-08T12:15:00.000Z" });
  const create = { episode_id: "e", work_item_id: "w", token: "t", token_expires_at: "2026-10-08T12:15:00.000Z", deadline: "2026-10-08T13:00:00.000Z" };
  assert.equal(parseEpisodeTokenGrant(create, NOW).token, "t");
  assert.deepEqual(parseEpisodeGrant(create), create);
});

test("a body that does not fit the contract is an internal error that names the missing field", () => {
  mismatch(() => parseEpisodeTokenGrant({ token: "t" }, NOW), "expires_in");
  mismatch(() => parseEpisodeTokenGrant({ token_expires_at: "2026-10-08T12:15:00.000Z" }, NOW), "token");
  mismatch(() => parseEpisodeTokenGrant({ token: "t", token_expires_at: "not a time" }, NOW), "token_expires_at");
  mismatch(() => parseEpisodeGrant({ episode_id: "e", work_item_id: "w", token: "t", token_expires_at: "2026-10-08T12:15:00.000Z" }), "deadline");
  mismatch(() => parseMachineToken({ access_token: "a", expires_in: 900 }), "refresh_token");
  assert.throws(() => parseEpisodeGrant([]), (e: unknown) => e instanceof ExecutorError && e.code === "internal");
  assert.throws(() => parseEpisodeGrant(null), (e: unknown) => e instanceof ExecutorError && e.code === "internal");
});
