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
  /** Set when the control plane said the episode is gone. Later calls fail without the network. */
  ended?: { at: string; reason: string };
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

export function readJson<T>(path: string): T | null {
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
    throw new ExecutorError("internal", `state file ${path.split("/").pop()} is corrupt; remove it and retry`);
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

function lockIsStale(lockPath: string, staleMs: number): boolean {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(lockPath, "utf8");
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return false;
  }
  if (Date.now() - mtimeMs > staleMs) return true;
  try {
    const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
    return typeof pid === "number" && !pidAlive(pid);
  } catch {
    return false;
  }
}

/** Run `fn` while holding an exclusive lock file. Waits up to `timeoutMs`, then fails as `unavailable`. */
export async function withLock<T>(lockPath: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, t: Date.now() }));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // ponytail: two waiters can both judge a crashed holder's lock stale and both remove it. It needs a crash
      // plus simultaneous waiters; the cost is one refused refresh, fixed by logging in again.
      if (lockIsStale(lockPath, 30_000)) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new ExecutorError("unavailable", "timed out waiting for another helm-executor process");
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 40)));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockPath, { force: true });
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
  return readJson<Credentials>(credentialsPath(ctx));
}

export function saveCredentials(ctx: Ctx, credentials: Credentials): void {
  ensureHome(ctx);
  writeJsonAtomic(credentialsPath(ctx), credentials);
}

// ---- slot --------------------------------------------------------------------------------------------------

export function loadSlot(ctx: Ctx): SlotState | null {
  return readJson<SlotState>(slotPath(ctx));
}

export function saveSlot(ctx: Ctx, state: SlotState): void {
  ensureSlots(ctx);
  writeJsonAtomic(slotPath(ctx), state);
}

export function clearSlot(ctx: Ctx): void {
  rmSync(slotPath(ctx), { force: true });
  rmSync(observePath(ctx), { force: true });
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
