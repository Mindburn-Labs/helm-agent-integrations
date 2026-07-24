/**
 * Minimal ndJSON JSON-RPC 2.0 peer for ACP over a child process's stdio.
 *
 * Original implementation for the HELM ACP connector. ACP itself is the
 * Zed-originated JSON-RPC protocol; this peer only implements what the
 * connector needs: outgoing requests/notifications, incoming requests
 * dispatched to method handlers, incoming notifications, and line-buffered
 * framing. Deliberately small: fewer moving parts behind the HELM boundary.
 */

import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
}

export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INTERNAL_ERROR = -32603;
export const JSON_RPC_CANCELLED = -32800;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export type IncomingRequestHandler = (params: unknown) => Promise<unknown>;
export type NotificationHandler = (params: unknown) => void;

export interface NdJsonRpcPeerOptions {
  input: Readable;
  output: Writable;
  /** Human label used in error messages (e.g. "claude adapter"). */
  label?: string;
}

/**
 * A bidirectional JSON-RPC peer framed as newline-delimited JSON.
 * Events:
 *  - "request"   (method, params, respond) — agent → client requests
 *  - "notification" (method, params)       — agent → client notifications
 *  - "closed"    — the input stream ended; all pending requests reject
 */
export class NdJsonRpcPeer extends EventEmitter {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly label: string;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";
  private closed = false;

  constructor(opts: NdJsonRpcPeerOptions) {
    super();
    this.input = opts.input;
    this.output = opts.output;
    this.label = opts.label ?? "acp-peer";
    this.input.on("data", (chunk: Buffer) => this.onData(chunk));
    this.input.on("end", () => this.onClosed());
    this.input.on("error", () => this.onClosed());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Send a request and await its response. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`${this.label}: connection closed`));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.output.write(payload + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(new Error(`${this.label}: write failed — ${err.message}`));
        }
      });
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} });
    this.output.write(payload + "\n");
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) return;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length > 0) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // ignore non-JSON noise on stdout
    }
    const id = msg.id;
    const method = msg.method;

    if (typeof method === "string") {
      if (id !== undefined && id !== null) {
        // Incoming request — dispatch and respond.
        const respond = (result: unknown): void => {
          this.output.write(JSON.stringify({ jsonrpc: "2.0", id, result: result ?? {} }) + "\n");
        };
        const respondError = (err: JsonRpcError): void => {
          this.output.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) },
            }) + "\n",
          );
        };
        this.emit("request", method, msg.params ?? {}, respond, respondError);
      } else {
        this.emit("notification", method, msg.params ?? {});
      }
      return;
    }

    if (id !== undefined && id !== null && typeof id === "number") {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      const err = msg.error as { code?: number; message?: string; data?: unknown } | undefined;
      if (err) {
        entry.reject(new JsonRpcError(err.code ?? JSON_RPC_INTERNAL_ERROR, err.message ?? "unknown error", err.data));
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  private onClosed(): void {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      p.reject(new Error(`${this.label}: connection closed`));
    }
    this.emit("closed");
  }
}
