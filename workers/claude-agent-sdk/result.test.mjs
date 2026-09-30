import assert from "node:assert/strict";
import test from "node:test";
import { OutcomeTracker } from "@mindburn/helm-worker-contract";
import { normalizeToolResult } from "./result.mjs";

test("the hook parks on structured, plain-text and MCP content-only escalation results", () => {
  const payload = { status: "escalated", attempt_id: "att-1" };
  const text = JSON.stringify(payload);
  for (const response of [text, { content: text }, [{ type: "text", text }],
    { content: [{ type: "text", text }] },
    { content: [{ type: "text", text }], structuredContent: payload }]) {
    const tracker = new OutcomeTracker();
    const observation = tracker.observe("github_pull_request_create_draft", {}, normalizeToolResult(response));
    assert.equal(observation.stop, true);
    assert.deepEqual(tracker.attempts, ["att-1"]);
  }
});

test("a failed report cannot complete the episode", () => {
  const tracker = new OutcomeTracker();
  tracker.observe("helm_work_report", { status: "done", summary: "done" },
    normalizeToolResult({ isError: true, content: [{ type: "text", text: "failed" }] }));
  assert.equal(tracker.report, null);
});
