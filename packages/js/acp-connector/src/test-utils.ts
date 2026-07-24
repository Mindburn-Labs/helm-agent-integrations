/** Shared helpers for acp-connector tests (not exported from the package). */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterLaunchSpec } from "./client.js";
import type { KernelEvaluator, KernelVerdict } from "./kernel-evaluator.js";
import { FsGuard } from "./fs-guard.js";

export const FAKE_AGENT_FIXTURE = fileURLToPath(new URL("../fixtures/fake-acp-agent.mjs", import.meta.url));

export function fakeLaunchSpec(behavior: Record<string, unknown>): AdapterLaunchSpec {
  return {
    command: process.execPath,
    args: [FAKE_AGENT_FIXTURE],
    env: { ...process.env, FAKE_AGENT_BEHAVIOR: JSON.stringify(behavior) },
  };
}

export async function makeTmpDir(prefix = "helm-acp-test-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function cleanupTmpDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Kernel evaluator stub with programmable verdicts and call counting. */
export class FakeKernelEvaluator implements KernelEvaluator {
  calls: Array<{ tier: string; kind?: string }> = [];
  verdicts: KernelVerdict[] = [];
  defaultVerdict: KernelVerdict = { verdict: "ALLOW", receiptId: "rcpt-fake", decisionId: "dec-fake" };
  throwError: Error | null = null;

  async evaluate(request: { tier: "low" | "standard"; ask: { kind?: string } }): Promise<KernelVerdict> {
    this.calls.push({ tier: request.tier, kind: request.ask.kind });
    if (this.throwError) throw this.throwError;
    return this.verdicts.length > 0 ? this.verdicts.shift()! : this.defaultVerdict;
  }
}

/** FsGuard rooted at a single read+write tmp dir. */
export function guardFor(root: string, extra: Array<{ path: string; read: boolean; write: boolean }> = []): FsGuard {
  return new FsGuard({ roots: [{ path: root, read: true, write: true }, ...extra] });
}
