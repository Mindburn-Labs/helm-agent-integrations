// Transport-agnostic, HELM-governed channel bridge.
//
// Structure adapted from the Apache-2.0 Rowboat project's ChannelBridge
// (rowboatlabs/rowboat, apps/x/packages/core/src/channels/bridge.ts):
// per-sender session state, a command layer, a turn-settle watcher, and an
// ask_human relay. This is an original implementation with HELM-governed
// semantics instead of Rowboat's autoPermission-by-default behavior:
//
//   - EVERY inbound command is evaluated by the HELM Kernel before it may
//     execute. Non-ALLOW verdicts, unknown verdicts, and evaluator failures
//     are all fail-closed denials.
//   - Unknown slash-commands are denied locally without dispatch.
//   - autoPermission is granted only to commands in an explicit operator
//     allowlist (default: the routine read-only commands help/list/status).
//     Chat turns run with autoPermission=false unless the operator
//     deliberately allowlists "chat".

import type { ChannelDecision, ChannelEvaluator } from "./evaluator.js";

export type ReplyFn = (text: string) => Promise<void>;

export interface ChannelSessionSummary {
  sessionId: string;
  title?: string;
  updatedAt: string;
  latestTurnId?: string;
  latestTurnStatus?: string;
  error?: boolean;
}

export interface ChannelTurnSendOptions {
  /** True only when the command is in the operator autoPermission allowlist. */
  autoPermission: boolean;
  /** HELM principal that owns this turn (the channel sender). */
  principal: string;
  metadata?: Record<string, unknown>;
}

/**
 * Minimal governed-session engine the bridge drives. Implementations are
 * expected to route sendMessage/stopTurn/respondToAskHuman through the host
 * agent runtime; the bridge only ever calls them after a Kernel ALLOW.
 *
 * Session listing is principal-scoped: implementations MUST return only the
 * sessions the given principal is authorized to see. The bridge additionally
 * checks recorded ownership for sessions it created, so another sender cannot
 * list, resume, or drive them even if an in-process engine responds
 * incorrectly. After a bridge restart, the session engine remains the source
 * of truth for pre-existing session visibility.
 */
export interface ChannelSessions {
  /** Return only sessions visible to this principal (the channel sender). */
  listSessions(principal: string): ChannelSessionSummary[];
  createSession(): Promise<string>;
  sendMessage(
    sessionId: string,
    text: string,
    options: ChannelTurnSendOptions,
  ): Promise<{ turnId: string }>;
  stopTurn(turnId: string, reason: string): Promise<void>;
  respondToAskHuman(turnId: string, toolCallId: string, answer: string): Promise<void>;
}

export type ChannelTurnEvent =
  | { type: "turn_completed"; text: string | null }
  | { type: "turn_failed"; error: string }
  | { type: "turn_cancelled" }
  | {
    type: "turn_suspended";
    pendingAskHuman?: { toolCallId: string; question: string; options?: string[] } | null;
    pendingPermissions?: number;
  };

export interface ChannelTurnEventSource {
  /** Subscribe to settle-relevant events for every turn. Returns unsubscribe. */
  subscribeAll(
    listener: (event: { turnId: string; event: ChannelTurnEvent }) => void,
  ): () => void;
}

export interface ChannelBridgeConfig {
  /** Transport name used in action URNs, e.g. "telegram". */
  transportName: string;
  evaluator: ChannelEvaluator;
  sessions: ChannelSessions;
  turnEvents: ChannelTurnEventSource;
  /** Defaults to 30 minutes, matching the desktop turn budget. */
  turnTimeoutMs?: number;
  /**
   * Commands that may run with autoPermission. Default: ["help", "list",
   * "status"] — routine read-only commands. Adding "chat" restores
   * Rowboat-style permission-less turns and is a deliberate, risky operator
   * choice; turns otherwise always run with autoPermission=false so tool
   * effects still need Kernel/permission approval.
   */
  autoPermissionAllowlist?: string[];
  riskClass?: string;
}

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_AUTO_PERMISSION_ALLOWLIST = ["help", "list", "status"];
const LIST_LIMIT = 10;
// Telegram caps messages at 4096 chars; long replies are chunked, then
// truncated — the governed session keeps the full text.
const REPLY_CHUNK_SIZE = 3500;
const MAX_REPLY_CHUNKS = 3;

const HELP_TEXT = [
  "🤖 HELM channel commands:",
  "• help — show this help",
  "• list — recent governed sessions",
  "• resume N — continue session N from the list",
  "• new [message] — start a fresh governed session",
  "• status — current session and what it is doing",
  "• stop — cancel the running turn",
  "",
  "Anything else is evaluated by the HELM Kernel and, on ALLOW, sent to your current session.",
].join("\n");

/** Per-command effect classification for Kernel evaluation. */
const COMMAND_EFFECT_CLASS: Record<string, string> = {
  help: "E0",
  list: "E0",
  status: "E0",
  resume: "E1",
  new: "E1",
  stop: "E2",
  chat: "E3",
  ask_human_answer: "E3",
};

interface SenderState {
  activeSessionId: string | null;
  // sessionIds as last shown by `list` (1-based indexing for `resume N`).
  lastList: string[];
  pendingAsk: { turnId: string; toolCallId: string } | null;
  busy: boolean;
  // Turn currently occupying the sender. Cleared only by a real settle event
  // (or by the turn never starting); a watcher timeout alone NEVER clears it,
  // so a still-running turn keeps the sender busy.
  activeTurnId: string | null;
}

type Settled =
  | { kind: "completed"; text: string | null }
  | { kind: "failed"; error: string }
  | { kind: "cancelled" }
  | { kind: "ask_human"; toolCallId: string; question: string; options?: string[] }
  | { kind: "suspended" }
  | { kind: "timeout" };

interface ParsedCommand {
  name: string;
  arg?: string;
}

function parseCommand(trimmed: string): ParsedCommand {
  const slash = /^\/([a-zA-Z]+)(?:\s+([\s\S]+))?$/.exec(trimmed);
  if (slash) {
    return { name: slash[1].toLowerCase(), arg: slash[2]?.trim() };
  }
  const lower = trimmed.toLowerCase();
  if (lower === "help" || lower === "?") return { name: "help" };
  if (lower === "list" || lower === "chats") return { name: "list" };
  if (lower === "status") return { name: "status" };
  if (lower === "stop") return { name: "stop" };
  if (lower === "new") return { name: "new" };
  const newWithText = /^new\s+([\s\S]+)$/i.exec(trimmed);
  if (newWithText) return { name: "new", arg: newWithText[1].trim() };
  const resume = /^(?:resume|open)\s+(\d+)$/i.exec(trimmed);
  if (resume) return { name: "resume", arg: resume[1] };
  return { name: "chat", arg: trimmed };
}

const KNOWN_COMMANDS = new Set(["help", "list", "status", "stop", "new", "resume", "chat"]);

function settleOf(event: ChannelTurnEvent): Settled | null {
  switch (event.type) {
    case "turn_completed":
      return { kind: "completed", text: event.text };
    case "turn_failed":
      return { kind: "failed", error: event.error };
    case "turn_cancelled":
      return { kind: "cancelled" };
    case "turn_suspended": {
      const ask = event.pendingAskHuman;
      if (ask) {
        return {
          kind: "ask_human",
          toolCallId: ask.toolCallId,
          question: ask.question || "The agent needs your input.",
          options: ask.options,
        };
      }
      // Suspended without an ask_human means a permission approval is
      // waiting somewhere else (e.g. an operator console); report it.
      if ((event.pendingPermissions ?? 0) > 0) {
        return { kind: "suspended" };
      }
      return null;
    }
    default:
      return null;
  }
}

function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

function chunkReply(text: string): string[] {
  if (text.length <= REPLY_CHUNK_SIZE) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0 && parts.length < MAX_REPLY_CHUNKS) {
    parts.push(rest.slice(0, REPLY_CHUNK_SIZE));
    rest = rest.slice(REPLY_CHUNK_SIZE);
  }
  if (rest.length > 0) {
    parts[parts.length - 1] += "\n… (truncated — open the governed session for the full reply)";
  }
  return parts;
}

interface TurnWatcher {
  waitFor(turnId: string, timeoutMs: number): Promise<Settled>;
  dispose(): void;
}

export class ChannelBridge {
  private senders = new Map<string, SenderState>();
  // Ownership record for sessions created through this bridge. Used to
  // enforce per-principal scoping even if the session engine ever answers
  // with an unscoped listing (defense in depth — the engine scopes too).
  private sessionOwners = new Map<string, string>();
  private readonly turnTimeoutMs: number;
  private readonly autoPermissionAllowlist: Set<string>;

  constructor(private readonly config: ChannelBridgeConfig) {
    this.turnTimeoutMs = config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.autoPermissionAllowlist = new Set(
      config.autoPermissionAllowlist ?? DEFAULT_AUTO_PERMISSION_ALLOWLIST,
    );
  }

  /** True when the command may run with autoPermission (explicit allowlist only). */
  isAutoPermissionAllowed(commandName: string): boolean {
    return this.autoPermissionAllowlist.has(commandName);
  }

  async handleInbound(senderKey: string, text: string, reply: ReplyFn): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const state = this.senderState(senderKey);
    const command = parseCommand(trimmed);

    try {
      // Fail closed: unknown slash-commands are denied without evaluation or
      // dispatch. Bare text always parses to a known command ("chat").
      if (!KNOWN_COMMANDS.has(command.name)) {
        await reply(
          `⛔ Unknown command "/${command.name}" — denied by default. Send "help" for the command list.`,
        );
        return;
      }

      if (command.name === "chat" && state.pendingAsk) {
        await this.answerPendingAsk(state, senderKey, command.arg ?? trimmed, reply);
        return;
      }

      const decision = await this.evaluate(senderKey, state, command);
      if (decision.verdict !== "ALLOW") {
        await reply(denialText(command.name, decision));
        return;
      }

      switch (command.name) {
        case "help":
          await reply(HELP_TEXT);
          return;
        case "list":
          await reply(this.renderList(state, senderKey));
          return;
        case "resume":
          await reply(this.resumeSession(state, senderKey, Number(command.arg)));
          return;
        case "status":
          await reply(this.renderStatus(state, senderKey));
          return;
        case "stop":
          await reply(await this.stopActive(state, senderKey));
          return;
        case "new": {
          // A fresh-session request must never discard the active session
          // while its turn is still running. The Kernel has authorized this
          // command, but no local state change is safe until the sender is
          // free to start the new turn.
          if (state.busy) {
            await reply('⏳ Still working on the previous message — send "stop" to cancel it.');
            return;
          }
          state.activeSessionId = null;
          state.pendingAsk = null;
          if (!command.arg) {
            await reply("🆕 Fresh governed session — send your first message.");
            return;
          }
          // "new <message>" embeds a turn: command.new (E1, evaluated above)
          // only authorizes starting a fresh session. The message itself MUST
          // pass the full turn evaluation chain (E3 turn.run) before dispatch,
          // exactly like a bare chat message — otherwise policies that deny
          // channel turns would be bypassed by prefixing "new".
          const turnDecision = await this.evaluate(senderKey, state, { name: "chat", arg: command.arg });
          if (turnDecision.verdict !== "ALLOW") {
            await reply(denialText("chat", turnDecision));
            return;
          }
          await this.runChatTurn(state, senderKey, command.arg, reply);
          return;
        }
        case "chat":
          await this.runChatTurn(state, senderKey, command.arg ?? trimmed, reply);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await reply(`❌ ${message}`).catch(() => undefined);
    }
  }

  private senderState(senderKey: string): SenderState {
    let state = this.senders.get(senderKey);
    if (!state) {
      state = { activeSessionId: null, lastList: [], pendingAsk: null, busy: false, activeTurnId: null };
      this.senders.set(senderKey, state);
    }
    return state;
  }

  private evaluate(
    senderKey: string,
    state: SenderState,
    command: ParsedCommand,
  ): Promise<ChannelDecision> {
    const autoPermission = this.isAutoPermissionAllowed(command.name);
    const actionUrn = command.name === "chat"
      ? `channel.${this.config.transportName}.turn.run`
      : `channel.${this.config.transportName}.command.${command.name}`;
    return this.config.evaluator.evaluate({
      actionUrn,
      senderKey,
      sessionId: state.activeSessionId ?? `channel:${senderKey}`,
      input: { command: command.name, arg: command.arg },
      riskClass: this.config.riskClass ?? "T2",
      effectClass: COMMAND_EFFECT_CLASS[command.name] ?? "E3",
      metadata: {
        framework: "helm-channel-bridge",
        transport: this.config.transportName,
        command: command.name,
        auto_permission: autoPermission,
      },
    });
  }

  private sessionEntry(senderKey: string, sessionId: string): ChannelSessionSummary | undefined {
    const owner = this.sessionOwners.get(sessionId);
    if (owner !== undefined && owner !== senderKey) return undefined;
    return this.config.sessions
      .listSessions(senderKey)
      .find((e) => e.sessionId === sessionId);
  }

  /**
   * Sessions visible to one sender. The engine is asked for the
   * principal-scoped list; anything this bridge recorded as owned by a
   * different principal is dropped regardless, so cross-principal session
   * discovery or control is denied at the bridge boundary too.
   */
  private visibleSessions(senderKey: string): ChannelSessionSummary[] {
    return this.config.sessions
      .listSessions(senderKey)
      .filter((e) => {
        const owner = this.sessionOwners.get(e.sessionId);
        return owner === undefined || owner === senderKey;
      });
  }

  private recentSessions(senderKey: string): ChannelSessionSummary[] {
    return this.visibleSessions(senderKey)
      .filter((e) => !e.error)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, LIST_LIMIT);
  }

  private renderList(state: SenderState, senderKey: string): string {
    const entries = this.recentSessions(senderKey);
    if (entries.length === 0) {
      return "No governed sessions yet — just send a message to start one.";
    }
    state.lastList = entries.map((e) => e.sessionId);
    const now = Date.now();
    const lines = entries.map((e, i) => {
      const marker = e.latestTurnStatus === "suspended"
        ? " ⚠️"
        : e.latestTurnStatus === "idle"
          ? " ⏳"
          : "";
      const active = e.sessionId === state.activeSessionId ? " ← current" : "";
      return `${i + 1}. ${e.title ?? "Untitled"}${marker} (${relativeTime(e.updatedAt, now)})${active}`;
    });
    return ["Recent governed sessions:", ...lines, "", `Reply "resume N" to continue one.`].join("\n");
  }

  private resumeSession(state: SenderState, senderKey: string, index: number): string {
    if (state.lastList.length === 0) {
      state.lastList = this.recentSessions(senderKey).map((e) => e.sessionId);
    }
    const sessionId = state.lastList[index - 1];
    if (!sessionId) {
      return `No session #${index} — send "list" to see recent governed sessions.`;
    }
    // Defense in depth: never resume a session recorded under another
    // principal, even if it somehow surfaced in this sender's list.
    const owner = this.sessionOwners.get(sessionId);
    if (owner !== undefined && owner !== senderKey) {
      return "⛔ That session belongs to a different sender — access denied.";
    }
    const entry = this.sessionEntry(senderKey, sessionId);
    if (!entry) {
      state.lastList = [];
      return "⛔ That session is no longer available — send \"list\" to see your governed sessions.";
    }
    state.activeSessionId = sessionId;
    state.pendingAsk = null;
    return `▶️ Resumed "${entry?.title ?? "Untitled"}" — send a message to continue.`;
  }

  private renderStatus(state: SenderState, senderKey: string): string {
    if (!state.activeSessionId) {
      return "No current session — your next message starts a new governed one.";
    }
    const entry = this.sessionEntry(senderKey, state.activeSessionId);
    if (!entry) return "The current session no longer exists — send a message to start fresh.";
    const status = state.busy
      ? "working"
      : entry.latestTurnStatus === "suspended"
        ? "waiting on input"
        : entry.latestTurnStatus ?? "unknown";
    return `Current session: "${entry.title ?? "Untitled"}" — ${status}.`;
  }

  private async stopActive(state: SenderState, senderKey: string): Promise<string> {
    state.pendingAsk = null;
    if (!state.activeSessionId) return "Nothing to stop.";
    const entry = this.sessionEntry(senderKey, state.activeSessionId);
    if (!entry?.latestTurnId) return "Nothing to stop.";
    if (
      entry.latestTurnStatus === "completed"
      || entry.latestTurnStatus === "failed"
      || entry.latestTurnStatus === "cancelled"
    ) {
      return "Nothing running in the current session.";
    }
    await this.config.sessions.stopTurn(entry.latestTurnId, "stopped from governed channel");
    return "🛑 Stop requested.";
  }

  private async runChatTurn(
    state: SenderState,
    senderKey: string,
    text: string,
    reply: ReplyFn,
  ): Promise<void> {
    if (state.busy) {
      await reply('⏳ Still working on the previous message — send "stop" to cancel it.');
      return;
    }
    state.busy = true;
    const watcher = this.watchBus();
    try {
      await reply("⏳ Working on it…");
      if (!state.activeSessionId) {
        state.activeSessionId = await this.config.sessions.createSession();
        // Record ownership so no other sender can list/resume/drive it.
        this.sessionOwners.set(state.activeSessionId, senderKey);
      }
      const sent = await this.config.sessions.sendMessage(state.activeSessionId, text, {
        autoPermission: this.isAutoPermissionAllowed("chat"),
        principal: senderKey,
        metadata: {
          framework: "helm-channel-bridge",
          transport: this.config.transportName,
        },
      });
      state.activeTurnId = sent.turnId;
      const settled = await watcher.waitFor(sent.turnId, this.turnTimeoutMs);
      if (settled.kind === "timeout") {
        // The turn is still running. Keep the sender busy and reconcile the
        // busy flag from the actual settle event — a timeout alone must never
        // free the sender, or later messages would start concurrent turns in
        // the same session.
        this.reconcileBusyOnSettle(state, sent.turnId, reply);
      } else {
        state.activeTurnId = null;
        state.busy = false;
      }
      await this.deliverSettled(state, sent.turnId, settled, reply);
    } finally {
      watcher.dispose();
      if (state.activeTurnId === null) {
        state.busy = false;
      }
    }
  }

  private async answerPendingAsk(
    state: SenderState,
    senderKey: string,
    text: string,
    reply: ReplyFn,
  ): Promise<void> {
    const ask = state.pendingAsk;
    if (!ask) return;
    // The answer itself is an inbound command: Kernel-evaluated before it is
    // routed back into the suspended turn.
    const decision = await this.config.evaluator.evaluate({
      actionUrn: `channel.${this.config.transportName}.ask_human.answer`,
      senderKey,
      sessionId: state.activeSessionId ?? `channel:${senderKey}`,
      input: { command: "ask_human_answer", turnId: ask.turnId, toolCallId: ask.toolCallId, answer: text },
      riskClass: this.config.riskClass ?? "T2",
      effectClass: COMMAND_EFFECT_CLASS.ask_human_answer,
      metadata: {
        framework: "helm-channel-bridge",
        transport: this.config.transportName,
        command: "ask_human_answer",
        auto_permission: false,
      },
    });
    if (decision.verdict !== "ALLOW") {
      await reply(denialText("ask_human.answer", decision));
      return;
    }
    if (state.busy) {
      // Keep pendingAsk: the answer was NOT accepted for routing, so the
      // sender must be able to retry once the current turn frees up.
      await reply('⏳ Still working on the previous message — send "stop" to cancel it.');
      return;
    }
    state.busy = true;
    const watcher = this.watchBus();
    try {
      const settledPromise = watcher.waitFor(ask.turnId, this.turnTimeoutMs);
      // The answer is accepted for routing only now — clear pendingAsk at the
      // point of acceptance, not before the busy check or evaluation.
      state.pendingAsk = null;
      state.activeTurnId = ask.turnId;
      // respondToAskHuman may resolve only when the resumed turn settles, so
      // race it against the watcher rather than awaiting it first; a stale
      // ask (already answered elsewhere) rejects and is re-routed as chat.
      const settled = await Promise.race([
        settledPromise,
        this.config.sessions
          .respondToAskHuman(ask.turnId, ask.toolCallId, text)
          .then(() => settledPromise),
      ]);
      if (settled.kind === "timeout") {
        // Resumed turn still running: stay busy until its real settle event.
        this.reconcileBusyOnSettle(state, ask.turnId, reply);
      } else {
        state.activeTurnId = null;
        state.busy = false;
      }
      await this.deliverSettled(state, ask.turnId, settled, reply);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await reply(`❌ Could not deliver your answer: ${message}`);
    } finally {
      watcher.dispose();
      if (state.activeTurnId === null) {
        state.busy = false;
      }
    }
  }

  /**
   * After a watcher timeout the turn is still running. Subscribe for its real
   * settle event and only then free the sender (and deliver the outcome), so
   * the busy flag always reflects an actual turn completion/failure/cancel
   * rather than an arbitrary clock.
   */
  private reconcileBusyOnSettle(state: SenderState, turnId: string, reply: ReplyFn): void {
    const unsubscribe = this.config.turnEvents.subscribeAll((event) => {
      if (event.turnId !== turnId) return;
      const settled = settleOf(event.event);
      if (!settled) return;
      unsubscribe();
      if (state.activeTurnId === turnId) {
        state.activeTurnId = null;
        state.busy = false;
      }
      void this.deliverSettled(state, turnId, settled, reply).catch(() => undefined);
    });
  }

  private async deliverSettled(
    state: SenderState,
    turnId: string,
    settled: Settled,
    reply: ReplyFn,
  ): Promise<void> {
    switch (settled.kind) {
      case "completed":
        for (const chunk of chunkReply(settled.text ?? "✅ Done (no text reply).")) {
          await reply(chunk);
        }
        return;
      case "failed":
        await reply(`❌ Turn failed: ${settled.error}`);
        return;
      case "cancelled":
        await reply("🛑 Stopped.");
        return;
      case "ask_human": {
        state.pendingAsk = { turnId, toolCallId: settled.toolCallId };
        const lines = [`❓ ${settled.question}`];
        if (settled.options?.length) {
          lines.push(...settled.options.map((o, i) => `${i + 1}. ${o}`));
        }
        lines.push("", "Reply with your answer — it will be Kernel-evaluated before delivery.");
        await reply(lines.join("\n"));
        return;
      }
      case "suspended":
        await reply(
          "⚠️ The agent is waiting for a permission approval — continue from your governed console.",
        );
        return;
      case "timeout":
        await reply(
          "⏱️ Still running — this chat stays busy until the turn actually finishes; check the governed console for progress.",
        );
        return;
    }
  }

  // Buffers settle-relevant events from the moment of subscription so a
  // settle firing between sendMessage and waitFor() is never lost. One
  // watcher per in-flight message; mechanism adapted from Rowboat's
  // ChannelBridge (Apache-2.0), original implementation.
  private watchBus(): TurnWatcher {
    const buffered: Array<{ turnId: string; settled: Settled }> = [];
    let waiter: { turnId: string; resolve: (settled: Settled) => void } | null = null;
    let cancelTimer: (() => void) | null = null;
    const unsubscribe = this.config.turnEvents.subscribeAll((event) => {
      const settled = settleOf(event.event);
      if (!settled) return;
      if (waiter) {
        if (event.turnId === waiter.turnId) waiter.resolve(settled);
        return;
      }
      buffered.push({ turnId: event.turnId, settled });
    });
    return {
      waitFor: (turnId: string, timeoutMs: number): Promise<Settled> =>
        new Promise<Settled>((resolve) => {
          const hit = buffered.find((b) => b.turnId === turnId);
          if (hit) {
            resolve(hit.settled);
            return;
          }
          buffered.length = 0;
          const timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
          cancelTimer = () => clearTimeout(timer);
          waiter = {
            turnId,
            resolve: (settled) => {
              clearTimeout(timer);
              resolve(settled);
            },
          };
        }),
      dispose: () => {
        unsubscribe();
        cancelTimer?.();
      },
    };
  }
}

function denialText(commandName: string, decision: ChannelDecision): string {
  const reason = decision.reason ?? decision.reasonCode ?? "policy denial";
  const receipt = decision.receiptId ? ` (receipt ${decision.receiptId})` : "";
  return `⛔ HELM denied "${commandName}": ${reason}${receipt}`;
}
