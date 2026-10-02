import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runConformance } from "../conformance/run.mjs";

const failures = (result) => result.checks.filter((c) => c.status === "FAIL").map((c) => `${c.name}: ${c.detail}`);

test("conformance passes against the fake control plane and edge", async () => {
  const result = await runConformance({ fake: true });
  assert.deepEqual(failures(result), []);
  assert.ok(result.checks.filter((c) => c.status === "PASS").length >= 14);
  assert.equal(result.checks.find((c) => c.name.startsWith("Claude Code drives"))?.status, "SKIP");
});

// Drives the installed claude binary. CI has none, so this runs on request: HELM_EXECUTOR_TEST_CLAUDE=1 npm test
test("conformance passes with the installed Claude Code driving the session profile", async (t) => {
  if (process.env.HELM_EXECUTOR_TEST_CLAUDE !== "1") return t.skip("set HELM_EXECUTOR_TEST_CLAUDE=1 to run the installed claude");
  assert.equal(spawnSync("claude", ["--version"]).status, 0, "claude is not on PATH");
  const result = await runConformance({ fake: true, claude: true });
  assert.deepEqual(failures(result), []);
  assert.ok(result.checks.some((c) => c.name.includes("raw git push was denied") && c.status === "PASS"));
});
