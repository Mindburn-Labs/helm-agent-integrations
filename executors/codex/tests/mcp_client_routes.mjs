// QA transport only. Authentication and JSON-RPC behavior stay in the shared fake.
export function createClientMcpTransport() {
  const sessions = new Map();
  const diagnostics = { scope: "QA-only core fake route extensions", initialized: 0,
    unsupported_common_stream: 0, deleted: 0, active_sessions: 0, rejected: 0 };
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  function episode(ctx, requireSession) {
    if (ctx.req.headers.origin && ctx.req.headers.origin !== ctx.fake.url) {
      diagnostics.rejected++; send(ctx.res, 403, { error: "invalid_origin" }); return;
    }
    if (ctx.req.headers["mcp-protocol-version"] && ctx.req.headers["mcp-protocol-version"] !== "2025-06-18") {
      diagnostics.rejected++; send(ctx.res, 400, { error: "unsupported_protocol" }); return;
    }
    const active = ctx.fake.episodeForToken(ctx.req.headers.authorization);
    if (!active) { diagnostics.rejected++; send(ctx.res, 401, { error: "invalid_token" }); return; }
    if (requireSession && (typeof ctx.req.headers["mcp-session-id"] !== "string" || !ctx.req.headers["mcp-session-id"])) {
      diagnostics.rejected++; send(ctx.res, 400, { error: "missing_session" }); return;
    }
    if (requireSession && sessions.get(ctx.req.headers["mcp-session-id"]) !== active.episodeId) {
      diagnostics.rejected++; send(ctx.res, 404, { error: "unknown_session" }); return;
    }
    return active;
  }
  return { diagnostics, routes: {
    "POST /mcp": ctx => {
      const initialize = ctx.body?.method === "initialize";
      const active = episode(ctx, !initialize); if (!active) return;
      const reply = ctx.fake.gateway.handle(ctx.body ?? {}, active);
      if (initialize && reply.status === 200) {
        const session = Object.entries(reply.headers ?? {}).find(([key]) => key.toLowerCase() === "mcp-session-id")?.[1];
        if (typeof session !== "string" || !session) throw new Error("Shared fake initialize omitted its session ID");
        sessions.set(session, active.episodeId); diagnostics.initialized++; diagnostics.active_sessions = sessions.size;
      }
      send(ctx.res, reply.status, reply.body, reply.headers);
    },
    "GET /mcp": ctx => {
      if (!episode(ctx, true)) return;
      diagnostics.unsupported_common_stream++;
      send(ctx.res, 405, undefined, { Allow: "POST, DELETE" });
    },
    "DELETE /mcp": ctx => {
      if (!episode(ctx, true)) return;
      sessions.delete(ctx.req.headers["mcp-session-id"]); diagnostics.deleted++; diagnostics.active_sessions = sessions.size;
      send(ctx.res, 204);
    },
  } };
}
