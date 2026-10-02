// Device-code login against the control plane's /api/v1/auth/device/* routes (internal/deviceauth/service.go).

import { hostname } from "node:os";
import { credentialsFromGrant, iso } from "../auth.js";
import {
  DEVICE_CODE_PATH,
  DEVICE_GRANT_TYPE,
  DEVICE_TOKEN_PATH,
  parseDeviceCode,
  parseMachineToken,
} from "../contract.js";
import type { Ctx } from "../ctx.js";
import { ExecutorError } from "../errors.js";
import { errorDetail, failForStatus, httpJson, normalizeBaseUrl } from "../http.js";
import { loadCredentials, saveCredentials, type Credentials } from "../state.js";

export interface LoginOptions {
  cpUrl?: string;
  org?: string;
  name?: string;
  /** Human instructions. They go to stderr, never stdout. */
  say(line: string): void;
}

const HTTP_TIMEOUT_MS = 15_000;
const MAX_TRANSIENT_FAILURES = 3;

function clientName(name: string | undefined): string {
  const label = (name?.trim() || `helm-executor@${hostname().split(".")[0] || "machine"}`).slice(0, 80);
  return label === "" ? "helm-executor" : label;
}

// ponytail: HELM_EXECUTOR_TEST_POLL_MS exists so the end-to-end tests do not wait the control plane's one second
// minimum interval. It only shortens the wait between polls.
function pollInterval(ctx: Ctx, seconds: number): number {
  const override = Number(ctx.env.HELM_EXECUTOR_TEST_POLL_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return Math.min(Math.max(seconds, 1), 60) * 1000;
}

export async function login(ctx: Ctx, opts: LoginOptions): Promise<Credentials> {
  const existing = loadCredentials(ctx);
  const rawUrl = opts.cpUrl ?? ctx.env.HELM_EXECUTOR_CP_URL?.trim() ?? existing?.cp_url;
  if (!rawUrl) throw new ExecutorError("usage", "pass --cp-url or set HELM_EXECUTOR_CP_URL");
  const base = normalizeBaseUrl(rawUrl);
  const name = clientName(opts.name);

  const started = await httpJson({
    method: "POST",
    url: `${base}${DEVICE_CODE_PATH}`,
    body: { client_name: name, client_type: "cli" },
    timeoutMs: HTTP_TIMEOUT_MS,
  });
  if (started.status !== 201 && started.status !== 200) failForStatus(started, "device authorization");
  const code = parseDeviceCode(started.json);

  opts.say(`To authorize this machine, open ${code.verification_uri_complete ?? code.verification_uri}`);
  opts.say(`and approve the code ${code.user_code}. Waiting for approval...`);

  let interval = pollInterval(ctx, code.interval);
  const giveUpAt = ctx.now() + Math.max(code.expires_in, 60) * 1000;
  let transient = 0;
  for (;;) {
    if (ctx.now() >= giveUpAt) {
      throw new ExecutorError("rejected", "device authorization expired before it was approved; run login again");
    }
    await ctx.sleep(interval);
    let res;
    try {
      res = await httpJson({
        method: "POST",
        url: `${base}${DEVICE_TOKEN_PATH}`,
        body: { grant_type: DEVICE_GRANT_TYPE, device_code: code.device_code },
        timeoutMs: HTTP_TIMEOUT_MS,
      });
    } catch (err) {
      if (err instanceof ExecutorError && err.code === "unavailable" && ++transient < MAX_TRANSIENT_FAILURES) continue;
      throw err;
    }
    if (res.status === 200) {
      const org = opts.org?.trim() || ctx.env.HELM_EXECUTOR_ORG?.trim() || existing?.org_id;
      const base0 = { cp_url: base, client_name: name, logged_in_at: iso(ctx.now()), ...(org ? { org_id: org } : {}) };
      const creds = credentialsFromGrant(base0, parseMachineToken(res.json), ctx.now());
      saveCredentials(ctx, creds);
      opts.say(`Logged in to workspace ${creds.workspace_id}.`);
      return creds;
    }
    const error = res.json && typeof res.json === "object" ? (res.json as Record<string, unknown>).error : undefined;
    switch (error) {
      case "authorization_pending":
        transient = 0;
        continue;
      case "slow_down":
        interval += 5_000;
        continue;
      case "expired_token":
        throw new ExecutorError("rejected", "device authorization expired before it was approved; run login again");
      case "access_denied":
        throw new ExecutorError("rejected", "device authorization was denied");
      case "invalid_grant":
        throw new ExecutorError("rejected", "device authorization is invalid or was already used; run login again");
      default:
        if (res.status === 429 || res.status >= 500) {
          if (++transient < MAX_TRANSIENT_FAILURES) {
            if (res.retryAfterMs) await ctx.sleep(res.retryAfterMs);
            continue;
          }
          throw new ExecutorError("unavailable", `device authorization: ${errorDetail(res)}`);
        }
        failForStatus(res, "device authorization");
    }
  }
}
