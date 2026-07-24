import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BinaryKernelClient,
  HttpKernelClient,
  defaultSpawn,
  outcomeFromResponseBody,
  withoutAuthorityMetadata,
  type FetchLike,
  type SpawnLike,
} from "./kernel.js";

const REQUEST = {
  tool: "bash",
  sessionID: "ses_1",
  callID: "call_1",
  args: { command: "ls" },
} as const;

const HTTP_OPTIONS = {
  kernelUrl: "http://127.0.0.1:7714",
  apiKey: "key",
  tenantId: "tenant",
  principal: "agent",
  riskClass: "T2",
  effectClass: "E4",
  timeoutMs: 1000,
};

function fetchReturning(status: number, body: unknown): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

const fetchThrowing: FetchLike = async () => {
  throw new Error("connection refused");
};

describe("outcomeFromResponseBody", () => {
  it("passes through exact verdicts with metadata", () => {
    const outcome = outcomeFromResponseBody({
      decision: { verdict: "ALLOW", decision_id: "d1", reason_code: "R1", receipt_id: "r1" },
    });
    assert.deepEqual(outcome, {
      kind: "verdict",
      verdict: "ALLOW",
      decisionId: "d1",
      reasonCode: "R1",
      receiptId: "r1",
      raw: { decision: { verdict: "ALLOW", decision_id: "d1", reason_code: "R1", receipt_id: "r1" } },
    });
  });

  it("fails closed on unknown verdict material", () => {
    const outcome = outcomeFromResponseBody({ verdict: "ALLOW_WITH_CONDITIONS" });
    assert.equal(outcome.kind, "error");
    assert.equal((outcome as { reasonCode: string }).reasonCode, "KERNEL_UNKNOWN_VERDICT");
  });

  it("fails closed on non-object bodies", () => {
    for (const body of [null, undefined, "ALLOW", 42, ["ALLOW"]]) {
      const outcome = outcomeFromResponseBody(body);
      assert.equal(outcome.kind, "error", JSON.stringify(body));
      assert.equal((outcome as { reasonCode: string }).reasonCode, "KERNEL_MALFORMED_RESPONSE");
    }
  });

  it("rejects near-miss payloads that must never authorize (P1 PERMISSIVE_VERDICT_PARSER)", () => {
    const malformed: unknown[] = [
      { status: "allow" }, // wrong field
      { status: "ALLOW" },
      { record: { verdict: "ALLOW" } }, // dropped fallbacks
      { result: { verdict: "ALLOW" } },
      { decision: { status: "allow" } }, // wrong nested field
      { decision: "ALLOW" }, // decision not a plain object
      {}, // no verdict field at all
      { decision: {} },
    ];
    for (const body of malformed) {
      const outcome = outcomeFromResponseBody(body);
      assert.equal(outcome.kind, "error", JSON.stringify(body));
      assert.equal(
        (outcome as { reasonCode: string }).reasonCode,
        "KERNEL_MALFORMED_RESPONSE",
        JSON.stringify(body),
      );
    }
    const unknownVerdict: unknown[] = [
      { verdict: "allow" }, // case near-miss
      { verdict: "ALLOW " }, // whitespace near-miss
      { verdict: " ALLOW" },
      { verdict: "ALLOW_WITH_CONDITIONS" },
      { verdict: "PERMIT" },
      { verdict: 1 }, // right field, wrong type
      { decision: { verdict: "allow" } },
      { decision: { verdict: null } },
    ];
    for (const body of unknownVerdict) {
      const outcome = outcomeFromResponseBody(body);
      assert.equal(outcome.kind, "error", JSON.stringify(body));
      assert.equal(
        (outcome as { reasonCode: string }).reasonCode,
        "KERNEL_UNKNOWN_VERDICT",
        JSON.stringify(body),
      );
    }
    // And the exact contract values still pass, top-level and nested.
    for (const verdict of ["ALLOW", "DENY", "ESCALATE"] as const) {
      assert.equal(
        (outcomeFromResponseBody({ verdict }) as { verdict: string }).verdict,
        verdict,
      );
      assert.equal(
        (outcomeFromResponseBody({ decision: { verdict } }) as { verdict: string }).verdict,
        verdict,
      );
    }
  });

  it("rejects conflicting verdict material between contract fields (P1 CONFLICTING_VERDICT_ACCEPTED)", () => {
    const conflicts: unknown[] = [
      { verdict: "ALLOW", decision: { verdict: "DENY" } },
      { verdict: "DENY", decision: { verdict: "ALLOW" } },
      { verdict: "ALLOW", decision: { verdict: "ESCALATE" } },
      { verdict: "ALLOW", decision: { verdict: 42 } },
      { verdict: 42, decision: { verdict: "ALLOW" } },
    ];
    for (const body of conflicts) {
      const outcome = outcomeFromResponseBody(body);
      assert.equal(outcome.kind, "error", JSON.stringify(body));
      assert.equal(
        (outcome as { reasonCode: string }).reasonCode,
        "KERNEL_MALFORMED_RESPONSE",
        JSON.stringify(body),
      );
    }
    // Consistent duplicates are fine, and a decision object without a
    // verdict key does not conflict with the top-level contract field.
    assert.equal(
      (outcomeFromResponseBody({ verdict: "ALLOW", decision: { verdict: "ALLOW" } }) as {
        verdict: string;
      }).verdict,
      "ALLOW",
    );
    assert.equal(
      (outcomeFromResponseBody({ verdict: "ALLOW", decision: { decision_id: "d1" } }) as {
        verdict: string;
      }).verdict,
      "ALLOW",
    );
  });
});

describe("HttpKernelClient", () => {
  it("refuses plaintext non-loopback transports at construction (P1 INSECURE_KERNEL_TRANSPORT)", () => {
    assert.throws(
      () => new HttpKernelClient({ ...HTTP_OPTIONS, kernelUrl: "http://kernel.internal" }),
      /plaintext http/,
    );
    // Loopback and https remain constructible.
    assert.ok(new HttpKernelClient({ ...HTTP_OPTIONS, kernelUrl: "http://127.0.0.1:7714" }));
    assert.ok(new HttpKernelClient({ ...HTTP_OPTIONS, kernelUrl: "https://kernel.example.com" }));
  });

  it("returns the kernel verdict on a well-formed 200", async () => {
    const client = new HttpKernelClient({
      ...HTTP_OPTIONS,
      fetch: fetchReturning(200, { verdict: "ESCALATE", decision_id: "d9" }),
    });
    const outcome = await client.evaluate({ ...REQUEST });
    assert.equal(outcome.kind, "verdict");
    assert.equal((outcome as { verdict: string }).verdict, "ESCALATE");
  });

  it("fails closed on transport failure", async () => {
    const client = new HttpKernelClient({ ...HTTP_OPTIONS, fetch: fetchThrowing });
    const outcome = await client.evaluate({ ...REQUEST });
    assert.equal(outcome.kind, "error");
    assert.equal((outcome as { reasonCode: string }).reasonCode, "KERNEL_UNAVAILABLE");
  });

  it("fails closed on non-2xx responses", async () => {
    const client = new HttpKernelClient({
      ...HTTP_OPTIONS,
      fetch: fetchReturning(500, { verdict: "ALLOW" }),
    });
    const outcome = await client.evaluate({ ...REQUEST });
    assert.equal(outcome.kind, "error");
  });

  it("fails closed on a 200 with unknown verdict material", async () => {
    const client = new HttpKernelClient({
      ...HTTP_OPTIONS,
      fetch: fetchReturning(200, { verdict: "MAYBE" }),
    });
    const outcome = await client.evaluate({ ...REQUEST });
    assert.equal(outcome.kind, "error");
    assert.equal((outcome as { reasonCode: string }).reasonCode, "KERNEL_UNKNOWN_VERDICT");
  });

  it("sends the expected evaluate payload and auth headers", async () => {
    let seenUrl = "";
    let seenInit: { headers?: Record<string, string>; body?: string } = {};
    const fetchSpy: FetchLike = async (url, init) => {
      seenUrl = url;
      seenInit = init ?? {};
      return {
        ok: true,
        status: 200,
        json: async () => ({ verdict: "ALLOW" }),
        text: async () => "",
      };
    };
    const client = new HttpKernelClient({ ...HTTP_OPTIONS, fetch: fetchSpy });
    await client.evaluate({ ...REQUEST, metadata: { principal: "spoof", safe: "kept" } });
    assert.equal(seenUrl, "http://127.0.0.1:7714/api/v1/evaluate");
    assert.equal(seenInit.headers?.Authorization, "Bearer key");
    assert.equal(seenInit.headers?.["X-Helm-Tenant-ID"], "tenant");
    const payload = JSON.parse(seenInit.body ?? "{}");
    assert.equal(payload.principal, "agent");
    assert.equal(payload.resource, "tool.opencode.bash");
    assert.equal(payload.context.session_id, "ses_1");
    assert.equal(payload.context.metadata.principal, undefined);
    assert.equal(payload.context.metadata.safe, "kept");
    assert.equal(payload.context.metadata.framework, "opencode");
  });
});

describe("BinaryKernelClient", () => {
  const BINARY_OPTIONS = {
    kernelBinary: "/bin/fake-kernel",
    kernelBinaryArgs: ["hook", "decide"],
    tenantId: "tenant",
    principal: "agent",
    riskClass: "T2",
    effectClass: "E4",
    timeoutMs: 1000,
  };

  function spawnReturning(code: number, stdout: string): SpawnLike {
    return async () => ({ code, stdout, stderr: "" });
  }

  it("honors an exact ALLOW from exit 0 + JSON stdout", async () => {
    const client = new BinaryKernelClient({
      ...BINARY_OPTIONS,
      spawn: spawnReturning(0, JSON.stringify({ verdict: "ALLOW", decision_id: "d1" })),
    });
    const outcome = await client.evaluate({ ...REQUEST });
    assert.equal(outcome.kind, "verdict");
    assert.equal((outcome as { verdict: string }).verdict, "ALLOW");
  });

  it("refuses to honor ALLOW printed alongside a non-zero exit", async () => {
    const client = new BinaryKernelClient({
      ...BINARY_OPTIONS,
      spawn: spawnReturning(1, JSON.stringify({ verdict: "ALLOW" })),
    });
    const outcome = await client.evaluate({ ...REQUEST });
    assert.equal(outcome.kind, "error");
    assert.equal((outcome as { reasonCode: string }).reasonCode, "KERNEL_UNAVAILABLE");
  });

  it("honors DENY/ESCALATE printed alongside a non-zero exit (restrictive only)", async () => {
    const client = new BinaryKernelClient({
      ...BINARY_OPTIONS,
      spawn: spawnReturning(2, JSON.stringify({ verdict: "DENY", reason_code: "POLICY" })),
    });
    const outcome = await client.evaluate({ ...REQUEST });
    assert.equal(outcome.kind, "verdict");
    assert.equal((outcome as { verdict: string }).verdict, "DENY");
  });

  it("fails closed on empty stdout, invalid JSON, unknown verdicts, and spawn errors", async () => {
    const epipe = new Error("write EPIPE");
    (epipe as NodeJS.ErrnoException).code = "EPIPE";
    const cases: Array<{ spawn: SpawnLike; reason: string }> = [
      { spawn: spawnReturning(0, ""), reason: "KERNEL_MALFORMED_RESPONSE" },
      { spawn: spawnReturning(1, ""), reason: "KERNEL_UNAVAILABLE" },
      { spawn: spawnReturning(0, "not json"), reason: "KERNEL_MALFORMED_RESPONSE" },
      { spawn: spawnReturning(0, JSON.stringify({ verdict: "CHALLENGE" })), reason: "KERNEL_UNKNOWN_VERDICT" },
      {
        spawn: async () => {
          throw new Error("ENOENT");
        },
        reason: "KERNEL_UNAVAILABLE",
      },
      {
        spawn: async () => {
          throw epipe;
        },
        reason: "KERNEL_UNAVAILABLE",
      },
    ];
    for (const { spawn, reason } of cases) {
      const client = new BinaryKernelClient({ ...BINARY_OPTIONS, spawn });
      const outcome = await client.evaluate({ ...REQUEST });
      assert.equal(outcome.kind, "error", reason);
      assert.equal((outcome as { reasonCode: string }).reasonCode, reason);
    }
  });
});

describe("defaultSpawn (P3 SPAWN_STDIN_ERROR_UNHANDLED)", () => {
  // Deterministic stdin teardown: the binary destroys its stdin immediately
  // and only then exits 0, so writing a large payload always fails with
  // EPIPE — on every platform, not just where process-exit races win.
  const STDIN_DESTROY_SCRIPT = "process.stdin.destroy(); setTimeout(() => process.exit(0), 200)";

  it("resolves cleanly when the binary closes stdin before the payload is delivered", async () => {
    const result = await defaultSpawn(process.execPath, ["-e", STDIN_DESTROY_SCRIPT], {
      input: "x".repeat(1024 * 1024),
      timeoutMs: 10_000,
    });
    assert.equal(typeof result.code, "number");
    assert.notEqual(result.code, 0, "stdin delivery failure must not report exit 0");
    assert.match(result.stderr, /stdin delivery failed/);
  });

  it("yields KERNEL_UNAVAILABLE through BinaryKernelClient for a fast-failing binary", async () => {
    const client = new BinaryKernelClient({
      kernelBinary: process.execPath,
      kernelBinaryArgs: ["-e", STDIN_DESTROY_SCRIPT],
      tenantId: "tenant",
      principal: "agent",
      riskClass: "T2",
      effectClass: "E4",
      timeoutMs: 10_000,
      spawn: defaultSpawn,
    });
    const outcome = await client.evaluate({
      tool: "bash",
      sessionID: "ses_1",
      // Must exceed the OS pipe buffer (1 MiB on Linux) so the write can
      // never complete before the child destroys stdin.
      args: { command: "x".repeat(2 * 1024 * 1024) },
    });
    assert.equal(outcome.kind, "error");
    assert.equal((outcome as { reasonCode: string }).reasonCode, "KERNEL_UNAVAILABLE");
  });
});

describe("withoutAuthorityMetadata", () => {
  it("strips authority-claiming keys", () => {
    const sanitized = withoutAuthorityMetadata({
      principal: "evil",
      agent_id: "evil",
      tenant_id: "evil",
      risk_class: "T0",
      riskClass: "T0",
      effect_class: "E0",
      effectClass: "E0",
      harmless: true,
    });
    assert.deepEqual(sanitized, { harmless: true });
  });
});
