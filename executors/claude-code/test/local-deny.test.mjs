import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {test} from "node:test";
import {fileURLToPath} from "node:url";
import {shellDeny, toolDeny} from "../src/local-deny.mjs";

const script = fileURLToPath(new URL("../src/local-deny.mjs", import.meta.url));

test("raw provider writes and direct provider HTTP are locally refused", () => {
  for (const command of [
    "git push origin main", "git -C /tmp/repo push origin HEAD",
    "env MODE=x /usr/bin/git -c core.hooksPath=/tmp/hooks push origin x",
    "bash -lc 'gh --repo Mindburn-Labs/repo pr merge 1 --squash'",
    "kubectl get pods", "flux reconcile source git platform",
    "linear issue update HELM-1", "curl --fail https://api.github.com/repos/Mindburn-Labs/repo",
    "wget https://api.linear.app/graphql", "echo ok && /usr/bin/curl https://github.com/api/v3",
  ]) assert.ok(shellDeny(command), command);
  assert.ok(toolDeny({tool_name: "mcp__linear__save_issue", tool_input: {title: "test"}}));
  assert.equal(toolDeny({tool_name: "mcp__helm__github_pull_request_merge", tool_input: {}}), null);
});

test("allowed local reads and HELM edge calls retain normal permission flow", () => {
  for (const command of ["git status --short", "gh pr view 1", "curl https://executor.qa.example/mcp", "printf 'local check'"]) {
    assert.equal(shellDeny(command), null, command);
  }
  assert.equal(toolDeny({tool_name: "Agent", tool_input: {prompt: "check the work"}}), null);
});

test("managed hook emits only a deny decision and exits nonzero for invalid input", () => {
  const denied = spawnSync(process.execPath, [script], {encoding: "utf8", input: JSON.stringify({tool_name: "Bash", tool_input: {command: "git push origin HEAD"}})});
  assert.equal(denied.status, 0);
  assert.deepEqual(JSON.parse(denied.stdout), {hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Raw git push is disabled"}});
  const allowed = spawnSync(process.execPath, [script], {encoding: "utf8", input: JSON.stringify({tool_name: "Bash", tool_input: {command: "git status"}})});
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout, "");
  for (const raw of ["{", "[]", "", "x".repeat(129 * 1024)]) {
    const failed = spawnSync(process.execPath, [script], {encoding: "utf8", input: raw});
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, "");
  }
});
