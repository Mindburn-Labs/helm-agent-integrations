import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GovernanceConfig } from "./config.js";
import {
  BOUNDARY_CLOSE_RECORD,
  BOUNDARY_DENY_RECORD,
  BOUNDARY_OPEN_RECORD,
  MemoryEvidenceSink,
  PERMISSION_DECISION_RECORD,
  type BoundaryDenyRecord,
  type BoundaryOpenRecord,
  type PermissionDecisionRecord,
} from "./evidence.js";
import type { KernelClient, KernelOutcome } from "./kernel.js";
import type { OpencodeHooks, OpencodePermission } from "./opencode-types.js";
import { HelmGovernanceDeny, VERDICT_CACHE_MAX_ENTRIES, createGovernanceHooks } from "./plugin.js";

const CONFIG: GovernanceConfig = {
  mode: "http",
  kernelUrl: "http://127.0.0.1:7714",
  apiKey: "key",
  kernelBinaryArgs: [],
  tenantId: "tenant",
  principal: "agent",
  riskClass: "T2",
  effectClass: "E4",
  evidenceDir: "/tmp/unused",
  timeoutMs: 1000,
  strictEvidence: true,
};

function kernelReturning(outcome: KernelOutcome | (() => KernelOutcome)): KernelClient & { calls: number } {
  return {
    calls: 0,
    evaluate() {
      this.calls += 1;
      return Promise.resolve(typeof outcome === "function" ? outcome() : outcome);
    },
  };
}

function makeHooks(kernel: KernelClient, sink: MemoryEvidenceSink, config = CONFIG): OpencodeHooks {
  return createGovernanceHooks({
    config,
    kernel,
    sink,
    now: () => new Date("2026-07-24T12:00:00Z"),
    stderr: () => {},
  });
}

const TOOL_INPUT = { tool: "bash", sessionID: "ses_1", callID: "call_1" };

function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined, "expected hook to be defined");
  return value;
}

async function runBefore(
  hooks: OpencodeHooks,
  input: typeof TOOL_INPUT,
  args: unknown,
): Promise<void> {
  return required(hooks["tool.execute.before"])(input, { args });
}

function permissionInput(overrides: Partial<OpencodePermission> = {}): OpencodePermission {
  return {
    id: "per_1",
    type: "bash",
    pattern: ["rm *"],
    sessionID: "ses_1",
    messageID: "msg_1",
    callID: "call_1",
    title: "bash rm *",
    metadata: { command: "rm -rf /" },
    time: { created: 0 },
    ...overrides,
  };
}

describe("permission.ask mapping", () => {
  it("maps kernel ALLOW to allow", async () => {
    const sink = new MemoryEvidenceSink();
    const hooks = makeHooks(kernelReturning({ kind: "verdict", verdict: "ALLOW", raw: {} }), sink);
    const output = { status: "ask" as "ask" | "deny" | "allow" };
    await hooks["permission.ask"]?.(permissionInput(), output);
    assert.equal(output.status, "allow");
    const record = sink.records[0] as PermissionDecisionRecord;
    assert.equal(record.record_type, PERMISSION_DECISION_RECORD);
    assert.equal(record.verdict, "ALLOW");
    assert.equal(record.mapped_status, "allow");
    assert.equal(record.locally_synthesized, false);
  });

  it("maps kernel ESCALATE to ask (never auto-allow)", async () => {
    const hooks = makeHooks(kernelReturning({ kind: "verdict", verdict: "ESCALATE", raw: {} }), new MemoryEvidenceSink());
    const output = { status: "allow" as "ask" | "deny" | "allow" };
    await hooks["permission.ask"]?.(permissionInput(), output);
    assert.equal(output.status, "ask");
  });

  it("maps kernel DENY to deny", async () => {
    const hooks = makeHooks(
      kernelReturning({ kind: "verdict", verdict: "DENY", reasonCode: "DESTRUCTIVE", raw: {} }),
      new MemoryEvidenceSink(),
    );
    const output = { status: "ask" as "ask" | "deny" | "allow" };
    await hooks["permission.ask"]?.(permissionInput(), output);
    assert.equal(output.status, "deny");
  });

  it("fails closed to deny when the kernel is unreachable", async () => {
    const sink = new MemoryEvidenceSink();
    const hooks = makeHooks(
      kernelReturning({ kind: "error", reasonCode: "KERNEL_UNAVAILABLE", message: "down" }),
      sink,
    );
    const output = { status: "ask" as "ask" | "deny" | "allow" };
    await hooks["permission.ask"]?.(permissionInput(), output);
    assert.equal(output.status, "deny");
    const record = sink.records[0] as PermissionDecisionRecord;
    assert.equal(record.verdict, "UNKNOWN");
    assert.equal(record.locally_synthesized, true);
    assert.equal(record.reason_code, "KERNEL_UNAVAILABLE");
  });

  it("forces deny when the evidence sink fails on the permission path", async () => {
    const sink = new MemoryEvidenceSink();
    sink.failure = new Error("read-only fs");
    const hooks = makeHooks(kernelReturning({ kind: "verdict", verdict: "ALLOW", raw: {} }), sink);
    const output = { status: "ask" as "ask" | "deny" | "allow" };
    await hooks["permission.ask"]?.(permissionInput(), output);
    assert.equal(output.status, "deny");
  });
});

describe("tool.execute.before enforcement", () => {
  it("allows execution on kernel ALLOW and mints an open record", async () => {
    const sink = new MemoryEvidenceSink();
    const hooks = makeHooks(kernelReturning({ kind: "verdict", verdict: "ALLOW", decisionId: "d1", raw: {} }), sink);
    await hooks["tool.execute.before"]?.(TOOL_INPUT, { args: { command: "ls" } });
    const record = sink.records[0] as BoundaryOpenRecord;
    assert.equal(record.record_type, BOUNDARY_OPEN_RECORD);
    assert.equal(record.tool, "bash");
    assert.equal(record.verdict, "ALLOW");
    assert.equal(record.decision_id, "d1");
    assert.equal(typeof record.args_hash, "string");
    assert.equal(record.args_hash.length, 64);
  });

  it("blocks on kernel DENY and records the deny", async () => {
    const sink = new MemoryEvidenceSink();
    const hooks = makeHooks(
      kernelReturning({ kind: "verdict", verdict: "DENY", reasonCode: "DESTRUCTIVE", raw: {} }),
      sink,
    );
    await assert.rejects(
      () => runBefore(hooks, TOOL_INPUT, { command: "rm -rf /" }),
      (error: unknown) => {
        assert.ok(error instanceof HelmGovernanceDeny);
        assert.equal(error.verdict, "DENY");
        assert.equal(error.reasonCode, "DESTRUCTIVE");
        return true;
      },
    );
    const record = sink.records[0] as BoundaryDenyRecord;
    assert.equal(record.record_type, BOUNDARY_DENY_RECORD);
    assert.equal(record.verdict, "DENY");
    assert.equal(record.reason_code, "DESTRUCTIVE");
  });

  it("blocks when the kernel is unreachable (locally synthesized deny)", async () => {
    const sink = new MemoryEvidenceSink();
    const hooks = makeHooks(
      kernelReturning({ kind: "error", reasonCode: "KERNEL_UNAVAILABLE", message: "down" }),
      sink,
    );
    await assert.rejects(
      () => runBefore(hooks, TOOL_INPUT, {}),
      (error: unknown) => {
        assert.ok(error instanceof HelmGovernanceDeny);
        assert.equal(error.verdict, "UNKNOWN");
        assert.equal(error.reasonCode, "KERNEL_UNAVAILABLE");
        assert.equal(error.locallySynthesized, true);
        return true;
      },
    );
  });

  it("blocks on ESCALATE at the execution boundary (ask is not authorization)", async () => {
    const hooks = makeHooks(
      kernelReturning({ kind: "verdict", verdict: "ESCALATE", raw: {} }),
      new MemoryEvidenceSink(),
    );
    await assert.rejects(
      () => runBefore(hooks, TOOL_INPUT, {}),
      HelmGovernanceDeny,
    );
  });

  it("blocks in strict mode when the open-record sink fails", async () => {
    const sink = new MemoryEvidenceSink();
    sink.failure = new Error("disk full");
    const hooks = makeHooks(kernelReturning({ kind: "verdict", verdict: "ALLOW", raw: {} }), sink);
    await assert.rejects(
      () => runBefore(hooks, TOOL_INPUT, {}),
      (error: unknown) => {
        assert.ok(error instanceof HelmGovernanceDeny);
        assert.equal(error.reasonCode, "EVIDENCE_SINK_FAILURE");
        return true;
      },
    );
  });

  it("still denies when the sink fails on the deny path", async () => {
    const sink = new MemoryEvidenceSink();
    sink.failure = new Error("disk full");
    const hooks = makeHooks(
      kernelReturning({ kind: "verdict", verdict: "DENY", raw: {} }),
      sink,
    );
    await assert.rejects(
      () => runBefore(hooks, TOOL_INPUT, {}),
      (error: unknown) => {
        assert.ok(error instanceof HelmGovernanceDeny);
        assert.equal(error.verdict, "DENY");
        return true;
      },
    );
  });

  it("re-evaluates when args change under a reused callID (P1 UNBOUND_VERDICT_CACHE)", async () => {
    const kernel = kernelReturning({ kind: "verdict", verdict: "ALLOW", raw: {} });
    const hooks = makeHooks(kernel, new MemoryEvidenceSink());
    await runBefore(hooks, TOOL_INPUT, { command: "ls" });
    // Same session + callID, but mutated arguments: must NOT ride the cached verdict.
    await runBefore(hooks, TOOL_INPUT, { command: "rm -rf /" });
    assert.equal(kernel.calls, 2);
  });

  it("never caches ALLOW outcomes (every authorization is freshly evaluated)", async () => {
    const kernel = kernelReturning({ kind: "verdict", verdict: "ALLOW", raw: {} });
    const hooks = makeHooks(kernel, new MemoryEvidenceSink());
    await runBefore(hooks, TOOL_INPUT, { command: "ls" });
    await runBefore(hooks, TOOL_INPUT, { command: "ls" });
    assert.equal(kernel.calls, 2);
  });

  it("caches non-ALLOW outcomes for the byte-identical payload within the TTL", async () => {
    const kernel = kernelReturning({ kind: "verdict", verdict: "DENY", reasonCode: "P", raw: {} });
    const hooks = makeHooks(kernel, new MemoryEvidenceSink());
    await assert.rejects(() => runBefore(hooks, TOOL_INPUT, { command: "rm -rf /" }), HelmGovernanceDeny);
    await assert.rejects(() => runBefore(hooks, TOOL_INPUT, { command: "rm -rf /" }), HelmGovernanceDeny);
    assert.equal(kernel.calls, 1);
  });

  it("bounds the verdict cache so unique denies cannot exhaust memory (P2 UNBOUNDED_VERDICT_CACHE)", async () => {
    const kernel = kernelReturning({ kind: "verdict", verdict: "DENY", reasonCode: "P", raw: {} });
    const hooks = makeHooks(kernel, new MemoryEvidenceSink());
    const overflow = 50;
    // Fill the cache past its hard cap with unique denied calls.
    for (let index = 0; index < VERDICT_CACHE_MAX_ENTRIES + overflow; index += 1) {
      await assert.rejects(
        () =>
          runBefore(hooks, { tool: "bash", sessionID: "ses_1", callID: `call_${index}` }, {
            command: `cmd ${index}`,
          }),
        HelmGovernanceDeny,
      );
    }
    assert.equal(kernel.calls, VERDICT_CACHE_MAX_ENTRIES + overflow);
    // The first entry was evicted by the cap: repeating it re-evaluates.
    await assert.rejects(
      () => runBefore(hooks, { tool: "bash", sessionID: "ses_1", callID: "call_0" }, { command: "cmd 0" }),
      HelmGovernanceDeny,
    );
    assert.equal(kernel.calls, VERDICT_CACHE_MAX_ENTRIES + overflow + 1);
  });
});

describe("tool.execute.after evidence tap", () => {
  it("mints a close record with args and output hashes", async () => {
    const sink = new MemoryEvidenceSink();
    const hooks = makeHooks(kernelReturning({ kind: "verdict", verdict: "ALLOW", raw: {} }), sink);
    await hooks["tool.execute.after"]?.(
      { ...TOOL_INPUT, args: { command: "ls" } },
      { title: "ls", output: "file.txt", metadata: {} },
    );
    const record = sink.records[0];
    assert.equal(record.record_type, BOUNDARY_CLOSE_RECORD);
    if (record.record_type === BOUNDARY_CLOSE_RECORD) {
      assert.equal(record.outcome, "completed");
      assert.equal(record.args_hash.length, 64);
      assert.equal(record.output_hash.length, 64);
      assert.notEqual(record.args_hash, record.output_hash);
    }
  });

  it("mints outcome 'error' when the hook output carries error markers (P3 CLOSE_RECORD_OUTCOME_HARDCODED)", async () => {
    const sink = new MemoryEvidenceSink();
    const hooks = makeHooks(kernelReturning({ kind: "verdict", verdict: "ALLOW", raw: {} }), sink);
    for (const metadata of [{ error: "exit 1" }, { isError: true }, { is_error: true }]) {
      sink.records.length = 0;
      await hooks["tool.execute.after"]?.(
        { ...TOOL_INPUT, args: {} },
        { title: "t", output: "boom", metadata },
      );
      const record = sink.records[0];
      assert.equal(record.record_type, BOUNDARY_CLOSE_RECORD);
      if (record.record_type === BOUNDARY_CLOSE_RECORD) {
        assert.equal(record.outcome, "error", JSON.stringify(metadata));
      }
    }
  });

  it("never throws on post-execution sink failure and arms the next-call gate in strict mode (P2 POST_EFFECT_EVIDENCE_THROW)", async () => {
    const sink = new MemoryEvidenceSink();
    sink.failure = new Error("disk full");
    const kernel = kernelReturning({ kind: "verdict", verdict: "ALLOW", raw: {} });
    const hooks = makeHooks(kernel, sink);
    // Post-execution sink failure: resolves without throwing.
    await hooks["tool.execute.after"]?.(
      { ...TOOL_INPUT, args: {} },
      { title: "t", output: "o", metadata: {} },
    );
    // Next pre-execution check is gated: deny with EVIDENCE_SINK_FAILURE,
    // without even consulting the kernel.
    await assert.rejects(
      () => runBefore(hooks, { tool: "read", sessionID: "ses_1", callID: "call_2" }, {}),
      (error: unknown) => {
        assert.ok(error instanceof HelmGovernanceDeny);
        assert.equal(error.reasonCode, "EVIDENCE_SINK_FAILURE");
        assert.equal(error.locallySynthesized, true);
        return true;
      },
    );
    assert.equal(kernel.calls, 0);
  });

  it("post-execution sink failure does not arm the gate in non-strict mode", async () => {
    const sink = new MemoryEvidenceSink();
    sink.failure = new Error("disk full");
    const kernel = kernelReturning({ kind: "verdict", verdict: "ALLOW", raw: {} });
    const hooks = makeHooks(kernel, sink, { ...CONFIG, strictEvidence: false });
    await hooks["tool.execute.after"]?.(
      { ...TOOL_INPUT, args: {} },
      { title: "t", output: "o", metadata: {} },
    );
    sink.failure = undefined;
    await runBefore(hooks, { tool: "read", sessionID: "ses_1", callID: "call_2" }, {});
    assert.equal(kernel.calls, 1);
  });

  it("never calls the kernel on the after path", async () => {
    const kernel = kernelReturning({ kind: "verdict", verdict: "ALLOW", raw: {} });
    const hooks = makeHooks(kernel, new MemoryEvidenceSink());
    await hooks["tool.execute.after"]?.(
      { ...TOOL_INPUT, args: {} },
      { title: "t", output: "o", metadata: {} },
    );
    assert.equal(kernel.calls, 0);
  });
});
