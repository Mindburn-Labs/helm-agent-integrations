"""Scripted model endpoints in the three API dialects the HELM gateway serves.

The script is a list of steps; the step answered is chosen by how many assistant turns the
conversation the worker sent already contains, so retries and auxiliary calls cannot desync it.

    {"text": "..."}                                   final assistant text
    {"tools": [{"name": ..., "arguments": {...}}]}   one or more tool calls (optional "text")
    {"sleep": 60, "then": {...}}                     hold the connection first
    {"http_error": 400, "message": "..."}            a provider error in the dialect's shape
"""

from __future__ import annotations

import json
import time
from typing import Any

from .http_util import Handler, Request
from .world import ModelCall, World

DIALECTS = {
    "/v1/messages": "anthropic",
    "/v1/responses": "responses",
    "/v1/chat/completions": "chat",
}
DEFAULT_STEP: dict[str, Any] = {"text": "Done."}


def assistant_turns(dialect: str, body: dict[str, Any]) -> int:
    """How many assistant turns the request's conversation already holds."""
    if dialect in ("anthropic", "chat"):
        messages = body.get("messages") or []
        return sum(1 for m in messages if isinstance(m, dict) and m.get("role") == "assistant")
    items = body.get("input")
    if not isinstance(items, list):
        return 0
    turns, in_turn = 0, False
    for item in items:
        assistant = isinstance(item, dict) and (
            item.get("type") in ("function_call", "reasoning") or (item.get("role") == "assistant")
        )
        if assistant and not in_turn:
            turns += 1
        in_turn = assistant
    return turns


def offered_tools(dialect: str, body: dict[str, Any]) -> list[dict[str, Any]]:
    tools: list[dict[str, Any]] = []
    for tool in body.get("tools") or []:
        if not isinstance(tool, dict):
            continue
        if dialect == "chat":
            function = tool.get("function") or {}
            tools.append({"name": function.get("name"), "type": tool.get("type", "function")})
        elif dialect == "responses":
            tools.append({"name": tool.get("name"), "type": tool.get("type", "function")})
        else:
            tools.append({"name": tool.get("name"), "type": tool.get("type", "custom")})
    return tools


def max_tokens(dialect: str, body: dict[str, Any]) -> int | None:
    keys = {
        "anthropic": ("max_tokens",),
        "chat": ("max_completion_tokens", "max_tokens"),
        "responses": ("max_output_tokens",),
    }[dialect]
    for key in keys:
        if isinstance(body.get(key), int):
            return int(body[key])
    return None


def _offered_name(script_name: str, offered: list[str]) -> str:
    """The offered tool a model would pick for `script_name` (Claude prefixes MCP tools)."""
    for name in offered:
        if name == script_name or name.endswith(f"__{script_name}"):
            return name
    return script_name  # not offered: a hallucinated call, sent as written


def _calls(
    world: World, step: dict[str, Any], prefix: str, offered: list[str]
) -> list[tuple[str, str, str]]:
    return [
        (
            f"{prefix}_{world.next_id(prefix)}",
            _offered_name(t["name"], offered),
            json.dumps(t.get("arguments") or {}),
        )
        for t in step.get("tools") or []
    ]


def _usage(body_len: int) -> tuple[int, int]:
    return max(1, body_len // 4), 12


# ----- Anthropic Messages -----------------------------------------------------------------


def _anthropic(
    req: Request,
    world: World,
    model: str,
    stream: bool,
    step: dict[str, Any],
    size: int,
    offered: list[str],
) -> None:
    calls = _calls(world, step, "toolu", offered)
    text = step.get("text")
    message_id = f"msg_{world.next_id('msg')}"
    tokens_in, tokens_out = _usage(size)
    stop = "tool_use" if calls else "end_turn"
    blocks: list[dict[str, Any]] = []
    if text:
        blocks.append({"type": "text", "text": text})
    blocks += [
        {"type": "tool_use", "id": i, "name": n, "input": json.loads(a)} for i, n, a in calls
    ]
    if not stream:
        req.respond_json(
            200,
            {
                "id": message_id,
                "type": "message",
                "role": "assistant",
                "model": model,
                "content": blocks,
                "stop_reason": stop,
                "stop_sequence": None,
                "usage": {"input_tokens": tokens_in, "output_tokens": tokens_out},
            },
        )
        return
    req.start_sse()

    def emit(kind: str, **fields: Any) -> bool:
        return req.sse({"type": kind, **fields}, event=kind)

    emit(
        "message_start",
        message={
            "id": message_id,
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [],
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {"input_tokens": tokens_in, "output_tokens": 1},
        },
    )
    emit("ping")
    for index, block in enumerate(blocks):
        if block["type"] == "text":
            emit("content_block_start", index=index, content_block={"type": "text", "text": ""})
            emit(
                "content_block_delta",
                index=index,
                delta={"type": "text_delta", "text": block["text"]},
            )
        else:
            emit(
                "content_block_start",
                index=index,
                content_block={
                    "type": "tool_use",
                    "id": block["id"],
                    "name": block["name"],
                    "input": {},
                },
            )
            emit(
                "content_block_delta",
                index=index,
                delta={"type": "input_json_delta", "partial_json": json.dumps(block["input"])},
            )
        emit("content_block_stop", index=index)
    emit(
        "message_delta",
        delta={"stop_reason": stop, "stop_sequence": None},
        usage={"output_tokens": tokens_out},
    )
    emit("message_stop")


# ----- OpenAI Chat Completions --------------------------------------------------------------


def _chat(
    req: Request,
    world: World,
    model: str,
    stream: bool,
    step: dict[str, Any],
    size: int,
    offered: list[str],
) -> None:
    calls = _calls(world, step, "call", offered)
    text = step.get("text")
    completion_id = f"chatcmpl-{world.next_id('chatcmpl')}"
    created = int(time.time())
    tokens_in, tokens_out = _usage(size)
    finish = "tool_calls" if calls else "stop"
    tool_calls = [
        {"id": i, "type": "function", "function": {"name": n, "arguments": a}} for i, n, a in calls
    ]
    if not stream:
        message: dict[str, Any] = {"role": "assistant", "content": text or None}
        if tool_calls:
            message["tool_calls"] = tool_calls
        req.respond_json(
            200,
            {
                "id": completion_id,
                "object": "chat.completion",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                "usage": {
                    "prompt_tokens": tokens_in,
                    "completion_tokens": tokens_out,
                    "total_tokens": tokens_in + tokens_out,
                },
            },
        )
        return
    req.start_sse()

    def chunk(delta: dict[str, Any], finish_reason: str | None = None) -> bool:
        return req.sse(
            {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
            }
        )

    chunk({"role": "assistant", "content": ""})
    if text:
        chunk({"content": text})
    for index, (ident, name, arguments) in enumerate(calls):
        chunk(
            {
                "tool_calls": [
                    {
                        "index": index,
                        "id": ident,
                        "type": "function",
                        "function": {"name": name, "arguments": ""},
                    }
                ]
            }
        )
        chunk({"tool_calls": [{"index": index, "function": {"arguments": arguments}}]})
    chunk({}, finish)
    req.sse(
        {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [],
            "usage": {
                "prompt_tokens": tokens_in,
                "completion_tokens": tokens_out,
                "total_tokens": tokens_in + tokens_out,
            },
        }
    )
    req.sse("[DONE]")


# ----- OpenAI Responses ---------------------------------------------------------------------


def _response_object(
    response_id: str,
    model: str,
    status: str,
    output: list[dict[str, Any]],
    usage: dict[str, Any] | None,
) -> dict[str, Any]:
    return {
        "id": response_id,
        "object": "response",
        "created_at": int(time.time()),
        "status": status,
        "model": model,
        "output": output,
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
        "temperature": 1.0,
        "top_p": 1.0,
        "instructions": None,
        "metadata": {},
        "error": None,
        "incomplete_details": None,
        "text": {"format": {"type": "text"}},
        "truncation": "disabled",
        "store": False,
        "background": False,
        "max_output_tokens": None,
        "previous_response_id": None,
        "reasoning": {"effort": None, "summary": None},
        "usage": usage,
    }


def _responses(
    req: Request,
    world: World,
    model: str,
    stream: bool,
    step: dict[str, Any],
    size: int,
    offered: list[str],
) -> None:
    calls = _calls(world, step, "call", offered)
    text = step.get("text")
    response_id = f"resp_{world.next_id('resp')}"
    tokens_in, tokens_out = _usage(size)
    usage = {
        "input_tokens": tokens_in,
        "output_tokens": tokens_out,
        "total_tokens": tokens_in + tokens_out,
        "input_tokens_details": {"cached_tokens": 0},
        "output_tokens_details": {"reasoning_tokens": 0},
    }
    items: list[dict[str, Any]] = []
    if text:
        items.append(
            {
                "type": "message",
                "id": f"msg_{world.next_id('rmsg')}",
                "status": "completed",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text, "annotations": []}],
            }
        )
    for ident, name, arguments in calls:
        items.append(
            {
                "type": "function_call",
                "id": f"fc_{ident}",
                "call_id": ident,
                "name": name,
                "arguments": arguments,
                "status": "completed",
            }
        )
    if not stream:
        req.respond_json(200, _response_object(response_id, model, "completed", items, usage))
        return
    req.start_sse()
    sequence = [0]

    def emit(kind: str, **fields: Any) -> bool:
        payload = {"type": kind, "sequence_number": sequence[0], **fields}
        sequence[0] += 1
        return req.sse(payload, event=kind)

    emit("response.created", response=_response_object(response_id, model, "in_progress", [], None))
    emit(
        "response.in_progress",
        response=_response_object(response_id, model, "in_progress", [], None),
    )
    for index, item in enumerate(items):
        if item["type"] == "message":
            part = item["content"][0]
            emit(
                "response.output_item.added",
                output_index=index,
                item={**item, "status": "in_progress", "content": []},
            )
            emit(
                "response.content_part.added",
                item_id=item["id"],
                output_index=index,
                content_index=0,
                part={**part, "text": ""},
            )
            emit(
                "response.output_text.delta",
                item_id=item["id"],
                output_index=index,
                content_index=0,
                delta=part["text"],
                logprobs=[],
            )
            emit(
                "response.output_text.done",
                item_id=item["id"],
                output_index=index,
                content_index=0,
                text=part["text"],
                logprobs=[],
            )
            emit(
                "response.content_part.done",
                item_id=item["id"],
                output_index=index,
                content_index=0,
                part=part,
            )
        else:
            emit(
                "response.output_item.added",
                output_index=index,
                item={**item, "arguments": "", "status": "in_progress"},
            )
            emit(
                "response.function_call_arguments.delta",
                item_id=item["id"],
                output_index=index,
                delta=item["arguments"],
            )
            emit(
                "response.function_call_arguments.done",
                item_id=item["id"],
                output_index=index,
                name=item["name"],
                arguments=item["arguments"],
            )
        emit("response.output_item.done", output_index=index, item=item)
    emit(
        "response.completed",
        response=_response_object(response_id, model, "completed", items, usage),
    )


# ----- errors and dispatch ------------------------------------------------------------------


def _error(req: Request, dialect: str, status: int, message: str) -> None:
    if dialect == "anthropic":
        req.respond_json(
            status,
            {"type": "error", "error": {"type": "invalid_request_error", "message": message}},
        )
    else:
        req.respond_json(
            status,
            {
                "error": {
                    "message": message,
                    "type": "invalid_request_error",
                    "param": None,
                    "code": None,
                }
            },
        )


_ANSWER = {"anthropic": _anthropic, "chat": _chat, "responses": _responses}


def make_handler(world: World) -> Handler:
    def handle(req: Request) -> None:
        dialect = DIALECTS.get(req.path)
        if dialect is None or req.method != "POST":
            # count_tokens, model discovery and the connection-warming probe are optional.
            world.record_model(
                ModelCall(t=time.monotonic(), path=f"{req.method} {req.path}", dialect="other")
            )
            req.respond_json(
                404, {"type": "error", "error": {"type": "not_found_error", "message": "not found"}}
            )
            return
        if req.bearer() != world.token:
            world.violation(f"model {req.path}: missing or wrong bearer token")
            _error(req, dialect, 401, "invalid bearer token")
            return
        try:
            body = req.json()
        except ValueError:
            _error(req, dialect, 400, "request body is not JSON")
            return
        if not isinstance(body, dict):
            _error(req, dialect, 400, "request body is not an object")
            return
        tools = offered_tools(dialect, body)
        call = ModelCall(
            t=time.monotonic(),
            path=req.path,
            dialect=dialect,
            model=body.get("model"),
            tools=tools,
            max_tokens=max_tokens(dialect, body),
            stream=bool(body.get("stream")),
            turn=assistant_turns(dialect, body),
            has_mcp_servers=bool(body.get("mcp_servers")) or any(t["type"] == "mcp" for t in tools),
            text=req.body.decode("utf-8", "replace") if not world.model_calls else "",
        )
        world.record_model(call)
        step = world.script[call.turn] if call.turn < len(world.script) else DEFAULT_STEP
        if "sleep" in step:
            call.step = "sleep"
            if not world.sleep(float(step["sleep"]), req.client_gone):
                call.aborted = not world.stop.is_set()
                call.t_end = time.monotonic()
                return
            step = step.get("then", DEFAULT_STEP)
        if "http_error" in step:
            call.step = "error"
            _error(
                req, dialect, int(step["http_error"]), str(step.get("message", "scripted error"))
            )
        else:
            call.step = "tools" if step.get("tools") else "text"
            offered = [t["name"] for t in tools if t.get("name")]
            _ANSWER[dialect](
                req, world, str(call.model or ""), call.stream, step, len(req.body), offered
            )
        call.t_end = time.monotonic()

    return handle
