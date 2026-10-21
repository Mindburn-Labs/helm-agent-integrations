import type { AdapterLaunchSpec } from "./client.js";
import type { AcpMcpServer, CodingAgent } from "./types.js";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("HELM ACP: invalid session configuration");
  return value as Record<string, unknown>;
}

export function expectedSessionMode(agent: CodingAgent): string {
  if (agent === "codex") return "workspace-write";
  if (agent === "claude") return "default";
  throw new Error(`HELM ACP: reviewed-session capability is not verified for ${agent} (fail-closed)`);
}

export function checkedMcpServers(servers: AcpMcpServer[]): AcpMcpServer[] {
  if (!Array.isArray(servers)) throw new Error("HELM ACP: mcpServers must be an array");
  const names = new Set<string>();
  for (const server of servers) {
    if (!server || !/^[A-Za-z0-9_-]+$/.test(server.name) || names.has(server.name)) throw new Error("HELM ACP: invalid or duplicate MCP server name");
    names.add(server.name);
    if ("type" in server) {
      if (server.type !== "http" || !/^https?:$/.test(new URL(server.url).protocol) || !Array.isArray(server.headers)) throw new Error("HELM ACP: invalid MCP HTTP server");
    } else if (typeof server.command !== "string" || !server.command || !Array.isArray(server.args) || !server.args.every(a => typeof a === "string") || !Array.isArray(server.env)) {
      throw new Error("HELM ACP: invalid MCP stdio server");
    }
    const pairs = "type" in server ? server.headers : server.env;
    if (!pairs.every(p => p && typeof p.name === "string" && typeof p.value === "string")) throw new Error("HELM ACP: invalid MCP environment or headers");
  }
  return structuredClone(servers);
}

/** Overrides caller convenience settings before any vendor process can start. */
export function reviewedLaunch(agent: CodingAgent, spec: AdapterLaunchSpec, servers: AcpMcpServer[]): AdapterLaunchSpec {
  expectedSessionMode(agent);
  const env = { ...spec.env };
  if (agent === "codex") {
    const config = env.CODEX_CONFIG ? record(JSON.parse(env.CODEX_CONFIG)) : {};
    const inherited = config.mcp_servers === undefined ? {} : record(config.mcp_servers);
    const mcp: Record<string, unknown> = Object.fromEntries(Object.keys(inherited).map(name => [name, { enabled: false }]));
    for (const server of servers) {
      const entry = "type" in server
        ? { url: server.url, http_headers: Object.fromEntries(server.headers.map(p => [p.name, p.value])) }
        : { command: server.command, args: server.args, env: Object.fromEntries(server.env.map(p => [p.name, p.value])) };
      mcp[server.name] = { ...entry, enabled: true, default_tools_approval_mode: "prompt", tools: {} };
    }
    env.INITIAL_AGENT_MODE = "workspace-write";
    env.CODEX_CONFIG = JSON.stringify({ ...config, approval_policy: "on-request", approvals_reviewer: "user", sandbox_mode: "workspace-write", mcp_servers: mcp });
    delete env.DISABLE_MCP_CONFIG_FILTERING;
  }
  return { ...spec, args: [...spec.args], env };
}

export function sessionParams(agent: CodingAgent, cwd: string, servers: AcpMcpServer[]): Record<string, unknown> {
  // Codex ACP drops approval policy fields when translating ACP mcpServers.
  // Pass the complete server configuration through its documented CODEX_CONFIG.
  if (agent === "codex") return { cwd, mcpServers: [] };
  return {
    cwd, mcpServers: servers,
    _meta: { claudeCode: { options: {
      allowDangerouslySkipPermissions: false,
      settingSources: [],
      allowedTools: [],
      settings: { permissions: { defaultMode: "default", disableBypassPermissionsMode: "disable", allow: [], ask: ["mcp__*", ...servers.map(s => `mcp__${s.name}__*`)] } },
    } } },
  };
}

export function assertSessionModes(agent: CodingAgent, response: Record<string, unknown>, requireModes: boolean): void {
  const expected = expectedSessionMode(agent);
  if (requireModes) {
    const modes = record(response.modes);
    if (modes.currentModeId !== expected || !Array.isArray(modes.availableModes) || !modes.availableModes.some(m => record(m).id === expected)) {
      throw new Error(`HELM ACP: required reviewed session mode ${expected} is absent or inactive (fail-closed)`);
    }
  }
  if (!Array.isArray(response.configOptions)) throw new Error("HELM ACP: missing session configuration capabilities (fail-closed)");
  const mode = response.configOptions.find(o => record(o).id === "mode");
  if (!mode || record(mode).currentValue !== expected) throw new Error("HELM ACP: reviewed session mode changed or is unverifiable (fail-closed)");
}
