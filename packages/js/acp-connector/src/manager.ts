/** Reviewed ACP sessions with cancellable policy evaluation and owned-process teardown. */
import type { AdapterLaunchSpec } from "./client.js";
import { GovernedAcpClient } from "./client.js";
import { GovernedPermissionBroker } from "./permission.js";
import type { FsGuard } from "./fs-guard.js";
import { SessionStore } from "./session-store.js";
import type { KernelEvaluator } from "./kernel-evaluator.js";
import { toolInputSha256 } from "./kernel-evaluator.js";
import { abortable, throwIfAborted } from "./process-tree.js";
import { checkedMcpServers } from "./session-safety.js";
import type { AcpMcpServer, AcpRunEvent, ApprovalPolicy, CodingAgent, ProcessTermination, RunPromptResult } from "./types.js";

export interface RunPromptArgs {
  runId: string;
  agent: CodingAgent;
  cwd: string;
  prompt: string;
  policy: ApprovalPolicy;
  onEvent: (event: AcpRunEvent) => void;
  signal?: AbortSignal;
  model?: string;
  effort?: string;
  mcpServers?: AcpMcpServer[];
  /** Persist the real, safety-verified session before permitting a prompt. */
  onSessionReady?: (sessionId: string) => Promise<void>;
  /** Use a new session instead of loading persisted vendor state. */
  freshSession?: boolean;
}

export interface AcpSessionManagerOptions {
  sessionStore: SessionStore;
  fsGuard: FsGuard;
  evaluator: KernelEvaluator;
  launchSpecFor: (agent: CodingAgent, cwd: string) => AdapterLaunchSpec;
  mcpServers?: AcpMcpServer[];
  disposeGraceMs?: number;
  cancelGraceMs?: number;
}

type ActiveRun = {
  client: GovernedAcpClient;
  sessionId: string;
  agent: CodingAgent;
  cwd: string;
  mcpDigest: string;
  disposeTimer?: ReturnType<typeof setTimeout>;
};
type ActivePrompt = { controller: AbortController; done: Promise<RunPromptResult> };
const emptyTermination = (): ProcessTermination => ({ adapterExited: true, descendantsExited: true, forced: false });

export class AcpSessionManager {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly activePrompts = new Map<string, ActivePrompt>();
  private readonly terminations = new Map<string, ProcessTermination>();

  constructor(private readonly opts: AcpSessionManagerOptions) {}

  async runPrompt(args: RunPromptArgs): Promise<RunPromptResult> {
    if (this.activePrompts.has(args.runId)) throw new Error(`HELM ACP: concurrent runPrompt for runId ${JSON.stringify(args.runId)} rejected — one active prompt per run (fail-closed)`);
    if (args.signal?.aborted) return { stopReason: "cancelled", sessionId: "", cancelled: true, termination: emptyTermination() };
    const controller = new AbortController();
    const abort = () => controller.abort();
    args.signal?.addEventListener("abort", abort, { once: true });
    const done = this.runPromptInner(args, controller.signal);
    this.activePrompts.set(args.runId, { controller, done });
    try { return await done; }
    finally {
      args.signal?.removeEventListener("abort", abort);
      this.activePrompts.delete(args.runId);
    }
  }

  private async runPromptInner(args: RunPromptArgs, signal: AbortSignal): Promise<RunPromptResult> {
    const { runId, agent, cwd, policy, onEvent } = args;
    let run: ActiveRun | undefined;
    try {
      throwIfAborted(signal);
      const servers = checkedMcpServers(args.mcpServers ?? this.opts.mcpServers ?? []);
      const broker = new GovernedPermissionBroker({
        evaluator: this.opts.evaluator, policy, agent, cwd,
        onResolved: (ask, decision, auto, receiptId) => onEvent({ type: "permission", ask, decision, auto, receiptId }),
      });
      run = await this.ensureRun(args, broker, servers, signal);
      throwIfAborted(signal);
      if (args.model && args.model !== "default") await run.client.setSessionConfigOption(run.sessionId, run.client.configId("model"), args.model);
      if (args.effort && args.effort !== "default") await run.client.setSessionConfigOption(run.sessionId, run.client.configId("effort"), args.effort);
      if (args.onSessionReady) await abortable(args.onSessionReady(run.sessionId), signal);
      throwIfAborted(signal);
      const response = await run.client.prompt(run.sessionId, args.prompt, signal);
      throwIfAborted(signal);
      return { stopReason: response.stopReason, sessionId: run.sessionId };
    } catch (error) {
      if (signal.aborted) {
        run ??= this.runs.get(runId);
        if (run?.sessionId) {
          await run.client.cancel(run.sessionId).catch(() => {});
          await run.client.waitForPromptEnd(this.opts.cancelGraceMs ?? 2000);
        }
        const termination = await this.dispose(runId);
        this.assertTerminated(termination);
        return { stopReason: "cancelled", sessionId: run?.sessionId ?? "", cancelled: true, termination };
      }
      await this.dispose(runId);
      throw error;
    } finally {
      if (!signal.aborted) {
        if ((this.opts.disposeGraceMs ?? 60_000) <= 0) this.assertTerminated(await this.dispose(runId));
        else this.scheduleDispose(runId);
      }
    }
  }

  async stop(runId: string): Promise<ProcessTermination> {
    const active = this.activePrompts.get(runId);
    if (active) {
      active.controller.abort();
      const result = await active.done;
      const termination = result.termination ?? await this.dispose(runId);
      this.assertTerminated(termination);
      return termination;
    }
    const termination = await this.dispose(runId);
    this.assertTerminated(termination);
    return termination;
  }

  async dispose(runId: string): Promise<ProcessTermination> {
    const run = this.runs.get(runId);
    if (!run) return this.terminations.get(runId) ?? emptyTermination();
    if (run.disposeTimer) clearTimeout(run.disposeTimer);
    const result = await run.client.dispose();
    if (this.runs.get(runId) === run) this.runs.delete(runId);
    this.terminations.set(runId, result);
    return result;
  }

  async disposeAll(): Promise<ProcessTermination[]> {
    for (const prompt of this.activePrompts.values()) prompt.controller.abort();
    const stopped = await Promise.allSettled([...this.activePrompts.values()].map(prompt => prompt.done));
    const disposed = await Promise.all([...this.runs.keys()].map(runId => this.dispose(runId)));
    for (const result of disposed) this.assertTerminated(result);
    const failures = stopped.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "HELM ACP: one or more active runs failed during disposal");
    return [...stopped.flatMap(result => result.status === "fulfilled" && result.value.termination ? [result.value.termination] : []), ...disposed];
  }

  private assertTerminated(result: ProcessTermination): void {
    if (!result.adapterExited || !result.descendantsExited) throw new Error(`HELM ACP: process termination unconfirmed: ${JSON.stringify(result)}`);
  }

  private scheduleDispose(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.disposeTimer) clearTimeout(run.disposeTimer);
    const grace = this.opts.disposeGraceMs ?? 60_000;
    run.disposeTimer = setTimeout(() => { if (!this.activePrompts.has(runId)) void this.dispose(runId).catch(() => {}); }, Math.max(0, grace));
    run.disposeTimer.unref();
  }

  private async ensureRun(args: RunPromptArgs, broker: GovernedPermissionBroker, servers: AcpMcpServer[], signal: AbortSignal): Promise<ActiveRun> {
    const { runId, agent, cwd, onEvent } = args;
    const mcpDigest = toolInputSha256(servers);
    const existing = this.runs.get(runId);
    if (existing && existing.agent === agent && existing.cwd === cwd && existing.mcpDigest === mcpDigest && !args.freshSession) {
      if (existing.disposeTimer) clearTimeout(existing.disposeTimer);
      existing.client.setHandlers(broker, onEvent, signal);
      await existing.client.verifySession();
      return existing;
    }
    if (existing) this.assertTerminated(await this.dispose(runId));
    throwIfAborted(signal);
    const client = new GovernedAcpClient({ agent, cwd, launchSpec: this.opts.launchSpecFor(agent, cwd), broker, fsGuard: this.opts.fsGuard, onEvent, mcpServers: servers });
    const run: ActiveRun = { client, sessionId: "", agent, cwd, mcpDigest };
    this.runs.set(runId, run);
    this.terminations.delete(runId);
    await client.start(signal);
    throwIfAborted(signal);
    const stored = args.freshSession ? null : await this.opts.sessionStore.read(runId);
    if (stored && stored.agent === agent && stored.cwd === cwd && stored.mcpDigest === mcpDigest && client.loadSupported) {
      try { await client.loadSession(stored.sessionId); run.sessionId = stored.sessionId; }
      catch (error) {
        throwIfAborted(signal);
        // Only a stale vendor session can fall back; safety errors are fatal.
        if (/mode|capabilit|configuration|fail-closed/.test(String(error))) throw error;
        await this.opts.sessionStore.clear(runId);
      }
    }
    if (!run.sessionId) run.sessionId = await client.newSession();
    throwIfAborted(signal);
    await this.opts.sessionStore.write({ runId, agent, cwd, sessionId: run.sessionId, mcpDigest });
    return run;
  }
}
