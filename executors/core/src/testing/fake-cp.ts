// A fake control plane for adapter tests and conformance runs, built from CONTRACT.md section 7: the real
// device-code routes (internal/deviceauth/service.go) and the assumed executor and observation routes, with
// the same status codes. It also serves an MCP endpoint that accepts episode tokens and stands in for the kernel
// gateway (see fake-gateway.ts), so a client's headers helper and a governed write flow can be checked end to end.
// Tokens expire on an injectable clock.

import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createFakeGateway, type FakeGateway } from "./fake-gateway.js";

export interface FakeRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface EpisodeRecord {
  episodeId: string;
  workItemId: string;
  client: string;
  deadlineMs: number;
  stopped: boolean;
  idempotencyKey: string;
}

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  body: unknown;
  fake: FakeCp;
}

export type RouteHandler = (ctx: RouteContext) => void | Promise<void>;

export interface FakeCpOptions {
  port?: number;
  workspaceId?: string;
  orgId?: string;
  /** Clock in ms. Defaults to Date.now. */
  now?: () => number;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  episodeTokenTtlSeconds?: number;
  episodeDeadlineSeconds?: number;
  /** Device-code polls answered authorization_pending before approval. Default 1. */
  pollsBeforeApproval?: number;
  /** Branch prefix the fake gateway's mandate allows for pushed branches. Default "helm/". */
  branchPrefix?: string;
  /** Extra routes, keyed "METHOD /path". They win over the built-in ones. */
  routes?: Record<string, RouteHandler>;
}

export interface FakeCp {
  url: string;
  workspaceId: string;
  orgId: string;
  requests: FakeRequest[];
  episodes: Map<string, EpisodeRecord>;
  close(): Promise<void>;
  /** Answer the next `times` requests whose "METHOD /path" contains `match` with `status` and an error body. */
  fail(match: string, status: number, times?: number, extra?: { retryAfter?: number; error?: string }): void;
  /** Make every access token issued so far answer 401. */
  revokeAccessTokens(): void;
  /** The episode a bearer episode token belongs to, or null when unknown, expired or stopped. */
  episodeForToken(authorization: string | undefined): EpisodeRecord | null;
  /** Observations accepted, in order. */
  observations: unknown[];
  /** The MCP endpoint's gateway stand-in: its attempts, and `approve` for an escalated one. */
  gateway: FakeGateway;
  /** How many refresh-token exchanges succeeded. */
  refreshCount(): number;
}

const b64 = (bytes: Buffer): string => bytes.toString("base64url");
const secret = (prefix: string): string => `${prefix}${b64(randomBytes(32))}`;

function fakeJwt(claims: Record<string, unknown>): string {
  const part = (v: unknown): string => b64(Buffer.from(JSON.stringify(v)));
  return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.${b64(randomBytes(24))}`;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return { __unparsable: true };
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

const oauthError = (res: ServerResponse, status: number, error: string, description = error): void =>
  send(res, status, { error, error_description: description });

const consoleError = (res: ServerResponse, status: number, message: string, detail = ""): void =>
  send(res, status, { error: detail, message, code: status });

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export async function startFakeCp(options: FakeCpOptions = {}): Promise<FakeCp> {
  const now = options.now ?? (() => Date.now());
  const workspaceId = options.workspaceId ?? randomUUID();
  const orgId = options.orgId ?? randomUUID();
  const accessTtl = (options.accessTtlSeconds ?? 900) * 1000;
  const refreshTtl = (options.refreshTtlSeconds ?? 30 * 24 * 3600) * 1000;
  const episodeTokenTtl = (options.episodeTokenTtlSeconds ?? 900) * 1000;
  const episodeDeadline = (options.episodeDeadlineSeconds ?? 3600) * 1000;
  const pollsBeforeApproval = options.pollsBeforeApproval ?? 1;

  const requests: FakeRequest[] = [];
  const observations: unknown[] = [];
  const episodes = new Map<string, EpisodeRecord>();
  const devices = new Map<string, { polls: number; expiresAt: number; consumed: boolean }>();
  const access = new Map<string, { expiresAt: number; revoked: boolean }>();
  const refresh = new Map<string, { used: boolean; expiresAt: number }>();
  const episodeTokens = new Map<string, { episodeId: string; expiresAt: number }>();
  const faults: { match: string; status: number; left: number; retryAfter?: number; error?: string }[] = [];
  let refreshes = 0;
  const byKey = new Map<string, string>();

  const issueMachineTokens = (): Record<string, unknown> => {
    const accessToken = secret("helm_at_");
    const refreshToken = secret("helm_rt_");
    const t = now();
    access.set(accessToken, { expiresAt: t + accessTtl, revoked: false });
    refresh.set(refreshToken, { used: false, expiresAt: t + refreshTtl });
    return {
      token_type: "Bearer",
      access_token: accessToken,
      expires_in: Math.round(accessTtl / 1000),
      refresh_token: refreshToken,
      refresh_expires_in: Math.round(refreshTtl / 1000),
      scope: "helm:workspace",
      credential_id: randomUUID(),
      subject: `did:helm:agent:${randomUUID()}`,
      workspace_id: workspaceId,
    };
  };

  const mintEpisodeToken = (episode: EpisodeRecord): { token: string; token_expires_at: string } => {
    const t = now();
    const expiresAt = Math.min(t + episodeTokenTtl, episode.deadlineMs);
    const token = fakeJwt({ sub: "agt:fake-seat", helm_episode: { episode_id: episode.episodeId, work_item_id: episode.workItemId }, exp: Math.floor(expiresAt / 1000), jti: randomUUID() });
    episodeTokens.set(token, { episodeId: episode.episodeId, expiresAt });
    return { token, token_expires_at: new Date(expiresAt).toISOString() };
  };

  const machineAuthorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const rec = access.get(token);
    return rec !== undefined && !rec.revoked && rec.expiresAt > now();
  };

  const episodeForToken = (authorization: string | undefined): EpisodeRecord | null => {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const rec = episodeTokens.get(token);
    if (!rec || rec.expiresAt <= now()) return null;
    const episode = episodes.get(rec.episodeId);
    return episode && !episode.stopped && episode.deadlineMs > now() ? episode : null;
  };

  const gateway = createFakeGateway({ branchPrefix: options.branchPrefix });
  const orgPrefix = `/api/v1/workspaces/${workspaceId}/organizations/${orgId}`;

  const handle = async (req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> => {
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0] ?? "/";

    const fault = faults.find((f) => f.left > 0 && `${method} ${path}`.includes(f.match));
    if (fault) {
      fault.left--;
      send(res, fault.status, { error: fault.error ?? "injected_fault", error_description: "injected fault" }, fault.retryAfter ? { "Retry-After": String(fault.retryAfter) } : {});
      return;
    }

    const extra = options.routes?.[`${method} ${path}`];
    if (extra) return void (await extra({ req, res, body, fake }));

    if (method === "GET" && path === "/healthz") return send(res, 200, { ok: true });

    // ---- device-code routes (no bearer) ----
    if (method === "POST" && path === "/api/v1/auth/device/code") {
      const b = isRecord(body) ? body : {};
      const name = typeof b.client_name === "string" ? b.client_name.trim() : "";
      if (name.length < 1 || name.length > 80) return oauthError(res, 400, "invalid_request", "client_name must be between 1 and 80 characters");
      if (!["cli", "desktop", "framework", "other"].includes(String(b.client_type))) return oauthError(res, 400, "invalid_request", "client_type must be cli, desktop, framework, or other");
      const deviceCode = secret("helm_dc_");
      devices.set(deviceCode, { polls: 0, expiresAt: now() + 600_000, consumed: false });
      const base = `http://${req.headers.host}`;
      return send(res, 201, {
        device_code: deviceCode,
        user_code: "ABCD-2345",
        verification_uri: `${base}/device`,
        verification_uri_complete: `${base}/device?user_code=ABCD-2345`,
        expires_in: 600,
        interval: 1,
      });
    }
    if (method === "POST" && path === "/api/v1/auth/device/token") {
      const b = isRecord(body) ? body : {};
      if (b.grant_type !== "urn:ietf:params:oauth:grant-type:device_code") return oauthError(res, 400, "unsupported_grant_type", "device_code grant_type required");
      const grant = devices.get(String(b.device_code));
      if (!grant || grant.consumed) return oauthError(res, 400, "invalid_grant", "the device authorization is invalid or already consumed");
      if (grant.expiresAt <= now()) return oauthError(res, 400, "expired_token", "the device authorization expired");
      grant.polls++;
      if (grant.polls <= pollsBeforeApproval) return oauthError(res, 400, "authorization_pending", "the user has not approved this device");
      grant.consumed = true;
      return send(res, 200, issueMachineTokens());
    }
    if (method === "POST" && path === "/api/v1/auth/device/refresh") {
      const b = isRecord(body) ? body : {};
      if (b.grant_type !== "refresh_token") return oauthError(res, 400, "unsupported_grant_type", "refresh_token grant_type required");
      const rec = refresh.get(String(b.refresh_token));
      if (!rec || rec.used || rec.expiresAt <= now()) return oauthError(res, 400, "invalid_grant", "refresh token is invalid, expired, rotated, or revoked");
      rec.used = true;
      refreshes++;
      return send(res, 200, issueMachineTokens());
    }

    // ---- MCP endpoint on the edge: an episode token is required ----
    if (method === "POST" && path === "/mcp") {
      const episode = episodeForToken(req.headers.authorization);
      if (!episode) return send(res, 401, { error: "invalid_token" });
      const reply = gateway.handle(isRecord(body) ? body : {}, episode);
      return send(res, reply.status, reply.body, reply.headers);
    }

    // ---- organization routes (machine bearer) ----
    if (path.startsWith(`${orgPrefix}/`)) {
      if (!machineAuthorized(req)) return consoleError(res, 401, "authentication required");
      const rest = path.slice(orgPrefix.length);

      if (method === "POST" && rest === "/observations") {
        const b = isRecord(body) ? body : {};
        if (b.schema !== "helm.executor.observation/v1" || b.coverage !== "observed-only" || typeof b.episode_id !== "string") {
          return consoleError(res, 400, "invalid observation", "invalid_observation");
        }
        const episode = episodes.get(b.episode_id);
        if (!episode) return consoleError(res, 404, "unknown episode", "episode_not_found");
        if (episode.stopped) return consoleError(res, 409, "the episode is stopped", "episode_stopped");
        observations.push(body);
        return send(res, 202, {});
      }

      const m = /^\/work-items\/([^/]+)\/executor-episodes(?:\/([^/]+)\/(token|stop))?$/.exec(rest);
      if (m && method === "POST") {
        const workItemId = decodeURIComponent(m[1] ?? "");
        const episodeId = m[2] ? decodeURIComponent(m[2]) : undefined;
        if (!episodeId) {
          const b = isRecord(body) ? body : {};
          if (!["claude-code", "codex", "openclaw"].includes(String(b.client)) || typeof b.idempotency_key !== "string") {
            return consoleError(res, 400, "invalid request", "invalid_request");
          }
          const known = byKey.get(b.idempotency_key);
          const existing = known ? episodes.get(known) : undefined;
          // One live episode per work item. A replay of the same request is not a second episode.
          if (!existing && [...episodes.values()].some((e) => e.workItemId === workItemId && !e.stopped && e.deadlineMs > now())) {
            return consoleError(res, 409, "the work item already has a live episode", "work_item_busy");
          }
          const episode: EpisodeRecord = existing ?? {
            episodeId: randomUUID(),
            workItemId,
            client: String(b.client),
            deadlineMs: now() + episodeDeadline,
            stopped: false,
            idempotencyKey: b.idempotency_key,
          };
          if (!existing) {
            episodes.set(episode.episodeId, episode);
            byKey.set(b.idempotency_key, episode.episodeId);
          }
          return send(res, 201, { episode_id: episode.episodeId, work_item_id: episode.workItemId, deadline: new Date(episode.deadlineMs).toISOString(), ...mintEpisodeToken(episode) });
        }
        const episode = episodes.get(episodeId);
        if (!episode || episode.workItemId !== workItemId) return consoleError(res, 404, "episode not found", "episode_not_found");
        if (m[3] === "stop") {
          // Release is idempotent: a second stop is acknowledged too.
          episode.stopped = true;
          return send(res, 204, undefined);
        }
        if (episode.stopped) return consoleError(res, 410, "the episode is stopped", "episode_stopped");
        if (episode.deadlineMs <= now()) return consoleError(res, 410, "the episode deadline has passed", "episode_expired");
        return send(res, 200, mintEpisodeToken(episode));
      }
    }
    return consoleError(res, 404, "not found");
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const body = await readBody(req);
        requests.push({ method: req.method ?? "GET", path: (req.url ?? "/").split("?")[0] ?? "/", headers: { ...req.headers }, body });
        await handle(req, res, body);
      } catch (err) {
        if (!res.headersSent) send(res, 500, { error: "fake_cp_error", error_description: err instanceof Error ? err.message : "error" });
        else res.end();
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const fake: FakeCp = {
    url: `http://127.0.0.1:${port}`,
    workspaceId,
    orgId,
    requests,
    episodes,
    observations,
    gateway,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    fail(match, status, times = 1, extra) {
      faults.push({ match, status, left: times, retryAfter: extra?.retryAfter, error: extra?.error });
    },
    revokeAccessTokens() {
      for (const rec of access.values()) rec.revoked = true;
    },
    episodeForToken,
    refreshCount: () => refreshes,
  };
  return fake;
}
