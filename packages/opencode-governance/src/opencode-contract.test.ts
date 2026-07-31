/**
 * OpenCode public-contract test (P2 OPENCODE_CONTRACT_UNVERIFIED).
 *
 * The package typechecks against the pinned @opencode-ai/plugin public API,
 * then exercises the built module's server factory and hook callbacks. The
 * OpenCode dispatcher is not public API and is not reimplemented here; real
 * process coverage needs an installed OpenCode runtime.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import * as mod from "./index.js";
import type { OpencodePluginInput, OpencodePluginModule } from "./opencode-types.js";
import { HelmGovernanceDeny } from "./plugin.js";

const moduleContract: OpencodePluginModule = mod.default;

const FAKE_INPUT: OpencodePluginInput = {
  client: {} as OpencodePluginInput["client"],
  project: { id: "prj_test", worktree: "/tmp", time: { created: 0 } },
  directory: "/tmp",
  worktree: "/tmp",
  experimental_workspace: { register() {} },
  serverUrl: new URL("http://localhost:4096"),
  $: {} as OpencodePluginInput["$"],
};

const ENV_KEYS = [
  "HELM_KERNEL_URL",
  "HELM_API_KEY",
  "HELM_TENANT_ID",
  "HELM_PRINCIPAL",
  "HELM_EVIDENCE_DIR",
] as const;

describe("opencode public plugin contract", () => {
  let evidenceDir: string;
  let savedEnv: Record<string, string | undefined>;
  let savedFetch: typeof globalThis.fetch;
  let nextVerdict: string;

  before(async () => {
    evidenceDir = await mkdtemp(join(tmpdir(), "helm-opencode-contract-"));
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.HELM_KERNEL_URL = "http://127.0.0.1:7714";
    process.env.HELM_API_KEY = "contract-test-key";
    process.env.HELM_TENANT_ID = "tenant-contract";
    process.env.HELM_PRINCIPAL = "agent-contract";
    process.env.HELM_EVIDENCE_DIR = evidenceDir;
    nextVerdict = "DENY";
    savedFetch = globalThis.fetch;
    // Mock the kernel at the fetch layer: the plugin's HTTP client posts to
    // the loopback URL and receives the verdict this test installs.
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ verdict: nextVerdict, decision_id: "contract-d1" }),
      text: async () => "",
    })) as unknown as typeof globalThis.fetch;
  });

  after(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    globalThis.fetch = savedFetch;
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it("exports the pinned @opencode-ai/plugin module contract", () => {
    const plugin = moduleContract;
    assert.equal(plugin.id, "@helm-ai/opencode-governance");
    assert.equal(typeof plugin.server, "function");
  });

  it("instantiates via server(input, options) and a DENY rejects the before hook", async () => {
    const plugin = moduleContract;
    const hooks = await plugin.server(FAKE_INPUT, {});
    assert.equal(typeof hooks["tool.execute.before"], "function");
    assert.equal(typeof hooks["tool.execute.after"], "function");
    assert.equal(typeof hooks["permission.ask"], "function");
    const before = hooks["tool.execute.before"];
    const after = hooks["tool.execute.after"];
    assert.ok(before !== undefined);
    assert.ok(after !== undefined);

    nextVerdict = "DENY";
    await assert.rejects(
      before({ tool: "bash", sessionID: "ses_c", callID: "call_c1" }, {
        args: { command: "rm -rf /" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof HelmGovernanceDeny);
        assert.equal(error.verdict, "DENY");
        return true;
      },
    );

    nextVerdict = "ALLOW";
    await before({ tool: "bash", sessionID: "ses_c", callID: "call_c2" }, {
      args: { command: "ls" },
    });
    await after(
      { tool: "bash", sessionID: "ses_c", callID: "call_c2", args: { command: "ls" } },
      { title: "ls", output: "ok", metadata: {} },
    );
  });

  it("mints boundary evidence records through the public hook contract", async () => {
    const plugin = moduleContract;
    const hooks = await plugin.server(FAKE_INPUT, {});
    nextVerdict = "ALLOW";
    const before = hooks["tool.execute.before"];
    assert.ok(before !== undefined);
    await before({ tool: "edit", sessionID: "ses_c", callID: "call_c3" }, {
      args: { filePath: "a.ts" },
    });
    const files = await import("node:fs/promises").then((fs) => fs.readdir(evidenceDir));
    const jsonl = files.find((name) => name.endsWith(".jsonl"));
    assert.ok(jsonl !== undefined, "evidence JSONL file must exist");
    const lines = (await readFile(join(evidenceDir, jsonl), "utf8")).trim().split("\n");
    const types = lines.map((line) => (JSON.parse(line) as { record_type: string }).record_type);
    assert.ok(types.includes("opencode.boundary.open.v1"));
    const openRecord = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.record_type === "opencode.boundary.open.v1" && record.tool === "edit");
    assert.ok(openRecord !== undefined);
    assert.equal(openRecord.verdict, "ALLOW");
    assert.equal(openRecord.decision_id, "contract-d1");
  });
});
