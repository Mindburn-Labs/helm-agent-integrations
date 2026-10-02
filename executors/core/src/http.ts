// The only place the client talks to the network. Rules: https (or http on loopback), no redirects so a bearer
// token never leaves the configured host, a hard timeout, a capped body, and failures mapped to stable codes.

import { ExecutorError } from "./errors.js";
import { redactSecrets } from "./redact.js";

export const VERSION = "0.1.0";

const MAX_BODY_BYTES = 1 << 20;

export interface HttpResult {
  status: number;
  json: unknown;
  retryAfterMs: number | null;
  /** The server's clock from the `Date` response header, or null when it sent none or sent nonsense. */
  serverDateMs: number | null;
}

export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  bearer?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs: number;
  client?: string;
}

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** Validate a control plane origin: https, or http on loopback only; no userinfo, query or fragment. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ExecutorError("usage", "the control plane URL is not a valid URL");
  }
  if (url.username || url.password) throw new ExecutorError("usage", "the control plane URL must not carry credentials");
  const secure = url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));
  if (!secure) throw new ExecutorError("usage", "the control plane URL must use https (http is allowed on loopback only)");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

/** The error codes under a failed fetch: its cause's own, and those of an AggregateError's members (one per address). */
function networkCodes(err: unknown): string[] {
  const cause = err instanceof Error ? (err as { cause?: { code?: unknown; errors?: unknown } }).cause : undefined;
  if (!cause) return [];
  const members = Array.isArray(cause.errors) ? (cause.errors as { code?: unknown }[]) : [];
  return [cause.code, ...members.map((m) => m?.code)].filter((c): c is string => typeof c === "string");
}

function describeNetworkError(err: unknown): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "request timed out";
  const codes = [...new Set(networkCodes(err))];
  return `connection failed${codes.length > 0 ? ` (${codes.join(", ")})` : ""}`;
}

/** Failures that happen before a request leaves this machine, so the server cannot have acted on it. */
const NEVER_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ERR_INVALID_URL", "UND_ERR_CONNECT_TIMEOUT"]);

function outcomeIsUnknown(err: unknown): boolean {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return true;
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  // fetch itself refuses some URLs, such as a blocked port, before any connection is made.
  if (cause instanceof Error && /^(bad port|invalid url)/i.test(cause.message)) return false;
  const codes = networkCodes(err);
  return !(codes.length > 0 && codes.every((c) => NEVER_SENT.has(c)));
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ExecutorError("unavailable", "the control plane response was too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseServerDate(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 60) * 1000 : null;
}

export async function httpJson(req: HttpRequest): Promise<HttpResult> {
  // Every caller builds the URL from a normalized base, but keep the invariant here too.
  normalizeBaseUrl(new URL(req.url).origin);
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": `helm-executor/${VERSION}${req.client ? ` (${req.client})` : ""}`,
    ...req.headers,
  };
  if (req.body !== undefined) headers["Content-Type"] = "application/json";
  if (req.bearer) headers.Authorization = `Bearer ${req.bearer}`;

  let res: Response;
  let text: string;
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      redirect: "manual",
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      throw new ExecutorError("rejected", "the control plane answered with a redirect; refusing to follow it");
    }
    text = await readCapped(res);
  } catch (err) {
    if (err instanceof ExecutorError) throw err;
    throw new ExecutorError("unavailable", `control plane unreachable: ${describeNetworkError(err)}`, { outcomeUnknown: outcomeIsUnknown(err) });
  }

  let json: unknown = null;
  if (text.trim() !== "") {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, retryAfterMs: parseRetryAfter(res.headers.get("retry-after")), serverDateMs: parseServerDate(res.headers.get("date")) };
}

/** A short, redacted reason from either error body shape the control plane uses. */
export function errorDetail(result: HttpResult): string {
  const body = result.json;
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    // Cut before redacting: the body can be a megabyte, and only 160 characters survive.
    const parts = [o.error, o.error_description ?? o.message].filter((v): v is string => typeof v === "string" && v !== "").map((v) => v.slice(0, 400));
    if (parts.length > 0) return redactSecrets(parts.join(": ")).slice(0, 160);
  }
  return `HTTP ${result.status}`;
}

/** Map a non-2xx status to the stable failure code, for calls with no more specific meaning. */
export function failForStatus(result: HttpResult, what: string): never {
  const detail = `${what}: ${errorDetail(result)}`;
  if (result.status === 401) throw new ExecutorError("not_logged_in", detail);
  if (result.status === 429 || result.status >= 500) throw new ExecutorError("unavailable", detail);
  throw new ExecutorError("rejected", detail);
}
