import test from "node:test";
import assert from "node:assert/strict";
import {
  HelmKernelEvaluator,
  TOOL_INPUT_PAYLOAD_CAP,
  canonicalJson,
  kernelToolInput,
  toolInputSha256,
  type FetchLike,
  type KernelEvaluationRequest,
} from "./kernel-evaluator.js";

function evaluation(toolInput: unknown): KernelEvaluationRequest {
  return {
    ask: {
      toolCallId: "call-1",
      title: "Run command",
      kind: "execute",
      isRead: false,
      sessionId: "session-1",
      toolInput,
    },
    tier: "standard",
    agent: "claude",
    cwd: "/work/project",
    policy: "ask",
  };
}

test("kernel tool input is canonical and rejects partial authorization", () => {
  assert.equal(canonicalJson({ b: 1, a: { z: 2, y: 3 } }), '{"a":{"y":3,"z":2},"b":1}');
  const input = { rawInput: { command: "printf safe" } };
  assert.deepEqual(kernelToolInput(input).tool_input, input);
  assert.equal(kernelToolInput(input).tool_input_sha256, toolInputSha256(input));
  assert.throws(
    () => kernelToolInput({ rawInput: { command: "x".repeat(TOOL_INPUT_PAYLOAD_CAP) } }),
    /refusing partial authorization/,
  );
  assert.throws(() => kernelToolInput({ value: 1n }), /unsupported bigint/);
  assert.throws(() => kernelToolInput({ value: undefined }), /unsupported undefined/);
  assert.throws(() => kernelToolInput({ value: Number.NaN }), /non-finite number/);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => kernelToolInput(cyclic), /contains a cycle/);
});

test("kernel evaluator forwards the complete tool input to the evaluation contract", async () => {
  let posted: Record<string, unknown> | undefined;
  const fetch: FetchLike = async (_url, init) => {
    posted = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ verdict: "ALLOW", decision_id: "decision-1" }),
      text: async () => "",
    };
  };
  const input = { rawInput: { command: "printf %s hello", argv: ["printf", "hello"] } };
  const evaluator = new HelmKernelEvaluator({
    apiKey: "test-api-key",
    tenantId: "tenant-1",
    principal: "principal-1",
    fetch,
  });
  const verdict = await evaluator.evaluate(evaluation(input));
  assert.equal(verdict.verdict, "ALLOW");
  assert.ok(posted);
  const args = ((posted.context as Record<string, unknown>).args as Record<string, unknown>);
  assert.deepEqual(args.tool_input, input);
  assert.equal(args.tool_input_sha256, toolInputSha256(input));
});

test("kernel evaluator rejects plaintext non-loopback transport before sending credentials", async () => {
  let called = false;
  const evaluator = new HelmKernelEvaluator({
    apiKey: "secret",
    tenantId: "tenant-1",
    principal: "principal-1",
    helmUrl: "http://kernel.example.test",
    fetch: async () => {
      called = true;
      throw new Error("must not be called");
    },
  });
  await assert.rejects(evaluator.evaluate(evaluation({ command: "true" })), /plaintext helmUrl/);
  assert.equal(called, false);
});

test("kernel evaluator rejects contradictory authority fields", async () => {
  const evaluator = new HelmKernelEvaluator({
    apiKey: "test-api-key",
    tenantId: "tenant-1",
    principal: "principal-1",
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ decision: { verdict: "ALLOW" }, verdict: "DENY" }),
      text: async () => "",
    }),
  });
  await assert.rejects(evaluator.evaluate(evaluation({ command: "true" })), /conflicting verdict fields/);
});
