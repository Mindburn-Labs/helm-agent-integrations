import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  BOUNDARY_OPEN_RECORD,
  EvidenceSerializationError,
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

  it("fails closed on unserializable boundary material (P2 CANONICALIZE_BUILD_FAILURE)", () => {
    // JSON.stringify returns undefined (not a string) for these; that must be
    // a typed error, never a cast into a garbage hash input.
    assert.throws(() => canonicalize(undefined), EvidenceSerializationError);
    assert.throws(() => canonicalize(() => {}), EvidenceSerializationError);
    assert.throws(() => canonicalize(Symbol("x")), EvidenceSerializationError);
    assert.throws(() => hashBoundaryValue(undefined), EvidenceSerializationError);
    assert.equal(canonicalize(null), "null");
  });

  it("fails closed on lossy material (P1 LOSSY_ARGUMENT_AUTHORIZATION)", () => {
    // These would silently change meaning through JSON.stringify; they must
    // be rejected so the evaluated copy can never diverge from the original.
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const lossy: unknown[] = [
      { a: undefined, b: 1 }, // undefined property would be dropped
      [undefined], // would become [null]
      [NaN],
      [Infinity],
      Number.NaN,
      Number.POSITIVE_INFINITY,
      10n,
      new Date("2026-07-24"),
      new Map([["a", 1]]),
      new Set([1]),
      /regex/,
      cyclic,
    ];
    for (const [index, value] of lossy.entries()) {
      assert.throws(() => canonicalize(value), EvidenceSerializationError, `lossy case ${index}`);
    }
    // Exact JSON-finite trees round-trip losslessly.
    const fine = { b: [1, "two", null, true, 1.5, { c: [] }], a: {} };
    assert.deepEqual(JSON.parse(canonicalize(fine)), fine);
  });

  it("fails closed on hidden or identity-bearing argument shapes", () => {
    const nonEnumerable = { command: "ls" };
    Object.defineProperty(nonEnumerable, "hidden", { value: true, enumerable: false });
    let accessorRead = false;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "command", {
      enumerable: true,
      get() {
        accessorRead = true;
        return "ls";
      },
    });
    const sparse = new Array(1);
    const namedArray = ["ls"];
    namedArray[4_294_967_295] = "hidden";
    const alteredArray: unknown[] = [];
    Object.setPrototypeOf(alteredArray, null);
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.command = "ls";
    const shared = { command: "ls" };

    for (const value of [
      { command: "ls", [Symbol("hidden")]: true },
      nonEnumerable,
      accessor,
      sparse,
      namedArray,
      alteredArray,
      nullPrototype,
      { first: shared, second: shared },
      -0,
    ]) {
      assert.throws(() => canonicalize(value), EvidenceSerializationError);
    }
    assert.equal(accessorRead, false, "validation must not invoke an accessor");
  });

  it("preserves an own __proto__ data key", () => {
    const value = JSON.parse('{"__proto__":{"safe":true}}');
    assert.equal(canonicalize(value), '{"__proto__":{"safe":true}}');
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
