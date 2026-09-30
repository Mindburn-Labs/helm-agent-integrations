"""A stand-in for the HELM MCP server (streamable HTTP, stateless).

It lists more tools than any episode allows, so the checks can see that adapters filter, and one
tool (github_pull_request_create_draft) always answers with the escalated result the contract
defines: a non-error `{status: "escalated", attempt_id}`.
"""

from __future__ import annotations

import json
import time
from typing import Any

from .http_util import Handler, Request
from .world import McpCall, World

SUPPORTED_PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26")


def _schema(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required or [],
        "additionalProperties": True,
    }


_STR = {"type": "string"}
TOOLS: dict[str, tuple[str, dict[str, Any]]] = {
    "github_repository_get": (
        "Read a GitHub repository. `delay_seconds` slows the answer (test hook).",
        _schema({"repo": _STR, "delay_seconds": {"type": "number"}}),
    ),
    "github_branch_create_from_changes": (
        "Create a branch from local changes.",
        _schema({"repo": _STR, "branch": _STR}, ["branch"]),
    ),
    "github_pull_request_create_draft": (
        "Open a draft pull request. Always needs human approval.",
        _schema({"repo": _STR, "title": _STR, "head": _STR, "base": _STR}, ["title"]),
    ),
    "helm_work_get": ("Read the current work item.", _schema({})),
    "helm_work_team": ("List the seats, capabilities and load of a team.", _schema({"team": _STR})),
    "helm_work_delegate": (
        "Delegate work to a seat, role or team.",
        _schema({"target": _STR, "goal": _STR, "context": _STR}, ["target", "goal"]),
    ),
    "helm_work_review": (
        "Accept or reject the result of a delegated work item.",
        _schema({"work": _STR, "decision": {"enum": ["accept", "reject"]}, "reason": _STR}),
    ),
    "helm_work_report": (
        "Report the outcome of the current work item. The episode is not complete without it.",
        _schema(
            {
                "status": {"enum": ["done", "blocked", "failed"]},
                "summary": _STR,
                "outputs": {
                    "type": "array",
                    "items": _schema({"kind": _STR, "ref": _STR}, ["kind", "ref"]),
                },
            },
            ["status", "summary"],
        ),
    ),
    "helm_work_request_input": (
        "Ask a human a question and wait for the answer.",
        _schema({"question": _STR, "options": {"type": "array", "items": _STR}}, ["question"]),
    ),
    "helm_org_request_capability": (
        "Ask the organization to add a capability.",
        _schema({"capability": _STR, "justification": _STR}, ["capability"]),
    ),
}


def _text_result(
    structured: dict[str, Any], world: World, is_error: bool = False
) -> dict[str, Any]:
    text = json.dumps(structured, separators=(",", ":"))
    result: dict[str, Any] = {"content": [{"type": "text", "text": text}], "isError": is_error}
    if world.mcp_structured and not is_error:
        result["structuredContent"] = structured
    return result


def _call_tool(world: World, req: Request, call: McpCall) -> dict[str, Any]:
    name, args = call.tool, call.arguments
    if name == "github_repository_get":
        delay = args.get("delay_seconds")
        if isinstance(delay, (int, float)) and delay > 0:
            if not world.sleep(float(delay), req.client_gone):
                call.aborted = not world.stop.is_set()
                return _text_result({"status": "failed", "reason": "interrupted"}, world)
        return _text_result(
            {"status": "succeeded", "result": {"full_name": args.get("repo", "acme/sandbox")}},
            world,
        )
    if name == "github_pull_request_create_draft":
        attempt = f"att-{world.next_id('attempt')}"
        return _text_result({"status": "escalated", "attempt_id": attempt}, world)
    if name == "helm_work_delegate":
        return _text_result(
            {"status": "succeeded", "work_id": f"child-{world.next_id('child')}"}, world
        )
    return _text_result({"status": "succeeded"}, world)


def make_handler(world: World) -> Handler:
    def handle(req: Request) -> None:
        if req.bearer() != world.token:
            world.violation(f"mcp {req.method} {req.path}: missing or wrong bearer token")
            req.respond_json(401, {"error": "unauthorized"}, WWW_Authenticate="Bearer")
            return
        if req.path != "/mcp":
            req.respond_json(404, {"error": "not found"})
            return
        if req.method != "POST":
            # Stateless server: no server-initiated stream, no session to terminate.
            req.respond(405, b"", Allow="POST")
            return
        try:
            message = req.json()
        except ValueError:
            req.respond_json(
                400,
                {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}},
            )
            return
        batch = message if isinstance(message, list) else [message]
        replies = [r for r in (_dispatch(world, req, m) for m in batch) if r is not None]
        if not replies:
            req.respond(202)
        else:
            req.respond_json(200, replies if isinstance(message, list) else replies[0])

    return handle


def _dispatch(world: World, req: Request, message: dict[str, Any]) -> dict[str, Any] | None:
    method = message.get("method", "")
    ident = message.get("id")
    with world.lock:
        world.mcp_methods.append((time.monotonic(), method))
    if ident is None:  # a notification
        return None

    def ok(result: Any) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": ident, "result": result}

    def fail(code: int, text: str) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": ident, "error": {"code": code, "message": text}}

    params = message.get("params") or {}
    if method == "initialize":
        asked = params.get("protocolVersion")
        version = asked if asked in SUPPORTED_PROTOCOL_VERSIONS else SUPPORTED_PROTOCOL_VERSIONS[0]
        return ok(
            {
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "helm-conformance-mcp-stub", "version": "0.1.0"},
            }
        )
    if method == "ping":
        return ok({})
    if method == "tools/list":
        return ok(
            {
                "tools": [
                    {"name": name, "description": description, "inputSchema": schema}
                    for name, (description, schema) in TOOLS.items()
                ]
            }
        )
    if method == "tools/call":
        name = params.get("name")
        if name not in TOOLS:
            return fail(-32602, f"Unknown tool: {name}")
        arguments = params.get("arguments")
        call = McpCall(
            t_start=time.monotonic(),
            tool=str(name),
            arguments=arguments if isinstance(arguments, dict) else {},
        )
        world.record_mcp(call)
        call.result = _call_tool(world, req, call)
        call.t_end = time.monotonic()
        return ok(call.result)
    return fail(-32601, f"Method not found: {method}")
