"""The run context, check results and the assertions scenarios share."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from helm_worker_contract import (
    EXTENSION_URI,
    STATUS_MEDIA_TYPE,
    find_status_payload,
    schema_issues,
)

from .a2a import (
    ALL_STATES,
    INTERRUPTED_STATES,
    TERMINAL_STATES,
    A2AClient,
    Event,
    Stream,
)
from .sinkhole import Sinkhole
from .world import World

_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$")
_MCP_PREFIX = re.compile(r"^mcp__[A-Za-z0-9-]+__(.+)$")
# Tool types that mean a provider or the framework would run something itself.
_HOSTED = re.compile(
    r"web_search|web_fetch|file_search|code_(execution|interpreter)|computer|bash|text_editor|shell|apply_patch|mcp|image_generation",
    re.I,
)

PASS, FAIL, SKIP = "pass", "fail", "skip"


@dataclass
class CheckResult:
    name: str
    status: str
    detail: str = ""


@dataclass
class Run:
    scenario_id: str
    api: str
    episode: dict[str, Any]
    world: World
    client: A2AClient
    token: str
    ingress_token: str
    sinkhole: Sinkhole | None = None
    stream: Stream | None = None
    marks: dict[str, float] = field(default_factory=dict)
    results: list[CheckResult] = field(default_factory=list)

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self.results.append(CheckResult(name, PASS if ok else FAIL, "" if ok else detail))
        return ok

    def skip(self, name: str, why: str) -> None:
        self.results.append(CheckResult(name, SKIP, why))

    def fail_all(self, why: str, names: list[str]) -> None:
        for name in names:
            self.check(name, False, why)


def tool_name(name: str | None) -> str:
    """A tool name as the MCP server lists it (Claude prefixes MCP tools with mcp__<server>__)."""
    match = _MCP_PREFIX.match(name or "")
    return match.group(1) if match else (name or "")


# ----- wire format ---------------------------------------------------------------------------


def _part_problems(where: str, part: Any) -> list[str]:
    if not isinstance(part, dict):
        return [f"{where}: part is not an object"]
    content = [m for m in ("text", "raw", "url", "data") if m in part]
    problems = []
    if len(content) != 1:
        problems.append(f"{where}: part must carry exactly one of text/raw/url/data, has {content}")
    if "kind" in part:
        problems.append(f"{where}: part has a v0.3 `kind` member")
    return problems


def _message_problems(where: str, message: Any) -> list[str]:
    if not isinstance(message, dict):
        return [f"{where}: message is not an object"]
    problems = []
    if message.get("role") != "ROLE_AGENT":
        problems.append(f"{where}: message role is {message.get('role')!r}, not ROLE_AGENT")
    if not message.get("messageId"):
        problems.append(f"{where}: message has no messageId")
    parts = message.get("parts")
    if not isinstance(parts, list) or not parts:
        problems.append(f"{where}: message has no parts")
    else:
        for index, part in enumerate(parts):
            problems += _part_problems(f"{where}.parts[{index}]", part)
    return problems


def event_problems(index: int, event: Event) -> list[str]:
    where = f"event {index} ({event.kind})"
    problems: list[str] = []
    if event.raw.get("jsonrpc") != "2.0" or "id" not in event.raw:
        problems.append(f"{where}: not a JSON-RPC 2.0 response envelope")
    if event.kind == "unknown":
        return problems + [
            f"{where}: result has none or several of task/message/statusUpdate/artifactUpdate"
        ]
    body = event.body
    if "kind" in body:
        problems.append(f"{where}: has a v0.3 `kind` member")
    if event.kind == "task":
        if not isinstance(body.get("id"), str) or not body.get("id"):
            problems.append(f"{where}: task has no id")
    else:
        for key in ("taskId", "contextId"):
            if not isinstance(body.get(key), str) or not body.get(key):
                problems.append(f"{where}: missing {key}")
    if event.kind in ("task", "statusUpdate"):
        status = body.get("status")
        if not isinstance(status, dict) or status.get("state") not in ALL_STATES:
            problems.append(f"{where}: status.state is not a TASK_STATE_* value")
        else:
            stamp = status.get("timestamp")
            if stamp is not None and not (isinstance(stamp, str) and _TIMESTAMP.match(stamp)):
                problems.append(f"{where}: timestamp {stamp!r} is not UTC ISO 8601 with a Z suffix")
            if "message" in status:
                problems += _message_problems(f"{where}.status.message", status["message"])
        if event.kind == "statusUpdate" and "final" in body:
            problems.append(f"{where}: has the removed `final` member")
    if event.kind == "artifactUpdate":
        artifact = body.get("artifact")
        if not isinstance(artifact, dict) or not artifact.get("artifactId"):
            problems.append(f"{where}: artifact has no artifactId")
        elif not isinstance(artifact.get("parts"), list) or not artifact["parts"]:
            problems.append(f"{where}: artifact has no parts")
        else:
            for i, part in enumerate(artifact["parts"]):
                problems += _part_problems(f"{where}.artifact.parts[{i}]", part)
    return problems


def stream_problems(run: Run, stream: Stream, final: set[str]) -> list[str]:
    """Everything wrong with a SendStreamingMessage stream (empty when it is sound)."""
    problems: list[str] = []
    if stream.error:
        problems.append(f"transport error: {stream.error}")
    if stream.rpc_error:
        problems.append(f"JSON-RPC error instead of a stream: {stream.rpc_error}")
    if stream.http_status != 200 or "text/event-stream" not in stream.content_type:
        problems.append(
            f"HTTP {stream.http_status} {stream.content_type!r}, want 200 text/event-stream"
        )
    events = stream.snapshot()
    if not events:
        return problems + ["the stream carried no events"]
    for index, event in enumerate(events):
        problems += event_problems(index, event)
    first = events[0]
    if first.kind != "task" or first.state != "TASK_STATE_SUBMITTED":
        problems.append(
            f"the first event must be the task in TASK_STATE_SUBMITTED, got {first.kind} {first.state}"
        )
    task_id = stream.task_id()
    for index, event in enumerate(events):
        found = event.body.get("id") if event.kind == "task" else event.body.get("taskId")
        if found != task_id:
            problems.append(f"event {index}: task id {found!r} differs from {task_id!r}")
        context = event.body.get("contextId")
        if context is not None and context != run.episode["work_item_id"]:
            problems.append(f"event {index}: contextId {context!r} is not the work item id")
    states = stream.states()
    for earlier, later in zip(states, states[1:]):
        if earlier in TERMINAL_STATES or earlier in INTERRUPTED_STATES:
            problems.append(f"state {later} follows {earlier}")
    if states and states[-1] not in final:
        problems.append(f"the stream ended in {states[-1]}, want one of {sorted(final)}")
    if "TASK_STATE_WORKING" not in states and states and states[-1] not in ("TASK_STATE_REJECTED",):
        problems.append("no TASK_STATE_WORKING progress update")
    if not stream.wait_closed(5.0):
        problems.append("the stream stayed open after the last state (it must close)")
    elif stream.t_closed is not None:
        final_events = [e for e in events if e.state in TERMINAL_STATES | INTERRUPTED_STATES]
        if final_events and stream.t_closed - final_events[0].t > 5.0:
            problems.append("the stream closed more than 5s after its final state")
    return problems


def artifact_events(stream: Stream, name: str) -> list[Event]:
    return [
        e
        for e in stream.snapshot()
        if e.kind == "artifactUpdate" and e.body.get("artifact", {}).get("name") == name
    ]


def artifact_data(event: Event) -> Any:
    for part in event.body["artifact"]["parts"]:
        if "data" in part:
            return part["data"]
    return None


def final_status(stream: Stream) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """(the status data part, the event metadata) of the last status update."""
    event = stream.last_status_event()
    if event is None:
        return None, {}
    message = event.body.get("status", {}).get("message") or {}
    payload = find_status_payload(message.get("parts") or [])
    metadata = event.body.get("metadata") or {}
    return (payload if isinstance(payload, dict) else None), (
        metadata if isinstance(metadata, dict) else {}
    )


def status_problems(stream: Stream) -> list[str]:
    """Check the machine-readable detail of the final status: valid, and mirrored in metadata."""
    payload, metadata = final_status(stream)
    if payload is None:
        return [f"the final status message has no {STATUS_MEDIA_TYPE} data part"]
    problems = [f"status payload: {issue}" for issue in schema_issues("status.v1", payload)]
    mirror = {k: v for k, v in payload.items() if k != "schema"}
    if {k: metadata.get(k) for k in mirror} != mirror:
        problems.append(
            f"event metadata {metadata!r} does not mirror the status payload {mirror!r}"
        )
    return problems


# ----- traffic assertions --------------------------------------------------------------------


def check_tools_offered(run: Run) -> None:
    """The model saw exactly the allowed HELM tools: nothing built in, nothing hosted."""
    calls = [c for c in run.world.model_calls if c.dialect != "other"]
    if not calls:
        run.check("only_helm_tools", False, "the worker never called the model")
        return
    allowed = set(run.episode["tools"]["allowed"])
    problems = []
    for index, call in enumerate(calls):
        names = [tool_name(t.get("name")) for t in call.tools]
        types = {t.get("type") for t in call.tools}
        extra = sorted(set(names) - allowed)
        missing = sorted(allowed - set(names))
        if extra:
            problems.append(
                f"request {index} offered tools outside the episode's allowed list: {extra}"
            )
        if missing:
            problems.append(f"request {index} did not offer allowed tools: {missing}")
        hosted = sorted(str(t) for t in types if _HOSTED.search(str(t)))
        if hosted:
            problems.append(f"request {index} carries provider-executed tool types: {hosted}")
        if call.has_mcp_servers:
            problems.append(f"request {index} passes mcp_servers to the provider")
    run.check("only_helm_tools", not problems, "; ".join(problems))


def check_model_requests(run: Run) -> None:
    calls = [c for c in run.world.model_calls if c.dialect != "other"]
    want_dialect = {
        "anthropic-messages": "anthropic",
        "openai-responses": "responses",
        "openai-chat-completions": "chat",
    }[run.api]
    model = run.episode["model"]
    problems = []
    for index, call in enumerate(calls):
        if call.dialect != want_dialect:
            problems.append(f"request {index} used {call.path}, not the {run.api} endpoint")
        if call.model != model["model"]:
            problems.append(
                f"request {index} asked for model {call.model!r}, not {model['model']!r}"
            )
        if call.max_tokens is not None and call.max_tokens > model["max_output_tokens"]:
            problems.append(
                f"request {index} allows {call.max_tokens} output tokens, over {model['max_output_tokens']}"
            )
    run.check(
        "model_requests", bool(calls) and not problems, "; ".join(problems) or "no model requests"
    )


def check_credentials(run: Run) -> None:
    """Every call presented the episode token, and the worker did reach the MCP server."""
    problems = list(run.world.violations)
    if not run.world.mcp_methods:
        problems.append("the worker never contacted the MCP server")
    run.check("credentials_and_urls", not problems, "; ".join(problems))


def check_prompt(run: Run) -> None:
    first = next((c for c in run.world.model_calls if c.text), None)
    if first is None:
        run.check("prompt_carries_episode", False, "no model request to inspect")
        return
    body = first.text
    goal, instructions = run.episode["goal"], run.episode["seat"]["instructions"]
    missing = [
        label
        for label, text in (("goal", goal), ("seat instructions", instructions))
        if text not in body
    ]
    run.check(
        "prompt_carries_episode",
        not missing,
        f"the first model request lacks the episode's {', '.join(missing)}",
    )


def check_no_egress(run: Run) -> None:
    if run.sinkhole is None:
        run.skip(
            "no_egress",
            "no sinkhole in this environment (not running in the isolated Docker network)",
        )
        return
    events = run.sinkhole.offending()
    run.check("no_egress", not events, "; ".join(str(e) for e in events[:5]))


def check_token_not_leaked(run: Run) -> None:
    """Neither secret may appear in anything the worker says over A2A."""
    haystack = json.dumps([e.raw for e in run.stream.snapshot()] if run.stream else [])
    haystack += json.dumps(run.client.card)
    leaked = [
        label
        for label, secret in (("episode token", run.token), ("ingress token", run.ingress_token))
        if secret and secret in haystack
    ]
    run.check(
        "secrets_not_leaked",
        not leaked,
        f"the worker's A2A output contains the {' and '.join(leaked)}",
    )


def check_quiet_after(run: Run, name: str, instant: float, grace: float = 1.0) -> None:
    """Nothing new may start (model call, tool call) once the worker should have stopped."""
    late = [
        f"model {c.path}"
        for c in run.world.model_calls
        if c.dialect != "other" and c.t > instant + grace
    ]
    late += [f"tool {c.tool}" for c in run.world.mcp_calls if c.t_start > instant + grace]
    run.check(name, not late, f"started after the worker should have stopped: {late}")


def check_extension_declared(run: Run) -> None:
    card = run.client.card
    extensions = (card.get("capabilities") or {}).get("extensions") or []
    match = next((e for e in extensions if e.get("uri") == EXTENSION_URI), None)
    run.check(
        "card_declares_required_extension",
        match is not None and match.get("required") is True,
        f"extensions: {extensions}",
    )
