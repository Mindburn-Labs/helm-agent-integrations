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

test("expires_in is added to the control plane's clock, so the skew the caller measured is carried along", () => {
  assert.deepEqual(parseEpisodeTokenGrant({ token: "t", expires_in: 900 }, NOW, 20 * 60_000), { token: "t", token_expires_at: "2026-10-08T12:35:00.000Z" });
});

test("a token with a line break, a space or a control character is refused, so stdout stays one line and a header stays one value", () => {
  const unusable = (fn: () => unknown, field: string): void =>
    assert.throws(fn, (e: unknown) => e instanceof ExecutorError && e.code === "internal" && e.message.includes(`"${field}"`) && /unusable/.test(e.message));
  for (const bad of ["abc\ndef", "abc def", "abc\r", "abc\u0000", "abcé", "tok en"]) {
    unusable(() => parseEpisodeTokenGrant({ token: bad, expires_in: 900 }, NOW), "token");
    unusable(() => parseEpisodeGrant({ episode_id: "e", work_item_id: "w", token: bad, token_expires_at: "2026-10-08T12:15:00.000Z", deadline: "2026-10-08T13:00:00.000Z" }), "token");
    unusable(() => parseMachineToken({ access_token: bad, expires_in: 900, refresh_token: "r", refresh_expires_in: 99, credential_id: "c", subject: "s", workspace_id: "w" }), "access_token");
    unusable(() => parseMachineToken({ access_token: "a", expires_in: 900, refresh_token: bad, refresh_expires_in: 99, credential_id: "c", subject: "s", workspace_id: "w" }), "refresh_token");
  }
  assert.equal(parseEpisodeTokenGrant({ token: "eyJhbGciOiJub25lIn0.e30.c2ln-_~+/=", expires_in: 900 }, NOW).token, "eyJhbGciOiJub25lIn0.e30.c2ln-_~+/=");
});
