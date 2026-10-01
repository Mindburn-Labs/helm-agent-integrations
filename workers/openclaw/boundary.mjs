// Gateway endpoints are retained episode inputs. Imported framework configuration
// or model-generated values cannot supply another route or tool implementation.
export function validateConfiguration(config, now = Date.now()) {
  if (!config || config.api !== "openai-responses" || typeof config.token !== "string"
      || !config.token || typeof config.model !== "string" || !config.model
      || !Number.isInteger(config.max_output_tokens) || config.max_output_tokens < 1
      || !Number.isFinite(config.deadline_ms) || config.deadline_ms <= now
      || typeof config.system !== "string" || typeof config.user !== "string"
      || !Array.isArray(config.allowed) || config.allowed.length > 256
      || new Set(config.allowed).size !== config.allowed.length
      || config.allowed.some((name) => typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name))) {
    throw new Error("Invalid retained OpenClaw episode configuration");
  }
  const origin = new URL(config.base_url);
  const mcp = new URL(config.mcp_url);
  for (const url of [origin, mcp]) {
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Invalid gateway endpoint");
    }
  }
  if (origin.pathname !== "/" || mcp.pathname === "/") throw new Error("Invalid gateway endpoint path");
  return {...config, base_url: origin.origin, mcp_url: mcp.href};
}

// Both endpoints are explicitly supplied by the episode. The kit may serve
// model/MCP gateways on separate ports; CP validates the real native binding.
export function gatewayFetch(config, originalFetch) {
  const responses = config.base_url + "/v1/responses";
  return async (input, options = {}) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request ? request.url : String(input));
    const method = (options.method ?? request?.method ?? "GET").toUpperCase();
    const modelCall = url.href === responses && method === "POST";
    const mcpCall = url.href === config.mcp_url && ["GET", "POST", "DELETE"].includes(method);
    if ((!modelCall && !mcpCall) || url.username || url.password || url.hash) {
      throw new Error("Request escaped the retained HELM gateways");
    }
    const headers = new Headers(options.headers ?? request?.headers);
    if (headers.get("Authorization") !== `Bearer ${config.token}`) {
      throw new Error("Request lacks the retained episode credential");
    }
    return await originalFetch(input, {...options, headers, redirect: "error"});
  };
}

export function normalizeResult(response) {
  if (!response || !Array.isArray(response.content)) throw new Error("Invalid MCP result");
  const text = response.content.filter((part) => part?.type === "text")
    .map((part) => part.text).join("\n");
  return {isError: Boolean(response.isError), structured: response.structuredContent, text};
}

export async function discoverTools(client, allowed, signal) {
  const names = new Set(allowed);
  const found = new Map();
  const cursors = new Set();
  let cursor;
  for (let pageNumber = 0; pageNumber < 16; pageNumber++) {
    signal?.throwIfAborted();
    const page = await client.listTools(cursor ? {cursor} : {}, {signal, timeout: 60000});
    if (!Array.isArray(page.tools) || page.tools.length > 256) throw new Error("Unbounded MCP catalog");
    for (const tool of page.tools) {
      if (!names.has(tool.name)) continue;
      if (found.has(tool.name) || tool.inputSchema?.type !== "object"
          || JSON.stringify(tool).length > 128 * 1024) throw new Error("Invalid granted MCP tool");
      found.set(tool.name, tool);
    }
    if (!page.nextCursor) {
      if (found.size !== names.size) throw new Error("Granted MCP tool is unavailable");
      return [...found.values()];
    }
    if (cursors.has(page.nextCursor)) throw new Error("MCP catalog cursor repeated");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("MCP catalog exceeds the episode bound");
}

export function enforcePayload(config, tools, payload) {
  if (!payload || payload.model !== config.model || !Array.isArray(payload.tools ?? [])
      || (payload.tools ?? []).some((tool) => tool?.type !== "function" || !tools.has(tool.name))) {
    throw new Error("Model payload escaped the retained route or MCP tools");
  }
  payload.max_output_tokens = config.max_output_tokens;
  payload.parallel_tool_calls = false;
  payload.store = false;
  delete payload.previous_response_id;
  return payload;
}
