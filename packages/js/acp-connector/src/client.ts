/**
 * Governed ACP client connector.
 *
 * Process-lifecycle mechanisms adapted (with attribution, Apache-2.0) from
 * Rowboat's code-mode AcpClient (apps/x/packages/core/src/code-mode/acp/
 * client.ts): a startup deadline on the handshake phases only, stderr-tail +
 * exit-code error enrichment, and handler swapping on a reused connection.
 * Reimplemented on this package's own minimal JSON-RPC peer, and diverging at
 * the trust boundary: fs handlers are constrained to a declarative allowlist
 * (FsGuard) and every permission request goes to a Kernel verdict — where
 * Rowboat serves raw fs on any path and answers permissions from a local
 * policy enum.
 */

import { spawn } from "node:child_process";
import type {
  AcpRunEvent,
  AcpMcpServer,
  BridgedCodingAgent,
  CodingAgent,
  InitializeResponse,
  NewSessionResponse,
  NativeAcpCodingAgent,
  PromptResponse,
  ReadTextFileRequest,
  RequestPermissionRequest,
  SessionNotification,
  WriteTextFileRequest,
  ProcessTermination,
} from "./types.js";
import { ACP_PROTOCOL_VERSION } from "./types.js";
import { NdJsonRpcPeer, JsonRpcError, JSON_RPC_INTERNAL_ERROR, JSON_RPC_METHOD_NOT_FOUND } from "./jsonrpc.js";
import type { FsGuard } from "./fs-guard.js";
import type { GovernedPermissionBroker } from "./permission.js";
import { canonicalJson } from "./kernel-evaluator.js";
import { ACP_EVENT_PAYLOAD_CAP, ToolCallTracker } from "./tool-calls.js";
import { assertSessionModes, checkedMcpServers, expectedSessionMode, reviewedLaunch, sessionParams } from "./session-safety.js";
import { abortable, OwnedProcessTree, throwIfAborted } from "./process-tree.js";

/** How to launch the ACP adapter process for an engine. */
export interface AdapterLaunchSpec {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

const INHERITED_ADAPTER_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
] as const;

function adapterBaseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ADAPTER_ENV) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/**
 * Build a launch spec for a vendor ACP adapter, pointing it at a managed
 * engine binary. Env-hook mechanism adapted from Rowboat's agents.ts
 * (CLAUDE_CODE_EXECUTABLE / CODEX_PATH decouple the engine from the adapter).
 */
export function buildAdapterLaunchSpec(opts: {
  agent: BridgedCodingAgent;
  adapterEntry: string;
  engineExecutablePath?: string;
  extraEnv?: NodeJS.ProcessEnv;
}): AdapterLaunchSpec {
  // Provider/cloud credentials are not ambient adapter capabilities. Callers
  // must pass each required credential explicitly through extraEnv.
  const env: NodeJS.ProcessEnv = { ...adapterBaseEnv(), ...opts.extraEnv };
  if (opts.engineExecutablePath) {
    if (opts.agent === "claude") env.CLAUDE_CODE_EXECUTABLE = opts.engineExecutablePath;
    if (opts.agent === "codex") env.CODEX_PATH = opts.engineExecutablePath;
  }
  return { command: process.execPath, args: [opts.adapterEntry], env };
}

const NATIVE_ACP_LAUNCH: Record<NativeAcpCodingAgent, AdapterLaunchSpec> = {
  gemini: { command: "gemini", args: ["--acp"] },
  kimi: { command: "kimi", args: ["acp"] },
  opencode: { command: "opencode", args: ["acp"] },
};

/** Launch a CLI that exposes ACP natively, without a vendor bridge package. */
export function buildNativeAcpLaunchSpec(opts: {
  agent: NativeAcpCodingAgent;
  command?: string;
  extraEnv?: NodeJS.ProcessEnv;
}): AdapterLaunchSpec {
  const spec = NATIVE_ACP_LAUNCH[opts.agent];
  return {
    command: opts.command ?? spec.command,
    args: [...spec.args],
    env: { ...adapterBaseEnv(), ...opts.extraEnv },
  };
}

// Deadline for the startup phases (initialize / session create+load) only.
// A healthy cold start takes seconds; a wedged engine would otherwise pend
// forever. Prompts are intentionally NOT time-limited: turns legitimately run
// for many minutes and may wait on kernel verdicts. Overridable via
// HELM_ACP_STARTUP_TIMEOUT_MS (CI, smoke tests). Read at call time so tests
// can override it per case.
function startupTimeoutMs(): number {
  const override = Number(process.env.HELM_ACP_STARTUP_TIMEOUT_MS);
  return override > 0 ? override : 60_000;
}

const STDERR_TAIL_BYTES = 4000;
const STDERR_TAIL_IN_ERROR = 1200;

export interface GovernedAcpClientOptions {
  agent: CodingAgent;
  cwd: string;
  launchSpec: AdapterLaunchSpec;
  broker: GovernedPermissionBroker;
  fsGuard: FsGuard;
  onEvent: (event: AcpRunEvent) => void;
  mcpServers?: AcpMcpServer[];
}

/** Map a raw session/update notification onto the small run-event union. */
function toEvent(update: { sessionUpdate?: string; [k: string]: unknown }): AcpRunEvent {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "user_message_chunk": {
      const c = update.content as { type?: string; text?: string } | undefined;
      const role = update.sessionUpdate === "user_message_chunk" ? "user" : "agent";
      return { type: "message", role, text: c?.type === "text" ? String(c.text ?? "") : `[${c?.type ?? "unknown"}]` };
    }
    case "agent_thought_chunk":
      return { type: "thought" };
    case "tool_call":
      return {
        type: "tool_call",
        id: update.toolCallId as string | undefined,
        title: update.title as string | undefined,
        kind: (update.kind as string | undefined) ?? undefined,
        status: (update.status as string | undefined) ?? undefined,
        ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
        ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
        ...(update.content !== undefined ? { content: update.content } : {}),
      };
    case "tool_call_update": {
      const diffs = ((update.content as Array<{ type?: string; path?: string }> | undefined) ?? [])
        .filter((c) => c.type === "diff" && typeof c.path === "string")
        .map((c) => c.path as string);
      return {
        type: "tool_call_update",
        id: update.toolCallId as string | undefined,
        status: (update.status as string | undefined) ?? undefined,
        diffs,
        ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
        ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
        ...(update.content !== undefined ? { content: update.content } : {}),
      };
    }
    case "plan": {
      const entries = ((update.entries as Array<{ content?: string; status?: string; priority?: string }> | undefined) ?? [])
        .map((e) => ({ content: String(e.content ?? ""), status: e.status, priority: e.priority }));
      return { type: "plan", entries };
    }
    case "usage_update":
      return { type: "usage", used: update.used as number | undefined, size: update.size as number | undefined };
    default:
      return { type: "other", sessionUpdate: String(update.sessionUpdate ?? "unknown") };
  }
}

/**
 * Owns one spawned adapter process + ACP connection. Stateless about
 * sessions — the manager decides whether to session/new or session/load.
 */
export class GovernedAcpClient {
  readonly agent: CodingAgent;
  readonly cwd: string;
  private readonly launchSpec: AdapterLaunchSpec;
  private readonly fsGuard: FsGuard;
  private broker: GovernedPermissionBroker;
  private onEvent: (event: AcpRunEvent) => void;
  private peer?: NdJsonRpcPeer;
  private loadSession_ = false;
  private stderrTail = "";
  private exitInfo: string | null = null;
  /** The session this connection actually opened. Inbound adapter requests
   *  naming any other session id are forged/stale and fail closed. */
  private activeSessionId: string | null = null;
  private readonly mcpServers: AcpMcpServer[];
  private readonly tracker = new ToolCallTracker();
  private readonly controller = new AbortController();
  private runSignal?: AbortSignal;
  private tree?: OwnedProcessTree;
  private fault?: Error;
  private disposal?: Promise<ProcessTermination>;
  private configOptions: Array<Record<string, unknown>> = [];
  private promptEnd?: Promise<unknown>;

  constructor(opts: GovernedAcpClientOptions) {
    this.agent = opts.agent;
    this.cwd = opts.cwd;
    this.mcpServers = checkedMcpServers(opts.mcpServers ?? []);
    this.launchSpec = reviewedLaunch(opts.agent, opts.launchSpec, this.mcpServers);
    this.fsGuard = opts.fsGuard;
    this.broker = opts.broker;
    this.onEvent = opts.onEvent;
  }

  get loadSupported(): boolean {
    return this.loadSession_;
  }

  /** Re-point the live connection at a new prompt's broker / event sink. */
  setHandlers(broker: GovernedPermissionBroker, onEvent: (event: AcpRunEvent) => void, signal?: AbortSignal): void {
    this.broker = broker;
    this.onEvent = onEvent;
    this.runSignal = signal;
  }

  /** Spawn the adapter and negotiate the protocol. Returns once initialized. */
  async start(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    throwIfAborted(this.controller.signal);
    if (process.platform === "win32") throw new Error("HELM ACP: supervised runtime requires POSIX process groups");
    this.runSignal = signal;
    const child = spawn(this.launchSpec.command, this.launchSpec.args, {
      cwd: this.cwd,
      env: this.launchSpec.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.tree = new OwnedProcessTree(child);
    child.stderr?.on("data", (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-STDERR_TAIL_BYTES);
    });
    child.on("exit", (code, signal) => {
      this.exitInfo = `adapter exited (code ${code}${signal ? `, signal ${signal}` : ""})`;
    });
    child.on("error", (err) => {
      this.stderrTail = (this.stderrTail + `\nspawn error: ${err.message}`).slice(-STDERR_TAIL_BYTES);
    });

    this.peer = new NdJsonRpcPeer({ input: child.stdout!, output: child.stdin!, label: `${this.agent}-adapter` });
    this.wireIncoming(this.peer);

    try {
      const init = await this.withStartupTimeout(abortable(
        this.peer.request<InitializeResponse>("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientInfo: { name: "helm-acp-connector", version: "0.1.0" },
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            // terminal capability deliberately NOT advertised: shell execution
            // must flow through kernel-gated tool calls, not a client-side
            // terminal backdoor.
            terminal: false,
          },
        }), this.signal()));
      if (init.protocolVersion !== ACP_PROTOCOL_VERSION || !init.agentCapabilities || typeof init.agentCapabilities !== "object") {
        throw new Error("HELM ACP: missing or incompatible protocol capabilities (fail-closed)");
      }
      this.loadSession_ = init.agentCapabilities?.loadSession === true;
    } catch (e) {
      throw this.enrich(e, "initialize");
    }
  }

  /**
   * Fail-closed session binding: an inbound request is only served when it
   * names the session this connection opened. Before any session exists, or
   * for any other id, the request is rejected — the adapter cannot escalate
   * privileges by quoting a session it was never given.
   */
  private sessionMatches(sessionId: unknown): boolean {
    return (
      this.activeSessionId !== null &&
      typeof sessionId === "string" &&
      sessionId === this.activeSessionId
    );
  }

  private signal(): AbortSignal { return this.runSignal ? AbortSignal.any([this.runSignal, this.controller.signal]) : this.controller.signal; }

  private check(): void {
    if (this.fault) throw this.fault;
    throwIfAborted(this.signal());
  }

  private fail(error: unknown): void {
    this.fault = error instanceof Error ? error : new Error(String(error));
    this.controller.abort();
    void this.dispose().catch(() => {});
  }

  private wireIncoming(peer: NdJsonRpcPeer): void {
    const self = this;
    peer.on(
      "request",
      async (
        method: string,
        params: unknown,
        respond: (result: unknown) => void,
        respondError: (err: JsonRpcError) => void,
      ) => {
        try {
          switch (method) {
            case "session/request_permission": {
              const req = params as RequestPermissionRequest;
              if (!self.sessionMatches(req.sessionId) || self.signal().aborted || self.fault) {
                // Forged/mismatched session — never reach the kernel, never
                // allow. `cancelled` is the protocol-level fail-closed answer.
                respond({ outcome: { outcome: "cancelled" } });
                return;
              }
              try {
                const toolCall = self.tracker.correlate(req.toolCall);
                const action = self.tracker.action(toolCall);
                if (action.server && !self.mcpServers.some(server => server.name === action.server)) throw new Error("HELM ACP: undeclared MCP server");
                const fingerprint = canonicalJson(toolCall);
                const result = await self.broker.resolve({ ...req, toolCall }, self.signal(), action);
                if (self.signal().aborted || fingerprint !== canonicalJson(self.tracker.correlate(req.toolCall))) respond({ outcome: { outcome: "cancelled" } });
                else respond(result);
              } catch { respond({ outcome: { outcome: "cancelled" } }); }
              return;
            }
            case "fs/read_text_file": {
              self.check();
              const req = params as ReadTextFileRequest;
              if (!self.sessionMatches(req.sessionId)) {
                throw new Error("HELM ACP: fs/read_text_file with an unknown session id (fail-closed)");
              }
              respond(await self.fsGuard.readTextFile(req));
              return;
            }
            case "fs/write_text_file": {
              self.check();
              const req = params as WriteTextFileRequest;
              if (!self.sessionMatches(req.sessionId)) {
                throw new Error("HELM ACP: fs/write_text_file with an unknown session id (fail-closed)");
              }
              respond(await self.fsGuard.writeTextFile(req));
              return;
            }
            default:
              respondError(new JsonRpcError(JSON_RPC_METHOD_NOT_FOUND, `unsupported method: ${method}`));
              return;
          }
        } catch (err) {
          respondError(
            new JsonRpcError(
              JSON_RPC_INTERNAL_ERROR,
              err instanceof Error ? err.message : String(err),
            ),
          );
        }
      },
    );
    peer.on("notification", (method: string, params: unknown) => {
      if (method === "session/update") {
        const n = params as SessionNotification;
        if (!self.sessionMatches(n.sessionId)) return;
        if (self.signal().aborted) return;
        try {
          if (Buffer.byteLength(canonicalJson(n.update), "utf8") > ACP_EVENT_PAYLOAD_CAP) throw new Error("HELM ACP: event exceeds retained evidence limit");
          if (n.update.sessionUpdate === "current_mode_update" && n.update.currentModeId !== expectedSessionMode(self.agent)) throw new Error("HELM ACP: adapter changed its reviewed session mode (fail-closed)");
          if (n.update.sessionUpdate === "config_option_update") {
            assertSessionModes(self.agent, n.update, false);
            self.configOptions = n.update.configOptions as Array<Record<string, unknown>>;
          }
          const event = toEvent(n.update);
          if (n.update.sessionUpdate === "tool_call" || n.update.sessionUpdate === "tool_call_update") {
            self.tracker.observe(n.update);
            if (event.type === "tool_call" || event.type === "tool_call_update") {
              try { event.action = self.tracker.action(self.tracker.correlate(n.update, true)); } catch { /* A later permission without concrete input rejects. */ }
            }
          }
          self.onEvent(event);
        } catch (error) { self.fail(error); }
      }
    });
  }

  /**
   * Race a startup-phase request against the deadline so a wedged engine
   * fails with a clear, enriched error instead of pending forever. Callers
   * dispose the client on failure, killing the spawned adapter.
   */
  private async withStartupTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `timed out after ${startupTimeoutMs() / 1000}s — the ${this.agent} engine failed to ` +
              "complete startup (it may be wedged or misconfigured)",
          ),
        );
      }, startupTimeoutMs());
      timer.unref?.();
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async newSession(): Promise<string> {
    try {
      this.check();
      const res = await this.withStartupTimeout(
        abortable(this.conn().request<NewSessionResponse>("session/new", sessionParams(this.agent, this.cwd, this.mcpServers)), this.signal()),
      );
      assertSessionModes(this.agent, res, true);
      this.activeSessionId = res.sessionId;
      this.configOptions = res.configOptions as Array<Record<string, unknown>>;
      await this.verifySession();
      return res.sessionId;
    } catch (e) {
      throw this.enrich(e, "newSession");
    }
  }

  async loadSession(sessionId: string): Promise<void> {
    try {
      this.check();
      const res = await this.withStartupTimeout(
        abortable(this.conn().request<Record<string, unknown>>("session/load", { sessionId, ...sessionParams(this.agent, this.cwd, this.mcpServers) }), this.signal()),
      );
      assertSessionModes(this.agent, res, true);
      this.activeSessionId = sessionId;
      this.configOptions = res.configOptions as Array<Record<string, unknown>>;
      await this.verifySession();
    } catch (e) {
      throw this.enrich(e, "loadSession");
    }
  }

  /** Read the agent's advertised model/effort options (throwaway session). */
  async describeModelOptions(): Promise<unknown> {
    try {
      const res = await this.withStartupTimeout(
        this.conn().request<NewSessionResponse>("session/new", sessionParams(this.agent, this.cwd, this.mcpServers)),
      );
      return { configOptions: res.configOptions ?? null, models: res.models ?? null };
    } catch (e) {
      throw this.enrich(e, "describeModelOptions");
    }
  }

  async setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    this.check();
    if (!this.sessionMatches(sessionId)) {
      throw new Error("HELM ACP: config update for an unknown session id (fail-closed)");
    }
    if (configId === "mode" && value !== expectedSessionMode(this.agent)) throw new Error("HELM ACP: unsafe mode change forbidden");
    const res = await this.withStartupTimeout(abortable(this.conn().request<Record<string, unknown>>("session/set_config_option", { sessionId, configId, value }), this.signal()));
    assertSessionModes(this.agent, res, false);
    const option = (res.configOptions as Array<Record<string, unknown>>).find(option => option.id === configId);
    if (!option || option.currentValue !== value) throw new Error(`HELM ACP: ${configId} was not applied (fail-closed)`);
    this.configOptions = res.configOptions as Array<Record<string, unknown>>;
  }

  async verifySession(): Promise<void> {
    if (!this.activeSessionId) throw new Error("HELM ACP: no active session");
    await this.setSessionConfigOption(this.activeSessionId, "mode", expectedSessionMode(this.agent));
  }

  configId(category: "model" | "effort"): string {
    const id = category === "effort" && this.agent === "codex" ? "reasoning_effort" : category;
    if (!this.configOptions.some(option => option.id === id)) throw new Error(`HELM ACP: missing ${category} configuration capability`);
    return id;
  }

  async prompt(sessionId: string, text: string, signal?: AbortSignal): Promise<PromptResponse> {
    this.runSignal = signal;
    this.check();
    if (!this.sessionMatches(sessionId)) {
      throw new Error("HELM ACP: prompt for an unknown session id (fail-closed)");
    }
    try {
      await this.verifySession();
      this.check();
      this.tracker.beginPrompt();
      const pending = this.conn().request<PromptResponse>("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      });
      this.promptEnd = pending.then(() => {}, () => {});
      return await abortable(pending, this.signal());
    } catch (e) {
      throw this.enrich(this.fault ?? e, "prompt");
    }
  }

  /** session/cancel is a notification per the ACP spec. */
  async cancel(sessionId: string): Promise<void> {
    if (!this.sessionMatches(sessionId)) {
      throw new Error("HELM ACP: cancel for an unknown session id (fail-closed)");
    }
    this.conn().notify("session/cancel", { sessionId });
    this.controller.abort();
  }

  async waitForPromptEnd(graceMs: number): Promise<void> {
    if (!this.promptEnd) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.promptEnd, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, graceMs)); })]); }
    finally { if (timer) clearTimeout(timer); }
  }

  /** Wrap a connection error with adapter exit/stderr context. */
  private enrich(err: unknown, phase: string): Error {
    const base = err instanceof Error ? err.message : String(err);
    const parts = [
      this.exitInfo,
      this.stderrTail.trim() ? `adapter output: ${this.stderrTail.trim().slice(-STDERR_TAIL_IN_ERROR)}` : "",
    ].filter(Boolean);
    return new Error(parts.length ? `${base} — ${parts.join(" | ")} [during ${phase}]` : `${base} [during ${phase}]`);
  }

  dispose(): Promise<ProcessTermination> {
    this.controller.abort();
    return this.disposal ??= (async () => {
      const result = this.tree ? await this.tree.terminate() : { adapterExited: true, descendantsExited: true, forced: false };
      this.peer?.close();
      this.peer = undefined;
      return result;
    })();
  }

  private conn(): NdJsonRpcPeer {
    if (!this.peer || this.peer.isClosed) throw new Error("ACP client not started");
    return this.peer;
  }
}
