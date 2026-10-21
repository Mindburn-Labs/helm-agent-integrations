#!/usr/bin/env node
/** One-episode NDJSON process boundary. Kernel authority stays with the host. */
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { AcpSessionManager } from "./manager.js";
import { buildAdapterLaunchSpec } from "./client.js";
import { FsGuard, type FsGuardOptions } from "./fs-guard.js";
import { SessionStore } from "./session-store.js";
import { HelmKernelEvaluator, type HelmKernelEvaluatorOptions, type KernelEvaluationRequest, type KernelEvaluator, type KernelVerdict } from "./kernel-evaluator.js";
import type { AcpMcpServer, AcpRunEvent, ApprovalPolicy, BridgedCodingAgent, ProcessTermination } from "./types.js";

export type KernelPermissionDecision = Pick<KernelVerdict, "decisionId" | "receiptId" | "reason" | "reasonCode"> & { verdict: "ALLOW" | "DENY" | "ESCALATE" | "PENDING" };
export interface BridgeRunParams {
  runId: string;
  agent: BridgedCodingAgent;
  cwd: string;
  prompt: string;
  policy: ApprovalPolicy;
  model?: string;
  effort?: string;
  mcpServers?: AcpMcpServer[];
  launch: { adapterEntry: string; engineExecutablePath?: string; extraEnv?: NodeJS.ProcessEnv };
  evaluator: "host" | "kernel";
  kernel?: HelmKernelEvaluatorOptions;
  fsRoots: FsGuardOptions["roots"];
  cancelGraceMs?: number;
  hostTimeoutMs?: number;
}

type Pending = { kind: "permission" | "session"; sessionId?: string; resolve(value: unknown): void; reject(error: Error): void };
const emptyTermination = (): ProcessTermination => ({ adapterExited: true, descendantsExited: true, forced: false });

export async function runBridge(): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Map<string, Pending>();
  const controller = new AbortController();
  let manager: AcpSessionManager | undefined;
  let runId: string | undefined;
  let used = false;
  let active: Promise<void> | undefined;
  let sessionPendingId: string | undefined;
  const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");

  const waitForHost = (id: string, kind: Pending["kind"], timeoutMs: number, signal: AbortSignal, sessionId?: string): Promise<unknown> => new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); pending.delete(id); signal.removeEventListener("abort", abort); };
    const abort = () => {
      cleanup();
      if (kind === "permission") send({ type: "permission_cancelled", runId, id });
      reject(new Error("HELM ACP: host request cancelled"));
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`HELM ACP: host ${kind} response timed out`)); }, timeoutMs);
    pending.set(id, { kind, sessionId, resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });

  async function run(id: unknown, params: BridgeRunParams): Promise<void> {
    let sessionDir: string | undefined;
    let sessionBound = false;
    const startupEvents: AcpRunEvent[] = [];
    let startupBytes = 0;
    try {
      if (!params || typeof params.runId !== "string" || !params.runId || !["claude", "codex"].includes(params.agent) || !path.isAbsolute(params.cwd) || typeof params.prompt !== "string" || !["ask", "auto-approve-reads"].includes(params.policy)) throw new Error("HELM ACP: invalid run parameters");
      if (!["host", "kernel"].includes(params.evaluator)) throw new Error("HELM ACP: evaluator must be host or kernel");
      runId = params.runId;
      const timeout = params.hostTimeoutMs ?? 30_000;
      if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 300_000) throw new Error("HELM ACP: invalid host response timeout");
      const evaluator: KernelEvaluator = params.evaluator === "host" ? {
        evaluate: async (request: KernelEvaluationRequest, signal?: AbortSignal) => {
          if (!sessionBound) throw new Error("HELM ACP: permission requested before host bound the session");
          if (!request.ask.action || !request.ask.toolCallId) throw new Error("HELM ACP: incomplete permission semantics");
          const permissionId = randomUUID();
          const result = waitForHost(permissionId, "permission", timeout, signal ?? controller.signal);
          send({ type: "permission", runId, id: permissionId, request: request.ask, tier: request.tier, agent: request.agent, cwd: request.cwd, policy: request.policy });
          return await result as KernelVerdict;
        },
      } : new HelmKernelEvaluator(params.kernel!);
      sessionDir = await mkdtemp(path.join(tmpdir(), "helm-acp-bridge-"));
      manager = new AcpSessionManager({
        sessionStore: new SessionStore(sessionDir), fsGuard: new FsGuard({ roots: params.fsRoots }), evaluator,
        launchSpecFor: agent => {
          if (agent !== "claude" && agent !== "codex") throw new Error("HELM ACP: unsupported bridged agent");
          return buildAdapterLaunchSpec({ agent, ...params.launch });
        },
        mcpServers: params.mcpServers ?? [], cancelGraceMs: params.cancelGraceMs,
      });
      const result = await manager.runPrompt({
        runId, agent: params.agent, cwd: params.cwd, prompt: params.prompt, policy: params.policy,
        model: params.model, effort: params.effort, signal: controller.signal, freshSession: true,
        onSessionReady: async sessionId => {
          sessionPendingId = randomUUID();
          const bound = waitForHost(sessionPendingId, "session", timeout, controller.signal, sessionId);
          send({ type: "session", runId, sessionId });
          await bound;
          sessionPendingId = undefined;
          sessionBound = true;
          for (const event of startupEvents) send({ type: "event", runId, event });
          startupEvents.length = 0;
        },
        onEvent: event => {
          if (sessionBound) { send({ type: "event", runId, event }); return; }
          if (event.type === "tool_call" || event.type === "tool_call_update" || event.type === "permission") throw new Error("HELM ACP: tool execution attempted before host session binding");
          startupBytes += Buffer.byteLength(JSON.stringify(event), "utf8");
          if (startupBytes > 1024 * 1024) throw new Error("HELM ACP: startup evidence limit exceeded");
          startupEvents.push(event);
        },
      });
      const termination = result.termination ?? await manager.dispose(runId);
      if (!termination.adapterExited || !termination.descendantsExited) throw new Error(`HELM ACP: process termination unconfirmed: ${JSON.stringify(termination)}`);
      send({ id, result: { ...result, termination } });
    } catch (error) {
      const termination = manager && runId ? await manager.dispose(runId).catch(() => ({ adapterExited: false, descendantsExited: false, forced: false })) : emptyTermination();
      send({ id, error: { code: "ACP_RUN_FAILED", message: String(error instanceof Error ? error.message : error), termination } });
    } finally {
      await manager?.disposeAll();
      if (sessionDir) await rm(sessionDir, { recursive: true, force: true });
    }
  }

  async function command(message: unknown): Promise<void> {
    const request = message as { id?: unknown; method?: string; params?: Record<string, unknown> };
    const id = request?.id;
    try {
      switch (request.method) {
        case "run":
          if (used) throw new Error("HELM ACP: one run per bridge process");
          used = true;
          active = run(id, request.params as unknown as BridgeRunParams);
          return;
        case "session_bound": {
          const item = sessionPendingId ? pending.get(sessionPendingId) : undefined;
          if (!item || item.kind !== "session" || item.sessionId !== request.params?.sessionId) throw new Error("HELM ACP: unknown or mismatched session binding acknowledgement");
          item.resolve({ accepted: true });
          send({ id, result: { accepted: true } });
          return;
        }
        case "permission_result": {
          const permissionId = request.params?.permissionId;
          const item = typeof permissionId === "string" ? pending.get(permissionId) : undefined;
          if (!item || item.kind !== "permission") throw new Error("HELM ACP: unknown or late permission reply");
          const decision = request.params?.decision as KernelPermissionDecision;
          if (!decision || !["ALLOW", "DENY", "ESCALATE", "PENDING"].includes(decision.verdict) || (decision.verdict === "ALLOW" && (typeof decision.decisionId !== "string" || !decision.decisionId.trim() || typeof decision.receiptId !== "string" || !decision.receiptId.trim()))) {
            item.reject(new Error("HELM ACP: invalid host authority response"));
            throw new Error("HELM ACP: ALLOW requires decision and receipt evidence");
          }
          item.resolve({ verdict: decision.verdict, decisionId: decision.decisionId, receiptId: decision.receiptId, reason: decision.reason, reasonCode: decision.reasonCode });
          send({ id, result: { accepted: true } });
          return;
        }
        case "stop":
        case "dispose": {
          if (request.params?.runId !== undefined && request.params.runId !== runId) throw new Error("HELM ACP: unknown runId");
          controller.abort();
          const termination = manager && runId ? await manager.stop(runId) : emptyTermination();
          send({ id, result: { termination } });
          return;
        }
        default: throw new Error("HELM ACP: unsupported bridge method");
      }
    } catch (error) { send({ id, error: { code: "ACP_COMMAND_REJECTED", message: error instanceof Error ? error.message : String(error) } }); }
  }

  input.on("line", line => {
    if (Buffer.byteLength(line, "utf8") > 2 * 1024 * 1024) { controller.abort(); send({ error: { code: "ACP_INPUT_LIMIT", message: "Bridge input exceeds limit" } }); return; }
    try { void command(JSON.parse(line)); }
    catch { send({ error: { code: "ACP_INVALID_JSON", message: "Invalid NDJSON request" } }); }
  });
  const shutdown = () => { controller.abort(); for (const item of pending.values()) item.reject(new Error("HELM ACP: bridge disconnected")); };
  process.once("SIGTERM", () => { shutdown(); input.close(); process.stdin.destroy(); });
  process.once("SIGINT", () => { shutdown(); input.close(); process.stdin.destroy(); });
  await new Promise<void>(resolve => input.once("close", resolve));
  shutdown();
  await active;
  await manager?.disposeAll();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runBridge();
