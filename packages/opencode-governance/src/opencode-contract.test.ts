/**
 * opencode loader/dispatch contract test (P2 OPENCODE_CONTRACT_UNVERIFIED).
 *
 * The unit tests invoke hook callbacks directly; this suite instead loads the
 * built plugin the way opencode's plugin loader does and dispatches hooks
 * through a faithful replication of opencode's Plugin.trigger semantics:
 *
 * - Loader shape (packages/opencode/src/plugin/shared.ts readV1Plugin +
 *   plugin/index.ts applyPlugin, clone @ 62e46412): the module must
 *   default-export an object exposing `server()`; detect mode requires an
 *   `id`/`server`/`tui` key. opencode prefers this path and does NOT fall
 *   back to legacy named-export scanning when it matches (legacy scanning
 *   would reject this module, since it also exports non-function values).
 * - Instantiation: `server(pluginInput, options)` -> hooks bag.
 * - Dispatch (plugin/index.ts Plugin.trigger): hooks run sequentially via
 *   Effect.promise-style await; a rejection from `tool.execute.before`
 *   propagates to the caller, which is exactly how a thrown
 *   HelmGovernanceDeny blocks the tool call in session/tools.ts.
 *
 * The kernel is mocked at the fetch layer (loopback URL per the transport
 * rules); no network and no opencode runtime are required. What this proves:
 * the plugin loads via the real entry contract and a DENY blocks execution
 * through the real dispatch semantics. What it does NOT prove: behavior
 * inside an actual opencode process (version drift, other plugins, config
 * UI) — see README "Verification status".
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import * as mod from "./index.js";
import type { OpencodeHooks, OpencodePluginInput } from "./opencode-types.js";
import { HelmGovernanceDeny } from "./plugin.js";

type PluginModule = { id?: string; server: (input: unknown, options?: unknown) => Promise<OpencodeHooks> };

/** Faithful replication of readV1Plugin(mod, "server", "detect"). */
function readV1Plugin(module_: Record<string, unknown>): PluginModule | undefined {
  const value = module_.default;
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (!("id" in candidate) && !("server" in candidate) && !("tui" in candidate)) {
    return undefined;
  }
  if (typeof candidate.server !== "function") {
    throw new TypeError("plugin default export has invalid server export");
  }
  return candidate as unknown as PluginModule;
}

/** Faithful replication of Plugin.trigger: sequential, errors propagate. */
async function trigger<Name extends keyof OpencodeHooks>(
  hooksList: OpencodeHooks[],
  name: Name,
  ...args: Parameters<NonNullable<OpencodeHooks[Name]>>
): Promise<void> {
  for (const hooks of hooksList) {
    const fn = hooks[name] as ((...callArgs: unknown[]) => Promise<void>) | undefined;
    if (fn === undefined) {
      continue;
    }
    await fn(...args);
  }
}

/** Faithful replication of getLegacyPlugins over named exports. */
function getLegacyPlugins(module_: Record<string, unknown>): unknown[] {
  const seen = new Set<unknown>();
  const result: unknown[] = [];
  for (const entry of Object.values(module_)) {
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    const isFunction = typeof entry === "function";
    const hasServer = typeof entry === "object" && entry !== null
      && typeof (entry as Record<string, unknown>).server === "function";
    if (!isFunction && !hasServer) {
      throw new TypeError("Plugin export is not a function");
    }
    result.push(entry);
  }
  return result;
}

const FAKE_INPUT: OpencodePluginInput = {
  client: {},
  project: { id: "prj_test" },
  directory: "/tmp",
  worktree: "/tmp",
  serverUrl: new URL("http://localhost:4096"),
  $: {},
};

const ENV_KEYS = [
  "HELM_KERNEL_URL",
  "HELM_API_KEY",
  "HELM_TENANT_ID",
  "HELM_PRINCIPAL",
  "HELM_EVIDENCE_DIR",
] as const;

describe("opencode loader contract", () => {
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

  it("loads via the readV1Plugin default-export contract (not legacy scanning)", async () => {
    const plugin = readV1Plugin(mod as unknown as Record<string, unknown>);
    assert.ok(plugin !== undefined, "default export must satisfy readV1Plugin detect mode");
    assert.equal(plugin.id, "@helm-ai/opencode-governance");
    assert.equal(typeof plugin.server, "function");
    // Document why the default-export path matters: legacy named-export
    // scanning (opencode's fallback) rejects this module because it also
    // exports non-function values; opencode prefers readV1Plugin and never
    // reaches legacy scanning when it matches.
    assert.throws(() => getLegacyPlugins(mod as unknown as Record<string, unknown>), TypeError);
  });

  it("instantiates via server(input, options) and a DENY blocks through Plugin.trigger dispatch", async () => {
    const plugin = readV1Plugin(mod as unknown as Record<string, unknown>);
    assert.ok(plugin !== undefined);
    const hooks = await plugin.server(FAKE_INPUT, {});
    assert.equal(typeof hooks["tool.execute.before"], "function");
    assert.equal(typeof hooks["tool.execute.after"], "function");
    assert.equal(typeof hooks["permission.ask"], "function");

    nextVerdict = "DENY";
    // A rejection here is what opencode's session/tools.ts observes as a
    // failed tool Effect: the tool call never executes.
    await assert.rejects(
      trigger([hooks], "tool.execute.before", { tool: "bash", sessionID: "ses_c", callID: "call_c1" }, {
        args: { command: "rm -rf /" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof HelmGovernanceDeny);
        assert.equal(error.verdict, "DENY");
        return true;
      },
    );

    nextVerdict = "ALLOW";
    // ALLOW passes the before hook; the after hook tap must not throw.
    await trigger([hooks], "tool.execute.before", { tool: "bash", sessionID: "ses_c", callID: "call_c2" }, {
      args: { command: "ls" },
    });
    await trigger(
      [hooks],
      "tool.execute.after",
      { tool: "bash", sessionID: "ses_c", callID: "call_c2", args: { command: "ls" } },
      { title: "ls", output: "ok", metadata: {} },
    );
  });

  it("mints boundary evidence records through the full dispatch path", async () => {
    const plugin = readV1Plugin(mod as unknown as Record<string, unknown>);
    assert.ok(plugin !== undefined);
    const hooks = await plugin.server(FAKE_INPUT, {});
    nextVerdict = "ALLOW";
    await trigger([hooks], "tool.execute.before", { tool: "edit", sessionID: "ses_c", callID: "call_c3" }, {
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
