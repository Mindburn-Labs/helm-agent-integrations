// Renders the Claude Code adapter's configuration from templates/. Pure: no file writes, no environment reads.
// Every key in the templates was checked against code.claude.com/docs (settings reference, managed settings,
// hooks, MCP, LLM gateway) when this was written; README.md lists the checks and the Claude Code version floor.

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES = fileURLToPath(new URL("../templates/", import.meta.url));

/** `allowedProviders` is refused by older binaries, so the managed file also sets requiredMinimumVersion. */
export const MIN_CLAUDE_VERSION = "2.1.285";

/** Keys only a managed source honors. A --settings or user file ignores them, so the session profile drops them. */
export const MANAGED_ONLY_KEYS = ["requiredMinimumVersion", "allowedProviders", "allowManagedHooksOnly", "allowManagedMcpServersOnly", "allowedMcpServers"];

/** Deny patterns the managed file must carry. conformance and the tests check the rendered file against this. */
export const REQUIRED_DENY = ["Bash(git push *)", "Bash(gh pr merge *)", "Bash(kubectl *)", "Bash(flux *)", "WebSearch", "WebFetch"];

const ORG_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function shellQuote(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function template(name) {
  return JSON.parse(readFileSync(TEMPLATES + name, "utf8"));
}

function fill(node, values) {
  if (typeof node === "string") {
    return node.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
      if (!(key in values)) throw new Error(`template placeholder ${key} has no value`);
      return values[key];
    });
  }
  if (Array.isArray(node)) return node.map((n) => fill(n, values));
  if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fill(v, values)]));
  return node;
}

function origin(label, raw, allowLoopbackHttp) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (url.username || url.password) throw new Error(`${label} must not carry credentials`);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname.endsWith(".localhost");
  const secure = url.protocol === "https:" || (allowLoopbackHttp && url.protocol === "http:" && loopback);
  if (!secure) throw new Error(`${label} must use https${allowLoopbackHttp ? " (http only on loopback)" : ""}`);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

/** Validate the inputs and turn them into template values. */
export function valuesFor(opts, { allowLoopbackHttp = false } = {}) {
  if (typeof opts.helmExecutor !== "string" || !isAbsolute(opts.helmExecutor) || /[\0\n\r]/.test(opts.helmExecutor)) {
    throw new Error("the helm-executor path must be an absolute path");
  }
  if (!ORG_ID.test(opts.orgId ?? "")) throw new Error("the organization id must be 1 to 128 characters of letters, digits and . _ : -");
  const values = {
    EDGE_URL: origin("the edge URL", opts.edgeUrl ?? "", allowLoopbackHttp),
    CP_URL: origin("the control plane URL", opts.cpUrl ?? "", allowLoopbackHttp),
    ORG_ID: opts.orgId,
    HELM_EXECUTOR: opts.helmExecutor,
    HELM_EXECUTOR_SH: shellQuote(opts.helmExecutor),
  };
  if (opts.otelEndpoint) values.OTEL_ENDPOINT = origin("the OpenTelemetry endpoint", opts.otelEndpoint, allowLoopbackHttp);
  return values;
}

/** Throw when a rendered managed profile breaks an invariant the adapter depends on. */
export function assertProfile({ settings, mcp }, values) {
  const fail = (what) => {
    throw new Error(`rendered configuration is wrong: ${what}`);
  };
  if (JSON.stringify([settings, mcp]).includes("{{")) fail("a placeholder was left unfilled");
  if (settings.env?.ANTHROPIC_BASE_URL !== values.EDGE_URL) fail("ANTHROPIC_BASE_URL is not the edge URL");
  if (mcp.mcpServers?.helm?.url !== `${values.EDGE_URL}/mcp`) fail("the MCP server URL is not the edge /mcp");
  if (!settings.apiKeyHelper?.endsWith(" token")) fail("apiKeyHelper is not `helm-executor token`");
  if (!mcp.mcpServers.helm.headersHelper?.endsWith(" headers")) fail("headersHelper is not `helm-executor headers`");
  if (settings.env.ANTHROPIC_API_KEY !== "" || settings.env.ANTHROPIC_AUTH_TOKEN !== "") fail("ambient API key variables are not neutralized");
  for (const rule of REQUIRED_DENY) if (!settings.permissions?.deny?.includes(rule)) fail(`deny rule ${rule} is missing`);
  const hooks = Object.values(settings.hooks ?? {}).flatMap((groups) => groups.flatMap((g) => g.hooks));
  if (hooks.length === 0) fail("no hooks");
  for (const h of hooks) {
    if (h.type !== "command" || h.command !== values.HELM_EXECUTOR || h.args?.[0] !== "observe") fail("a hook is not `helm-executor observe`");
  }
}

/** The machine-wide profile: managed-settings drop-in, managed-mcp.json and, with an endpoint, the OTEL drop-in. */
export function renderManaged(opts) {
  const values = valuesFor(opts);
  const settings = fill(template("managed-settings.json"), values);
  const mcp = fill(template("managed-mcp.json"), values);
  assertProfile({ settings, mcp }, values);
  return { settings, mcp, otel: opts.otelEndpoint ? fill(template("managed-otel.json"), values) : null };
}

/** The per-session profile: the same content without the managed-only keys, for --settings and --mcp-config. */
export function renderSession(opts) {
  const values = valuesFor(opts, { allowLoopbackHttp: true });
  const full = fill(template("managed-settings.json"), values);
  const mcp = fill(template("managed-mcp.json"), values);
  assertProfile({ settings: full, mcp }, values);
  const settings = Object.fromEntries(Object.entries(full).filter(([key]) => !MANAGED_ONLY_KEYS.includes(key)));
  if (opts.otelEndpoint) settings.env = { ...settings.env, ...fill(template("managed-otel.json"), values).env };
  return { settings, mcp };
}

/** The telemetry env block for the owner's own sessions: observation only, nothing about providers or hooks. */
export function renderOwnerOtel(opts) {
  const endpoint = origin("the OpenTelemetry endpoint", opts.otelEndpoint ?? "", false);
  return fill(template("managed-otel.json"), { OTEL_ENDPOINT: endpoint }).env;
}
