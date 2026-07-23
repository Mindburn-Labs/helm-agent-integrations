// Telegram Bot API transport for the HELM channel bridge.
//
// Mechanism adapted from the Apache-2.0 Rowboat project (rowboatlabs/rowboat,
// apps/x/packages/core/src/channels/transports/telegram.ts); this is an
// original implementation. Deliberately dependency-free: the Bot API is plain
// HTTPS — getUpdates long polling (outbound only, works behind NAT) plus
// sendMessage. The operator supplies their own bot token (@BotFather) via
// environment variable ONLY; the token is never logged, persisted, or
// accepted from message/argument input.
//
// Fail-closed properties:
//   - DMs only: group chats would let any member drive the bridge.
//   - allowFrom is an explicit chat-ID allowlist; an empty allowlist denies
//     everyone.
//   - The getUpdates offset is persisted after each processed batch. Telegram
//     only confirms updates when a LATER getUpdates passes a higher offset,
//     so without persistence every restart would redeliver — and re-execute —
//     the last batch.
//   - 401/404 from the Bot API are terminal (token revoked / bot deleted);
//     retrying forever would hammer the API and misreport status.

import fs from "node:fs/promises";
import path from "node:path";
import type { FetchLike } from "./evaluator.js";

const POLL_TIMEOUT_S = 50;
const RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 60_000;

export const TELEGRAM_BOT_TOKEN_ENV = "HELM_TELEGRAM_BOT_TOKEN";

export type TelegramTransportStatus =
  | { state: "starting" }
  | { state: "polling"; botUsername?: string }
  | { state: "error"; error: string }
  | { state: "disabled" };

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

function isTerminal(error: unknown): boolean {
  return error instanceof TelegramApiError && (error.code === 401 || error.code === 404);
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number; is_bot?: boolean };
  };
}

export interface TelegramTransportOptions {
  /** Bot token, sourced from the HELM_TELEGRAM_BOT_TOKEN env var. Never logged. */
  botToken: string;
  /** Explicit chat-ID allowlist (as strings). Empty allowlist denies everyone. */
  allowFrom: string[];
  /** JSON file holding { offset } across restarts. */
  stateFile: string;
  /** chatId is the address to reply to; the caller owns reply routing. */
  onInbound: (senderKey: string, chatId: string, text: string) => void;
  onStatus?: (status: TelegramTransportStatus) => void;
  /** Injectable for tests. */
  fetch?: FetchLike;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  pollTimeoutS?: number;
}

export class TelegramTransport {
  private abort: AbortController | null = null;
  private stopped = false;
  private offset = 0;
  private botUsername: string | undefined;

  constructor(private readonly opts: TelegramTransportOptions) {
    if (!opts.botToken.trim()) {
      throw new Error(
        `Telegram bot token is required — set the ${TELEGRAM_BOT_TOKEN_ENV} environment variable`,
      );
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.opts.onStatus?.({ state: "starting" });
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    this.opts.onStatus?.({ state: "disabled" });
  }

  private fetchImpl(): FetchLike {
    const impl = this.opts.fetch ?? globalThis.fetch as FetchLike | undefined;
    if (!impl) {
      throw new TelegramApiError("No fetch implementation is available");
    }
    return impl;
  }

  private async call(method: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const res = await this.fetchImpl()(`https://api.telegram.org/bot${this.opts.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const payload = await res.json() as {
      ok: boolean;
      result?: unknown;
      description?: string;
      error_code?: number;
    };
    if (!payload.ok) {
      throw new TelegramApiError(
        payload.description ?? `Telegram API error (${method})`,
        payload.error_code,
      );
    }
    return payload.result;
  }

  /** Load the persisted poll offset; called by start() and exposed for tests. */
  async restoreOffset(): Promise<void> {
    try {
      const raw = await fs.readFile(this.opts.stateFile, "utf8");
      const parsed = JSON.parse(raw) as { offset?: unknown };
      if (typeof parsed.offset === "number" && Number.isFinite(parsed.offset)) {
        this.offset = parsed.offset;
      }
    } catch {
      // first run or unreadable state — start from 0
    }
  }

  private async saveOffset(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.opts.stateFile), { recursive: true });
      await fs.writeFile(this.opts.stateFile, JSON.stringify({ offset: this.offset }));
    } catch {
      // best effort — worst case is one redelivered batch after restart
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.opts.sleep) return this.opts.sleep(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async run(): Promise<void> {
    await this.restoreOffset();

    // Validate the token, retrying transient failures with backoff. Only a
    // definitive API rejection is terminal.
    let delay = RETRY_DELAY_MS;
    while (!this.stopped) {
      try {
        const me = await this.call("getMe") as { username?: string };
        if (this.stopped) return;
        this.botUsername = me.username;
        this.opts.onStatus?.({ state: "polling", botUsername: me.username });
        break;
      } catch (error) {
        if (this.stopped) return;
        if (isTerminal(error)) {
          this.opts.onStatus?.({
            state: "error",
            error: "Bot token rejected — create a new token with @BotFather.",
          });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.opts.onStatus?.({ state: "error", error: message });
        await this.sleep(delay);
        delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
      }
    }

    delay = RETRY_DELAY_MS;
    let healthy = true;
    while (!this.stopped) {
      try {
        await this.pollOnce();
        if (!healthy) {
          healthy = true;
          this.opts.onStatus?.({ state: "polling", botUsername: this.botUsername });
        }
        delay = RETRY_DELAY_MS;
      } catch (error) {
        if (this.stopped) return;
        if (isTerminal(error)) {
          this.opts.onStatus?.({
            state: "error",
            error: "Bot token rejected — create a new token with @BotFather.",
          });
          return;
        }
        healthy = false;
        const message = error instanceof Error ? error.message : String(error);
        this.opts.onStatus?.({ state: "error", error: message });
        await this.sleep(delay);
        delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
      }
    }
  }

  /** One getUpdates round; public so tests can drive the poll loop deterministically. */
  async pollOnce(): Promise<void> {
    this.abort = new AbortController();
    const updates = await this.call(
      "getUpdates",
      {
        timeout: this.opts.pollTimeoutS ?? POLL_TIMEOUT_S,
        offset: this.offset,
        allowed_updates: ["message"],
      },
      this.abort.signal,
    ) as TelegramUpdate[];
    for (const update of updates) {
      this.offset = update.update_id + 1;
      this.processUpdate(update);
    }
    if (updates.length > 0) {
      await this.saveOffset();
    }
  }

  /** Route one update; public so tests can exercise authorization directly. */
  processUpdate(update: TelegramUpdate): void {
    const message = update.message;
    if (!message?.text || message.from?.is_bot) return;
    // DMs only: group chats would let any member drive the bridge.
    if (message.chat.type !== "private") return;
    const chatId = String(message.chat.id);
    if (!this.opts.allowFrom.includes(chatId)) {
      void this.send(
        chatId,
        `⛔ Not authorized. Your chat ID is ${chatId} — add it to the bridge allowlist to pair this chat.`,
      ).catch(() => undefined);
      return;
    }
    this.opts.onInbound(`telegram:${chatId}`, chatId, message.text);
  }

  async send(chatId: string, text: string): Promise<void> {
    await this.call("sendMessage", { chat_id: chatId, text });
  }
}

/**
 * Build transport options with the bot token sourced from the environment.
 * The token MUST come from HELM_TELEGRAM_BOT_TOKEN (or an equivalent
 * operator-managed env var); it is never read from config files, command
 * arguments, or inbound messages.
 */
export function telegramOptionsFromEnv(
  env: NodeJS.ProcessEnv,
  rest: Omit<TelegramTransportOptions, "botToken">,
): TelegramTransportOptions {
  const token = env[TELEGRAM_BOT_TOKEN_ENV]?.trim() ?? "";
  if (token === "") {
    throw new Error(
      `Telegram bot token missing — set the ${TELEGRAM_BOT_TOKEN_ENV} environment variable`,
    );
  }
  return { ...rest, botToken: token };
}
