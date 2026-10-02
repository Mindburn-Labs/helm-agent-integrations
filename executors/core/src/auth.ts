// The machine credential: the device-code access token that authenticates every control plane call. It lives
// 15 minutes and is renewed with a rotating refresh token, so renewal runs under a lock: two processes that
// refreshed at once would burn the token and the loser would be logged out.

import { DEVICE_REFRESH_PATH, parseMachineToken, type MachineToken } from "./contract.js";
import type { Ctx } from "./ctx.js";
import { ExecutorError } from "./errors.js";
import { failForStatus, httpJson, normalizeBaseUrl, type HttpResult } from "./http.js";
import { credentialsLockPath, loadCredentials, saveCredentials, withLock, type Credentials } from "./state.js";

/** Wall-clock budget for one command. Uses real time: it bounds how long a helper may block its caller. */
export class Budget {
  private readonly end: number;

  constructor(totalMs: number) {
    this.end = Date.now() + totalMs;
  }

  left(): number {
    return this.end - Date.now();
  }

  /** Timeout for one HTTP call: at most `maxMs`, never past the budget. */
  http(maxMs: number): number {
    const left = this.left();
    if (left <= 50) throw new ExecutorError("unavailable", "timed out");
    return Math.min(maxMs, left);
  }
}

const REFRESH_MARGIN_MS = 60_000;
const HTTP_TIMEOUT_MS = 6_000;

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

type CredentialBase = Pick<Credentials, "cp_url" | "client_name" | "logged_in_at"> & { org_id?: string };

/** Credentials from a device-code or refresh grant: the grant's own fields plus absolute expiry times. */
export function credentialsFromGrant(base: CredentialBase, grant: MachineToken, now: number): Credentials {
  const { expires_in, refresh_expires_in, ...fields } = grant;
  return { ...base, ...fields, access_expires_at: iso(now + expires_in * 1000), refresh_expires_at: iso(now + refresh_expires_in * 1000) };
}

export function requireCredentials(ctx: Ctx): Credentials {
  const creds = loadCredentials(ctx);
  if (!creds) throw new ExecutorError("not_logged_in", "no machine credential; run `helm-executor login`");
  return creds;
}

/** The control plane origin: HELM_EXECUTOR_CP_URL wins over the one stored at login. */
export function cpUrl(ctx: Ctx, creds: Pick<Credentials, "cp_url">): string {
  return normalizeBaseUrl(ctx.env.HELM_EXECUTOR_CP_URL?.trim() || creds.cp_url);
}

function accessValid(ctx: Ctx, creds: Credentials): boolean {
  return Date.parse(creds.access_expires_at) - ctx.now() > REFRESH_MARGIN_MS;
}

async function refresh(ctx: Ctx, creds: Credentials, budget: Budget): Promise<Credentials> {
  if (Date.parse(creds.refresh_expires_at) <= ctx.now()) {
    throw new ExecutorError("not_logged_in", "the machine credential expired; run `helm-executor login`");
  }
  const res = await httpJson({
    method: "POST",
    url: `${cpUrl(ctx, creds)}${DEVICE_REFRESH_PATH}`,
    body: { grant_type: "refresh_token", refresh_token: creds.refresh_token },
    timeoutMs: budget.http(HTTP_TIMEOUT_MS),
  });
  if (res.status === 400 || res.status === 401) {
    throw new ExecutorError("not_logged_in", "the control plane refused to refresh the machine credential; run `helm-executor login`");
  }
  if (res.status !== 200) failForStatus(res, "machine credential refresh");
  const next = credentialsFromGrant(creds, parseMachineToken(res.json), ctx.now());
  saveCredentials(ctx, next);
  return next;
}

/**
 * A usable machine access token. `rejected` names a token the control plane just answered 401 to: it is renewed
 * unless another process already replaced it.
 */
export async function machineAccessToken(ctx: Ctx, budget: Budget, rejected?: string): Promise<{ creds: Credentials; token: string }> {
  const creds = requireCredentials(ctx);
  if (rejected === undefined && accessValid(ctx, creds)) return { creds, token: creds.access_token };
  return withLock(credentialsLockPath(ctx), Math.max(budget.left(), 0), async () => {
    const current = requireCredentials(ctx);
    const replaced = rejected !== undefined && current.access_token !== rejected;
    if (replaced || (rejected === undefined && accessValid(ctx, current))) return { creds: current, token: current.access_token };
    const next = await refresh(ctx, current, budget);
    return { creds: next, token: next.access_token };
  });
}

export interface MachineCall {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  client?: string;
  /** Per-request timeout, default 6 s. Never longer than what is left of the budget. */
  timeoutMs?: number;
}

/** One control plane call with the machine credential. A 401 renews the credential once and retries once. */
export async function callMachine(ctx: Ctx, budget: Budget, call: MachineCall): Promise<HttpResult> {
  const send = (creds: Credentials, token: string): Promise<HttpResult> =>
    httpJson({
      method: call.method,
      url: `${cpUrl(ctx, creds)}${call.path}`,
      bearer: token,
      body: call.body,
      headers: call.headers,
      client: call.client,
      timeoutMs: budget.http(call.timeoutMs ?? HTTP_TIMEOUT_MS),
    });

  const first = await machineAccessToken(ctx, budget);
  let res = await send(first.creds, first.token);
  if (res.status === 401) {
    const second = await machineAccessToken(ctx, budget, first.token);
    res = await send(second.creds, second.token);
    if (res.status === 401) {
      throw new ExecutorError("not_logged_in", "the control plane rejected the machine credential; run `helm-executor login`");
    }
  }
  return res;
}
