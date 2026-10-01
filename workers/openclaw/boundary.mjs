// Gateway endpoints are retained episode inputs. Imported framework configuration
// or model-generated values cannot supply another route or tool implementation.
import {createHash, randomUUID} from "node:crypto";

export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_MCP_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_MODEL_REQUEST_BYTES = 4 * 1024 * 1024;
export const MAX_EPISODE_BYTES = 8 * 1024 * 1024;
export const MAX_EVENT_BYTES = 512 * 1024;
export const MAX_TOOL_EVENT_BYTES = MAX_MCP_RESPONSE_BYTES + MAX_RESPONSE_BYTES;
export const TOOL_CHUNK_BYTES = 360 * 1024;
export const MAX_CONFIGURATION_BYTES = 2 * 1024 * 1024;

export async function readBoundedJSON(input, limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid input bound");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    if (!(chunk instanceof Uint8Array)) throw new Error("Private input must contain bytes");
    bytes += chunk.byteLength;
    if (bytes > limit) throw new Error("Private input exceeds its bound");
    chunks.push(Buffer.from(chunk));
  }
  // A Buffer-to-string conversion per read replaces split UTF-8 code points.
  // Decode exactly once after bounded accumulation; malformed bytes fail closed.
  const text = new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(chunks, bytes));
  return JSON.parse(text);
}

export function boundedEmitter(write) {
  let total = 0;
  return (event) => {
    const raw = Buffer.from(JSON.stringify(event), "utf8");
    let lines = [raw.toString("utf8") + "\n"];
    if (raw.length + 1 > MAX_EVENT_BYTES) {
      if (event.type !== "tool" || raw.length > MAX_TOOL_EVENT_BYTES) throw new Error("Episode output exceeds its bound");
      // This is private framing, not another work-report schema. Preserve the
      // exact JSON bytes and release an observation only after complete readback.
      const id = randomUUID(), count = Math.ceil(raw.length / TOOL_CHUNK_BYTES);
      const sha256 = createHash("sha256").update(raw).digest("hex");
      lines = [];
      for (let index = 0; index < count; index++) {
        lines.push(JSON.stringify({type: "tool_chunk", id, index, count, size: raw.length, sha256,
          data: raw.subarray(index * TOOL_CHUNK_BYTES, (index + 1) * TOOL_CHUNK_BYTES).toString("base64")}) + "\n");
      }
    }
    const size = lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
    if (lines.some((line) => Buffer.byteLength(line) > MAX_EVENT_BYTES)
        || total + size > MAX_EPISODE_BYTES) throw new Error("Episode output exceeds its bound");
    // Admit the complete frame set before writing any of it. A budget failure
    // cannot leave an apparently successful partial tool observation.
    total += size;
    for (const line of lines) write(line);
  };
}

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
export function gatewayFetch(config, originalFetch, signal) {
  const responses = config.base_url + "/v1/responses";
  const deadline = AbortSignal.timeout(Math.max(1, Math.min(Math.floor(config.deadline_ms - Date.now()), 3600000)));
  let bytes = 0;
  return async (input, options = {}) => {
    signal?.throwIfAborted();
    deadline.throwIfAborted();
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
    const signals = [signal, deadline, options.signal ?? request?.signal].filter(Boolean);
    const requestSignal = AbortSignal.any(signals);
    const response = await originalFetch(input, {...options, headers, redirect: "error", signal: requestSignal});
    if (!response.body) return response;
    const responseLimit = modelCall ? MAX_RESPONSE_BYTES : MAX_MCP_RESPONSE_BYTES;
    if (Number(response.headers.get("content-length")) > responseLimit) {
      void response.body.cancel().catch(() => {});
      throw new Error("Gateway response exceeds its bound");
    }
    let responseBytes = 0;
    const body = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        responseBytes += chunk.byteLength;
        bytes += chunk.byteLength;
        if (responseBytes > responseLimit || bytes > MAX_EPISODE_BYTES) {
          throw new Error("Gateway response exceeds its bound");
        }
        controller.enqueue(chunk);
      },
    }), {signal: requestSignal});
    return new Response(body, {status: response.status, statusText: response.statusText, headers: response.headers});
  };
}

export function normalizeResult(response) {
  if (!response || !Array.isArray(response.content)) throw new Error("Invalid MCP result");
  if (Buffer.byteLength(JSON.stringify(response)) > MAX_MCP_RESPONSE_BYTES) throw new Error("MCP result exceeds its bound");
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
  // The canonical gateway admits request context up to 4 MiB; response streams
  // remain 1 MiB. A retained near-limit tool result must fit the next turn.
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_MODEL_REQUEST_BYTES) throw new Error("Model request exceeds its bound");
  return payload;
}
