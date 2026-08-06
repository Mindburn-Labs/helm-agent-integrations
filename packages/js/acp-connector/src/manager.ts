/**
 * ACP session manager: warm-connection reuse, run termination, session resume.
 *
 * Lifecycle mechanisms adapted (with attribution, Apache-2.0) from Rowboat's
 * CodeModeManager (apps/x/packages/core/src/code-mode/acp/manager.ts):
 * cancel → grace → force-kill so a wedged adapter can never lock a turn
 * indefinitely, warm-connection reuse with an unref'd dispose grace window,
 * and resume-via-load with a stale-session fallback. Reimplemented here with
 * the governed client (kernel-gated permissions + allowlisted fs).
 */

import { GovernedAcpClient, type AdapterLaunchSpec } from "./client.js";
import { GovernedPermissionBroker } from "./permission.js";
import type { KernelEvaluator } from "./kernel-evaluator.js";
import type { FsGuard } from "./fs-guard.js";
import { SessionStore } from "./session-store.js";
import type {
  AcpRunEvent,
  ApprovalPolicy,
  CodingAgent,
  RunPromptResult,
} from "./types.js";

export interface RunPromptArgs {
  runId: string;
  agent: CodingAgent;
  cwd: string;
  prompt: string;
  policy: ApprovalPolicy;
  /** Stream sink for this prompt's run. */
  onEvent: (event: AcpRunEvent) => void;
  /** Aborts the turn on stop; the manager cancels then force-kills. */
  signal?: AbortSignal;
  /** Model alias/id applied best-effort before the prompt. */
  model?: string;
  /** Reasoning effort applied best-effort alongside the model. */
  effort?: string;
}

export interface AcpSessionManagerOptions {
  sessionStore: SessionStore;
  fsGuard: FsGuard;
  evaluator: KernelEvaluator;
  /** Launch-spec factory (engine resolution happens outside the manager). */
  launchSpecFor: (agent: CodingAgent, cwd: string) => AdapterLaunchSpec;
  /** Warm-connection grace window after the last turn ends (default 60 s). */
  disposeGraceMs?: number;
  /** Grace between session/cancel and force-kill on stop (default 2 s). */
  cancelGraceMs?: number;
}

interface ActiveRun {
  client: GovernedAcpClient;
  sessionId: string;
  agent: CodingAgent;
  cwd: string;
  inflight: number;
  disposeTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_DISPOSE_GRACE_MS = 60_000;
const DEFAULT_CANCEL_GRACE_MS = 2_000;

export class AcpSessionManager {
  private readonly opts: AcpSessionManagerOptions;
  private readonly runs = new Map<string, ActiveRun>();
  /** runIds with a prompt currently in flight. One prompt per run — a second
   *  concurrent runPrompt would swap the live client's broker/event handlers
   *  out from under the running turn, so it is rejected fail-closed. */
  private readonly activePrompts = new Set<string>();

  constructor(opts: AcpSessionManagerOptions) {
    this.opts = opts;
  }

  async runPrompt(args: RunPromptArgs): Promise<RunPromptResult> {
    if (this.activePrompts.has(args.runId)) {
      throw new Error(
        `HELM ACP: concurrent runPrompt for runId ${JSON.stringify(args.runId)} rejected — ` +
          "one active prompt per run (fail-closed)",
      );
    }
    this.activePrompts.add(args.runId);
    try {
      return await this.runPromptInner(args);
    } finally {
      this.activePrompts.delete(args.runId);
    }
  }

  private async runPromptInner(args: RunPromptArgs): Promise<RunPromptResult> {
    const { runId, agent, cwd, prompt, policy, onEvent, signal } = args;

    const broker = new GovernedPermissionBroker({
      evaluator: this.opts.evaluator,
      policy,
      agent,
      cwd,
      onResolved: (ask, decision, auto, receiptId) =>
        onEvent({ type: "permission", ask, decision, auto, receiptId }),
    });

    const run = await this.ensureRun(runId, agent, cwd, broker, onEvent);
    await this.applyModelAndEffort(run, args.model, args.effort);
    run.inflight++;

    const cancelGraceMs = this.opts.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const promptP = run.client.prompt(run.sessionId, prompt);
      // We may stop awaiting this prompt below (force-kill rejects it);
      // attach a no-op catch so the orphaned rejection isn't flagged.
      promptP.catch(() => {});

      // Stop handling: on abort, send session/cancel; if the adapter hasn't
      // unwound within the grace, force-kill it and resolve as cancelled.
      // This guarantees the turn ends even if the adapter ignores cancel.
      const cancelledP = new Promise<{ stopReason: string }>((resolve) => {
        if (!signal) return;
        onAbort = () => {
          run.client.cancel(run.sessionId).catch(() => {});
          graceTimer = setTimeout(() => {
            this.dispose(runId);
            resolve({ stopReason: "cancelled" });
          }, cancelGraceMs);
          graceTimer.unref?.();
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });

      const res = await Promise.race([promptP, cancelledP]);
      return { stopReason: res.stopReason, sessionId: run.sessionId };
    } catch (e) {
      // A kill-induced "connection closed" during a stop is an expected cancel.
      if (signal?.aborted) return { stopReason: "cancelled", sessionId: run.sessionId };
      throw e;
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      if (graceTimer) clearTimeout(graceTimer);
      run.inflight--;
      this.scheduleDispose(runId);
    }
  }

  /** Model/effort application is best-effort: a bad value must never block a turn. */
  private async applyModelAndEffort(run: ActiveRun, model?: string, effort?: string): Promise<void> {
    if (model && model !== "default") {
      try {
        await run.client.setSessionConfigOption(run.sessionId, "model", model);
      } catch {
        // warn-and-continue: engine default applies
      }
    }
    if (effort && effort !== "default") {
      try {
        await run.client.setSessionConfigOption(run.sessionId, "effort", effort);
      } catch {
        // warn-and-continue
      }
    }
  }

  dispose(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    this.cancelDispose(run);
    run.client.dispose();
    this.runs.delete(runId);
  }

  /** Tear down the connection a grace window after its last turn ends. */
  private scheduleDispose(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || run.inflight > 0) return;
    this.cancelDispose(run);
    const graceMs = this.opts.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS;
    if (graceMs <= 0) {
      this.dispose(runId);
      return;
    }
    run.disposeTimer = setTimeout(() => {
      const r = this.runs.get(runId);
      if (r && r.inflight === 0) this.dispose(runId);
    }, graceMs);
    run.disposeTimer.unref?.();
  }

  private cancelDispose(run: ActiveRun): void {
    if (run.disposeTimer) {
      clearTimeout(run.disposeTimer);
      run.disposeTimer = undefined;
    }
  }

  disposeAll(): void {
    for (const runId of [...this.runs.keys()]) this.dispose(runId);
  }

  /** Reuse the warm connection if it matches; otherwise build a fresh one. */
  private async ensureRun(
    runId: string,
    agent: CodingAgent,
    cwd: string,
    broker: GovernedPermissionBroker,
    onEvent: (event: AcpRunEvent) => void,
  ): Promise<ActiveRun> {
    const existing = this.runs.get(runId);
    if (existing && existing.agent === agent && existing.cwd === cwd) {
      this.cancelDispose(existing);
      existing.client.setHandlers(broker, onEvent);
      return existing;
    }
    if (existing) this.dispose(runId);

    const client = new GovernedAcpClient({
      agent,
      cwd,
      launchSpec: this.opts.launchSpecFor(agent, cwd),
      broker,
      fsGuard: this.opts.fsGuard,
      onEvent,
    });
    try {
      await client.start();
      const sessionId = await this.openSession(runId, agent, cwd, client);
      const run: ActiveRun = { client, sessionId, agent, cwd, inflight: 0 };
      this.runs.set(runId, run);
      return run;
    } catch (e) {
      client.dispose();
      throw e;
    }
  }

  /** Resume the persisted session when possible; else start a fresh one. */
  private async openSession(
    runId: string,
    agent: CodingAgent,
    cwd: string,
    client: GovernedAcpClient,
  ): Promise<string> {
    const stored = await this.opts.sessionStore.read(runId);
    if (stored && stored.agent === agent && stored.cwd === cwd && client.loadSupported) {
      try {
        await client.loadSession(stored.sessionId);
        return stored.sessionId;
      } catch {
        // Stored session is stale/unloadable — fall through to a fresh one.
        await this.opts.sessionStore.clear(runId);
      }
    }
    const sessionId = await client.newSession();
    await this.opts.sessionStore.write({ runId, agent, cwd, sessionId });
    return sessionId;
  }
}
