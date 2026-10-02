// Credentials and slot state on disk: a 0700 directory, 0600 files, atomic writes, and a lock file for the
// steps that must not run twice at once (a rotating refresh token, an episode mint).
// ponytail: no OS keychain. A 0600 file in a 0700 directory is what CONTRACT.md promises. A keychain backend
// would replace load/save for credentials only; add it when an executor runs on a machine that other users share.

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Ctx } from "./ctx.js";
import { ExecutorError } from "./errors.js";

export interface Credentials {
  cp_url: string;
  org_id?: string;
  workspace_id: string;
  credential_id: string;
  subject: string;
  client_name: string;
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
  refresh_expires_at: string;
  logged_in_at: string;
  /** Set when a renewal's answer never arrived, so the rotating refresh token may have been replaced without us. */
  refresh_in_doubt_at?: string;
}

export interface CachedToken {
  value: string;
  expires_at: string;
  minted_at: string;
}

export interface SlotState {
  slot: string;
  client: string;
  org_id: string;
  workspace_id: string;
  work_item_id: string;
  episode_id: string;
  deadline: string;
  checked_out_at: string;
  token?: CachedToken;
  /** Set when the control plane said the episode is gone (410). Later calls fail without the network. */
  ended?: { at: string; reason: string };
  /** How far the control plane's clock was ahead of this machine's at the last answer, when it was off by 5 s or more. */
  clock_skew_ms?: number;
}

const SKEW_FLOOR_MS = 5_000;
const SKEW_CEILING_MS = 24 * 3_600_000;

/** The skew to remember from a response's `Date` header: zero unless this clock is clearly off. */
export function skewFrom(serverDateMs: number | null, nowMs: number): number {
  if (serverDateMs === null) return 0;
  const skew = serverDateMs - nowMs;
  return Math.abs(skew) < SKEW_FLOOR_MS || Math.abs(skew) > SKEW_CEILING_MS ? 0 : skew;
}

/** A timestamp from the control plane for this slot's episode, as a time on this machine's clock. */
export function localMs(slot: Pick<SlotState, "clock_skew_ms">, serverTime: string): number {
  return Date.parse(serverTime) - (slot.clock_skew_ms ?? 0);
}

export interface ObserveRecord {
  last_ok_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  dropped: number;
}

export function ensureSecureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new ExecutorError("internal", "the state path is not a plain directory");
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new ExecutorError("internal", "the state directory is not owned by the current user");
  }
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function readJson<T>(path: string, corrupt?: (path: string) => ExecutorError): T | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw corrupt?.(path) ?? new ExecutorError("internal", `state file ${path} is corrupt; remove it and retry`);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lock is stale when its owner process is gone, or when a live owner has stopped refreshing it. */
function lockIsStale(lockPath: string, staleMs: number): boolean {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(lockPath, "utf8");
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return false;
  }
  try {
    const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
    if (typeof pid === "number" && !pidAlive(pid)) return true;
  } catch {
    // an unreadable owner record falls back to the age rule
  }
  return Date.now() - mtimeMs > staleMs;
}

/** A takeover guard is held for microseconds, so one this old was left by a process that died while holding it. */
const GUARD_STALE_MS = 5_000;

/**
 * Remove a stale lock. Takeovers are serialized by a second lock file and staleness is judged again under it, so of
 * several waiters that saw the same dead holder exactly one removes the lock, and none removes a new holder's.
 */
function takeOver(lockPath: string, staleMs: number): void {
  const guard = `${lockPath}.takeover`;
  let fd: number;
  try {
    fd = openSync(guard, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    try {
      if (Date.now() - statSync(guard).mtimeMs > GUARD_STALE_MS) rmSync(guard, { force: true });
    } catch {
      // already gone
    }
    return;
  }
  closeSync(fd);
  try {
    if (lockIsStale(lockPath, staleMs)) rmSync(lockPath, { force: true });
  } finally {
    rmSync(guard, { force: true });
  }
}

export interface LockTiming {
  /** How long a lock can go without being refreshed before a waiter takes it over. */
  staleMs: number;
  /** How often the holder refreshes it. */
  heartbeatMs: number;
}

const LOCK_TIMING: LockTiming = { staleMs: 30_000, heartbeatMs: 5_000 };

/** Remove the lock only when it is still ours: a waiter may have taken over a lock this process stopped refreshing. */
function releaseLock(lockPath: string, owner: string): void {
  try {
    if (readFileSync(lockPath, "utf8") !== owner) return;
  } catch {
    return;
  }
  rmSync(lockPath, { force: true });
}

/**
 * Run `fn` while holding an exclusive lock file. Waits up to `timeoutMs`, then fails as `unavailable`.
 * The holder refreshes the lock's modification time while `fn` runs, so a long holder, such as `checkout --wait`,
 * is never mistaken for a crashed one.
 */
export async function withLock<T>(lockPath: string, timeoutMs: number, fn: () => Promise<T>, timing: Partial<LockTiming> = {}): Promise<T> {
  const { staleMs, heartbeatMs } = { ...LOCK_TIMING, ...timing };
  const deadline = Date.now() + timeoutMs;
  const owner = JSON.stringify({ pid: process.pid, t: Date.now(), n: randomBytes(4).toString("hex") });
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, owner);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (lockIsStale(lockPath, staleMs)) {
        takeOver(lockPath, staleMs);
        continue;
      }
      if (Date.now() >= deadline) throw new ExecutorError("unavailable", "timed out waiting for another helm-executor process");
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 40)));
    }
  }
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lockPath, now, now);
    } catch {
      // the lock is gone; the release below sees that
    }
  }, heartbeatMs);
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    releaseLock(lockPath, owner);
  }
}

// ---- paths -------------------------------------------------------------------------------------------------

export const credentialsPath = (ctx: Ctx): string => join(ctx.home, "credentials.json");
export const credentialsLockPath = (ctx: Ctx): string => join(ctx.home, "credentials.lock");
const slotsDir = (ctx: Ctx): string => join(ctx.home, "slots");
export const slotPath = (ctx: Ctx): string => join(slotsDir(ctx), `${ctx.slot}.json`);
export const slotLockPath = (ctx: Ctx): string => join(slotsDir(ctx), `${ctx.slot}.lock`);
const observePath = (ctx: Ctx): string => join(slotsDir(ctx), `${ctx.slot}.observe.json`);

function ensureHome(ctx: Ctx): void {
  ensureSecureDir(ctx.home);
}

function ensureSlots(ctx: Ctx): void {
  ensureHome(ctx);
  ensureSecureDir(slotsDir(ctx));
}

// ---- credentials -------------------------------------------------------------------------------------------

export function loadCredentials(ctx: Ctx): Credentials | null {
  return readJson<Credentials>(credentialsPath(ctx), (p) => new ExecutorError("not_logged_in", `the credentials file ${p} is corrupt; run \`helm-executor login\` to replace it`));
}

/** The stored credentials, or null when there are none or the file is unreadable. For `login`, which replaces them. */
export function loadCredentialsLenient(ctx: Ctx): Credentials | null {
  try {
    return loadCredentials(ctx);
  } catch (err) {
    if (err instanceof ExecutorError && err.code === "not_logged_in") return null;
    throw err;
  }
}

export function saveCredentials(ctx: Ctx, credentials: Credentials): void {
  ensureHome(ctx);
  writeJsonAtomic(credentialsPath(ctx), credentials);
}

// ---- slot --------------------------------------------------------------------------------------------------

export function loadSlot(ctx: Ctx): SlotState | null {
  return readJson<SlotState>(slotPath(ctx), (p) => new ExecutorError("no_episode", `the slot file ${p} is corrupt; run \`helm-executor stop --local\` and check out again`));
}

export function saveSlot(ctx: Ctx, state: SlotState): void {
  ensureSlots(ctx);
  writeJsonAtomic(slotPath(ctx), state);
}

export function clearSlot(ctx: Ctx): void {
  rmSync(slotPath(ctx), { force: true });
  rmSync(observePath(ctx), { force: true });
  clearPendingCheckout(ctx);
}

/**
 * The idempotency key of a checkout that has not been confirmed. It is kept across invocations: when every answer of one
 * run was lost, the control plane may still have created the episode, and the same key makes the next run get it back.
 */
export interface PendingCheckout {
  key: string;
  work_item_id: string;
  client: string;
  org_id: string;
  created_at: string;
}

const pendingPath = (ctx: Ctx): string => join(slotsDir(ctx), `${ctx.slot}.pending.json`);

export function loadPendingCheckout(ctx: Ctx): PendingCheckout | null {
  try {
    return readJson<PendingCheckout>(pendingPath(ctx));
  } catch {
    return null;
  }
}

export function savePendingCheckout(ctx: Ctx, pending: PendingCheckout): void {
  ensureSlots(ctx);
  writeJsonAtomic(pendingPath(ctx), pending);
}

export function clearPendingCheckout(ctx: Ctx): void {
  rmSync(pendingPath(ctx), { force: true });
}

export function ensureSlotDir(ctx: Ctx): void {
  ensureSlots(ctx);
}

// ---- observe record ----------------------------------------------------------------------------------------

export function loadObserveRecord(ctx: Ctx): ObserveRecord {
  try {
    return readJson<ObserveRecord>(observePath(ctx)) ?? { last_ok_at: null, last_error_at: null, last_error: null, dropped: 0 };
  } catch {
    return { last_ok_at: null, last_error_at: null, last_error: null, dropped: 0 };
  }
}

// ponytail: no lock. Concurrent observers can lose a counter increment; the record is a hint for `status`.
export function saveObserveRecord(ctx: Ctx, record: ObserveRecord): void {
  ensureSlots(ctx);
  writeJsonAtomic(observePath(ctx), record);
}
