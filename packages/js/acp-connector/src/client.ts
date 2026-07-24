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

import { spawn, type ChildProcess } from "node:child_process";
import type {
  AcpRunEvent,
  CodingAgent,
  InitializeResponse,
  NewSessionResponse,
  PromptResponse,
  ReadTextFileRequest,
  RequestPermissionRequest,
  SessionNotification,
  WriteTextFileRequest,
} from "./types.js";
import { ACP_PROTOCOL_VERSION } from "./types.js";
import { NdJsonRpcPeer, JsonRpcError, JSON_RPC_INTERNAL_ERROR, JSON_RPC_METHOD_NOT_FOUND } from "./jsonrpc.js";
import type { FsGuard } from "./fs-guard.js";
import type { GovernedPermissionBroker } from "./permission.js";

/** How to launch the ACP adapter process for an engine. */
export interface AdapterLaunchSpec {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Build a launch spec for a vendor ACP adapter, pointing it at a managed
 * engine binary. Env-hook mechanism adapted from Rowboat's agents.ts
 * (CLAUDE_CODE_EXECUTABLE / CODEX_PATH decouple the engine from the adapter).
 */
export function buildAdapterLaunchSpec(opts: {
  agent: CodingAgent;
  adapterEntry: string;
  engineExecutablePath?: string;
  extraEnv?: NodeJS.ProcessEnv;
}): AdapterLaunchSpec {
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.extraEnv };
  if (opts.engineExecutablePath) {
    if (opts.agent === "claude") env.CLAUDE_CODE_EXECUTABLE = opts.engineExecutablePath;
    if (opts.agent === "codex") env.CODEX_PATH = opts.engineExecutablePath;
  }
  return { command: process.execPath, args: [opts.adapterEntry], env };
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
  private child?: ChildProcess;
  private peer?: NdJsonRpcPeer;
  private loadSession_ = false;
  private stderrTail = "";
  private exitInfo: string | null = null;

  constructor(opts: GovernedAcpClientOptions) {
    this.agent = opts.agent;
    this.cwd = opts.cwd;
    this.launchSpec = opts.launchSpec;
    this.fsGuard = opts.fsGuard;
    this.broker = opts.broker;
    this.onEvent = opts.onEvent;
  }

  get loadSupported(): boolean {
    return this.loadSession_;
  }

  /** Re-point the live connection at a new prompt's broker / event sink. */
  setHandlers(broker: GovernedPermissionBroker, onEvent: (event: AcpRunEvent) => void): void {
    this.broker = broker;
    this.onEvent = onEvent;
  }

  /** Spawn the adapter and negotiate the protocol. Returns once initialized. */
  async start(): Promise<void> {
    const child = spawn(this.launchSpec.command, this.launchSpec.args, {
      cwd: this.cwd,
      env: this.launchSpec.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
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
      const init = await this.withStartupTimeout(
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
        }),
      );
      this.loadSession_ = init.agentCapabilities?.loadSession === true;
    } catch (e) {
      throw this.enrich(e, "initialize");
    }
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
            case "session/request_permission":
              respond(await self.broker.resolve(params as RequestPermissionRequest));
              return;
            case "fs/read_text_file":
              respond(await self.fsGuard.readTextFile(params as ReadTextFileRequest));
              return;
            case "fs/write_text_file":
              respond(await self.fsGuard.writeTextFile(params as WriteTextFileRequest));
              return;
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
        self.onEvent(toEvent(n.update ?? { sessionUpdate: "unknown" }));
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
      const res = await this.withStartupTimeout(
        this.conn().request<NewSessionResponse>("session/new", { cwd: this.cwd, mcpServers: [] }),
      );
      return res.sessionId;
    } catch (e) {
      throw this.enrich(e, "newSession");
    }
  }

  async loadSession(sessionId: string): Promise<void> {
    try {
      await this.withStartupTimeout(
        this.conn().request("session/load", { sessionId, cwd: this.cwd, mcpServers: [] }),
      );
    } catch (e) {
      throw this.enrich(e, "loadSession");
    }
  }

  /** Read the agent's advertised model/effort options (throwaway session). */
  async describeModelOptions(): Promise<unknown> {
    try {
      const res = await this.withStartupTimeout(
        this.conn().request<NewSessionResponse>("session/new", { cwd: this.cwd, mcpServers: [] }),
      );
      return { configOptions: res.configOptions ?? null, models: res.models ?? null };
    } catch (e) {
      throw this.enrich(e, "describeModelOptions");
    }
  }

  async setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    await this.conn().request("session/set_config_option", { sessionId, configId, value });
  }

  async prompt(sessionId: string, text: string): Promise<PromptResponse> {
    try {
      return await this.conn().request<PromptResponse>("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      });
    } catch (e) {
      throw this.enrich(e, "prompt");
    }
  }

  /** session/cancel is a notification per the ACP spec. */
  async cancel(sessionId: string): Promise<void> {
    this.conn().notify("session/cancel", { sessionId });
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

  dispose(): void {
    try {
      this.child?.kill();
    } catch {
      // already gone
    }
    this.child = undefined;
    this.peer = undefined;
  }

  private conn(): NdJsonRpcPeer {
    if (!this.peer || this.peer.isClosed) throw new Error("ACP client not started");
    return this.peer;
  }
}
