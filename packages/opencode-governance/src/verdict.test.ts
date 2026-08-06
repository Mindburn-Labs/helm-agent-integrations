import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isAuthorized,
  normalizeVerdict,
  verdictToPermissionStatus,
} from "./verdict.js";

describe("normalizeVerdict", () => {
  it("accepts exact kernel verdicts case-insensitively", () => {
    assert.equal(normalizeVerdict("ALLOW"), "ALLOW");
    assert.equal(normalizeVerdict("deny"), "DENY");
    assert.equal(normalizeVerdict(" Escalate "), "ESCALATE");
  });

  it("fails closed on unknown, missing, or non-string material", () => {
    assert.equal(normalizeVerdict("ALLOW_WITH_CONDITIONS"), "UNKNOWN");
    assert.equal(normalizeVerdict("PERMIT"), "UNKNOWN");
    assert.equal(normalizeVerdict("ask"), "UNKNOWN");
    assert.equal(normalizeVerdict(""), "UNKNOWN");
    assert.equal(normalizeVerdict(undefined), "UNKNOWN");
    assert.equal(normalizeVerdict(null), "UNKNOWN");
    assert.equal(normalizeVerdict(42), "UNKNOWN");
    assert.equal(normalizeVerdict({ verdict: "ALLOW" }), "UNKNOWN");
    assert.equal(normalizeVerdict(["ALLOW"]), "UNKNOWN");
  });
});

describe("verdictToPermissionStatus", () => {
  it("maps ALLOW->allow, ESCALATE->ask, DENY->deny", () => {
    assert.equal(verdictToPermissionStatus("ALLOW"), "allow");
    assert.equal(verdictToPermissionStatus("ESCALATE"), "ask");
    assert.equal(verdictToPermissionStatus("DENY"), "deny");
  });

  it("maps UNKNOWN to deny, never ask", () => {
    assert.equal(verdictToPermissionStatus("UNKNOWN"), "deny");
  });
});

describe("isAuthorized", () => {
  it("authorizes only an exact ALLOW", () => {
    assert.equal(isAuthorized("ALLOW"), true);
    assert.equal(isAuthorized("DENY"), false);
    assert.equal(isAuthorized("ESCALATE"), false);
    assert.equal(isAuthorized("UNKNOWN"), false);
  });
});
