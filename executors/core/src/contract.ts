// The control plane wire contract the client builds. CONTRACT.md section 7 is the spec.
// The device-code routes are real (svc-helm-control-plane internal/deviceauth/service.go). The executor routes
// match codex:cp-org's OpenAPI (createOrganizationExecutorEpisode and its token and stop siblings, unmerged at
// cp-org commit 363f3e5). The observation route was agreed with cp-org and has no OpenAPI entry yet. When either
// moves, a change is a change to this file and to the fake control plane, nothing else.

import { ExecutorError } from "./errors.js";

export const DEVICE_CODE_PATH = "/api/v1/auth/device/code";
export const DEVICE_TOKEN_PATH = "/api/v1/auth/device/token";
export const DEVICE_REFRESH_PATH = "/api/v1/auth/device/refresh";
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const enc = encodeURIComponent;

export function orgBase(workspaceId: string, orgId: string): string {
  return `/api/v1/workspaces/${enc(workspaceId)}/organizations/${enc(orgId)}`;
}

export function episodesPath(workspaceId: string, orgId: string, workItemId: string): string {
  return `${orgBase(workspaceId, orgId)}/work-items/${enc(workItemId)}/executor-episodes`;
}

export function episodeTokenPath(workspaceId: string, orgId: string, workItemId: string, episodeId: string): string {
  return `${episodesPath(workspaceId, orgId, workItemId)}/${enc(episodeId)}/token`;
}

export function episodeStopPath(workspaceId: string, orgId: string, workItemId: string, episodeId: string): string {
  return `${episodesPath(workspaceId, orgId, workItemId)}/${enc(episodeId)}/stop`;
}

export function observationsPath(workspaceId: string, orgId: string): string {
  return `${orgBase(workspaceId, orgId)}/observations`;
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string | null;
  expires_in: number;
  interval: number;
}

export interface MachineToken {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  credential_id: string;
  subject: string;
  workspace_id: string;
}

export interface EpisodeGrant {
  episode_id: string;
  work_item_id: string;
  token: string;
  token_expires_at: string;
  deadline: string;
}

export interface EpisodeTokenGrant {
  token: string;
  token_expires_at: string;
}

function mismatch(what: string, field: string): never {
  throw new ExecutorError("internal", `${what} response is missing "${field}" (control plane contract mismatch)`);
}

function unusable(what: string, field: string): never {
  throw new ExecutorError("internal", `${what} response has an unusable "${field}" (control plane contract mismatch)`);
}

function record(json: unknown, what: string): Record<string, unknown> {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new ExecutorError("internal", `${what} response is not a JSON object (control plane contract mismatch)`);
  }
  return json as Record<string, unknown>;
}

function str(o: Record<string, unknown>, field: string, what: string): string {
  const v = o[field];
  return typeof v === "string" && v !== "" ? v : mismatch(what, field);
}

/** A bearer token: printable ASCII with no space, so it is one header value and one line of stdout. */
function secret(o: Record<string, unknown>, field: string, what: string): string {
  const v = str(o, field, what);
  return /^[\x21-\x7e]+$/.test(v) ? v : unusable(what, field);
}

function num(o: Record<string, unknown>, field: string, what: string): number {
  const v = o[field];
  return typeof v === "number" && Number.isFinite(v) ? v : mismatch(what, field);
}

function time(o: Record<string, unknown>, field: string, what: string): string {
  const v = str(o, field, what);
  return Number.isNaN(Date.parse(v)) ? mismatch(what, field) : v;
}

export function parseDeviceCode(json: unknown): DeviceCode {
  const o = record(json, "device code");
  const complete = o.verification_uri_complete;
  return {
    device_code: str(o, "device_code", "device code"),
    user_code: str(o, "user_code", "device code"),
    verification_uri: str(o, "verification_uri", "device code"),
    verification_uri_complete: typeof complete === "string" && complete !== "" ? complete : null,
    expires_in: num(o, "expires_in", "device code"),
    interval: num(o, "interval", "device code"),
  };
}

export function parseMachineToken(json: unknown): MachineToken {
  const o = record(json, "machine token");
  return {
    access_token: secret(o, "access_token", "machine token"),
    expires_in: num(o, "expires_in", "machine token"),
    refresh_token: secret(o, "refresh_token", "machine token"),
    refresh_expires_in: num(o, "refresh_expires_in", "machine token"),
    credential_id: str(o, "credential_id", "machine token"),
    subject: str(o, "subject", "machine token"),
    workspace_id: str(o, "workspace_id", "machine token"),
  };
}

export function parseEpisodeGrant(json: unknown): EpisodeGrant {
  const o = record(json, "executor episode");
  return {
    episode_id: str(o, "episode_id", "executor episode"),
    work_item_id: str(o, "work_item_id", "executor episode"),
    token: secret(o, "token", "executor episode"),
    token_expires_at: time(o, "token_expires_at", "executor episode"),
    deadline: time(o, "deadline", "executor episode"),
  };
}

/**
 * The mint answer: `token` plus `token_expires_at`, or `expires_in` seconds. The create answer's body also fits.
 * `token_expires_at` is on the control plane's clock; `skewMs` is how far that clock is ahead of this machine's, and
 * is added when the lifetime arrives as `expires_in` so the result is on the control plane's clock either way.
 */
export function parseEpisodeTokenGrant(json: unknown, nowMs: number, skewMs = 0): EpisodeTokenGrant {
  const o = record(json, "episode token");
  const token = secret(o, "token", "episode token");
  if (o.token_expires_at !== undefined) return { token, token_expires_at: time(o, "token_expires_at", "episode token") };
  return { token, token_expires_at: new Date(nowMs + skewMs + num(o, "expires_in", "episode token") * 1000).toISOString() };
}
