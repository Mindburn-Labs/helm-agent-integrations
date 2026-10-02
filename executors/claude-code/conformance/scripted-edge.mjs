// A scripted stand-in for the executor edge's Anthropic Messages endpoint, for conformance runs against the fake
// control plane. It checks the episode token the way the real edge does (the token arrives in both x-api-key and
// Authorization: Bearer, because that is what Claude Code sends for an apiKeyHelper) and plays a fixed
// conversation: the model asks for one denied command and one allowed command, then answers.

const SCRIPT_TOOLS = [
  { id: "toolu_conformance_denied", command: "git push origin conformance-probe" },
  { id: "toolu_conformance_allowed", command: "echo conformance-ok" },
];

const sse = (res, events) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.end();
};

function messageEvents(model, blocks, stopReason) {
  const events = [["message_start", { message: { id: "msg_conformance", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }]];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push(["content_block_start", { index, content_block: { type: "text", text: "" } }]);
      events.push(["content_block_delta", { index, delta: { type: "text_delta", text: block.text } }]);
    } else {
      events.push(["content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: "Bash", input: {} } }]);
      events.push(["content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: block.command }) } }]);
    }
    events.push(["content_block_stop", { index }]);
  });
  events.push(["message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } }]);
  events.push(["message_stop", {}]);
  return events;
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const header = (req, name) => String(req.headers[name] ?? "");

/** The tool_result blocks the client sent since the model's last turn. Claude Code may append a system message after them. */
export function toolResultsSinceLastAssistant(messages) {
  const found = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") break;
    if (m?.role === "user" && Array.isArray(m.content)) found.push(...m.content.filter((b) => b?.type === "tool_result"));
  }
  return found;
}

/** Returns { route, seen } where `route` is a fake-cp route handler and `seen` collects what the edge received. */
export function scriptedMessages() {
  const seen = { messages: [], rejected: 0, log: [] };
  const route = ({ req, res, body, fake }) => {
    const bearer = header(req, "authorization").replace(/^Bearer /, "");
    const key = header(req, "x-api-key");
    const authorized = bearer !== "" && bearer === key && fake.episodeForToken(`Bearer ${bearer}`) !== null;
    if (!authorized) {
      seen.rejected++;
      seen.log.push({ rejected: true, key: key === "" ? "none" : key.slice(0, 8), bearer: bearer === "" ? "none" : bearer.slice(0, 8), same: bearer === key });
      return json(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid episode token" } });
    }
    const request = body && typeof body === "object" ? body : {};
    seen.messages.push({ token: bearer, key, request });
    const model = typeof request.model === "string" ? request.model : "claude-conformance";
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const tools = Array.isArray(request.tools) ? request.tools.map((t) => t?.name) : [];
    const last = messages.at(-1);
    const answeringToolResults = toolResultsSinceLastAssistant(messages).length > 0;
    const priorMain = seen.messages.filter((m) => Array.isArray(m.request.tools) && m.request.tools.some((t) => t?.name === "Bash")).length;

    let blocks;
    let stop = "end_turn";
    if (tools.includes("Bash") && !answeringToolResults && priorMain === 1) {
      blocks = [{ type: "text", text: "Running two commands." }, ...SCRIPT_TOOLS.map((t) => ({ type: "tool_use", id: t.id, command: t.command }))];
      stop = "tool_use";
    } else {
      blocks = [{ type: "text", text: answeringToolResults ? "conformance done" : "connected" }];
    }
    seen.log.push({ model, stream: request.stream === true, tools: tools.length, hasBash: tools.includes("Bash"), lastRole: last?.role, lastTypes: Array.isArray(last?.content) ? last.content.map((b) => b?.type) : typeof last?.content, answeringToolResults, priorMain, reply: stop });
    if (request.stream === true) return sse(res, messageEvents(model, blocks, stop));
    return json(res, 200, {
      id: "msg_conformance",
      type: "message",
      role: "assistant",
      model,
      content: blocks.map((b) => (b.type === "text" ? b : { type: "tool_use", id: b.id, name: "Bash", input: { command: b.command } })),
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    });
  };
  return { route, seen, SCRIPT_TOOLS };
}
