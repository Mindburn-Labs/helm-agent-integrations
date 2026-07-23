import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  BOUNDARY_OPEN_RECORD,
  JsonlEvidenceSink,
  MemoryEvidenceSink,
  canonicalize,
  hashBoundaryValue,
  sha256Hex,
  type BoundaryOpenRecord,
} from "./evidence.js";

describe("canonicalize", () => {
  it("sorts object keys recursively for deterministic hashing", () => {
    const a = canonicalize({ b: 1, a: { d: 2, c: 3 }, z: [1, { y: 2, x: 3 }] });
    const b = canonicalize({ z: [1, { x: 3, y: 2 }], a: { c: 3, d: 2 }, b: 1 });
    assert.equal(a, b);
    assert.equal(a, '{"a":{"c":3,"d":2},"b":1,"z":[1,{"x":3,"y":2}]}');
  });

  it("produces stable sha256 hashes", () => {
    assert.equal(
      hashBoundaryValue({ command: "ls -la" }),
      hashBoundaryValue({ command: "ls -la" }),
    );
    assert.notEqual(
      hashBoundaryValue({ command: "ls -la" }),
      hashBoundaryValue({ command: "rm -rf /" }),
    );
    assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("JsonlEvidenceSink", () => {
  it("appends one JSON record per line into a daily file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helm-evidence-test-"));
    try {
      const sink = new JsonlEvidenceSink(dir, () => new Date("2026-07-24T12:00:00Z"));
      const record: BoundaryOpenRecord = {
        record_type: BOUNDARY_OPEN_RECORD,
        plugin: "@helm-ai/opencode-governance",
        plugin_version: "0.1.0",
        session_id: "ses_1",
        call_id: "call_1",
        tool: "bash",
        tenant_id: "tenant",
        principal: "agent",
        observed_at: "2026-07-24T12:00:00.000Z",
        args_hash: "abc",
        verdict: "ALLOW",
      };
      await sink.append(record);
      await sink.append(record);
      const content = await readFile(join(dir, "opencode-governance-2026-07-24.jsonl"), "utf8");
      const lines = content.trim().split("\n");
      assert.equal(lines.length, 2);
      assert.deepEqual(JSON.parse(lines[0]), record);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("wraps filesystem failures in EvidenceSinkError", async () => {
    const sink = new JsonlEvidenceSink("/dev/null/impossible");
    await assert.rejects(
      () =>
        sink.append({
          record_type: BOUNDARY_OPEN_RECORD,
          plugin: "p",
          plugin_version: "v",
          session_id: "s",
          tool: "t",
          tenant_id: "t",
          principal: "p",
          observed_at: "now",
          args_hash: "h",
          verdict: "ALLOW",
        }),
      /failed to append boundary evidence/,
    );
  });
});

describe("MemoryEvidenceSink", () => {
  it("records until a failure is injected", async () => {
    const sink = new MemoryEvidenceSink();
    sink.failure = new Error("disk full");
    await assert.rejects(() =>
      sink.append({
        record_type: BOUNDARY_OPEN_RECORD,
        plugin: "p",
        plugin_version: "v",
        session_id: "s",
        tool: "t",
        tenant_id: "t",
        principal: "p",
        observed_at: "now",
        args_hash: "h",
        verdict: "ALLOW",
      })
    );
  });
});
