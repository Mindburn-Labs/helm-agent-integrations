"""The conformance scenarios: how each one drives the worker and what it asserts.

A scenario scripts the model, opens or abuses an A2A conversation, and appends checks to the
`Run`. Check names are stable identifiers, so a failing report says exactly which rule broke.
"""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from helm_worker_contract import EPISODE_MEDIA_TYPE, EXTENSION_URI, schema_issues

from .a2a import TERMINAL_STATES, episode_message
from .checks import (
    Run,
    artifact_data,
    artifact_events,
    check_credentials,
    check_extension_declared,
    check_model_requests,
    check_no_egress,
    check_prompt,
    check_quiet_after,
    check_token_not_leaked,
    check_tools_offered,
    final_status,
    status_problems,
    stream_problems,
)

MODEL_NAMES = {
    "anthropic-messages": "claude-sonnet-5-5",
    "openai-responses": "gpt-6-sol",
    "openai-chat-completions": "gpt-6-sol",
}
DEFAULT_ALLOWED = ["github_repository_get", "github_pull_request_create_draft", "helm_work_report"]
CANCEL_LIMIT = 10.0  # seconds, contract section 7 (lane L6 acceptance)
# How long the scripted model or tool holds a call open. Long enough to cancel it, short enough
# that a worker which ignores the cancel visibly carries on afterwards.
HOLD = 6
SCENARIO_TIMEOUT = 90.0
DEADLINE_SCENARIO_SECONDS = 6  # the episode deadline of deadline_exceeded


def report_call(status: str = "done") -> dict[str, Any]:
    return {
        "name": "helm_work_report",
        "arguments": {
            "status": status,
            "summary": "All finished.",
            "outputs": [{"kind": "note", "ref": "n-1"}],
        },
    }


@dataclass
class Scenario:
    id: str
    title: str
    script: list[dict[str, Any]]
    drive: Callable[[Run], None]
    allowed: list[str] = field(default_factory=lambda: list(DEFAULT_ALLOWED))
    deadline_seconds: int = 600
    mcp_structured: bool = True
    mcp_reconciling_tool: str = ""
    evaluation: dict[str, str] | None = None
    # Needs the worker to accept the run (skipped when the API is not one the worker supports).
    needs_api_support: bool = True
    # Scenarios that exercise unsupported APIs run with a different api than the sweep's.
    only_unsupported_api: bool = False
    # True when the model API plays no part, so the sweep runs it once rather than per API.
    api_independent: bool = False


def build_episode(scenario: Scenario, api: str, mcp_url: str, model_url: str) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    return {
        "schema": "helm.episode.v1",
        **({"evaluation": scenario.evaluation} if scenario.evaluation else {}),
        "episode_id": str(uuid.uuid4()),
        "work_item_id": str(uuid.uuid4()),
        "continuation": 0,
        "organization": {"id": "org-conformance", "version_id": "ver-1"},
        "seat": {
            "id": "seat-conformance",
            "key": "engineer_1",
            "principal_id": "agt:seat-conformance",
            "role": "Engineer",
            "team": "Maintenance",
            "instructions": "You are a conformance test agent and follow the script you are given.",
        },
        "goal": f"Conformance scenario {scenario.id}: do the work and report.",
        "context": {
            "brief": "Synthetic episode from the HELM worker conformance kit.",
            "prior_episodes": [],
            "attempt_results": [],
            "children": [],
        },
        "acceptance": {"criteria": "helm_work_report is applied.", "required_effects": []},
        "tools": {"mcp_url": mcp_url, "allowed": list(scenario.allowed)},
        "model": {
            "base_url": model_url,
            "api": api,
            "model": MODEL_NAMES[api],
            "max_output_tokens": 4096,
        },
        "budget": {"allotment": [{"unit": "usd_micros", "value": 2_000_000}]},
        "deadline": (now + timedelta(seconds=scenario.deadline_seconds)).strftime(
            "%Y-%m-%dT%H:%M:%S.%f"
        )[:-3]
        + "Z",
        "credentials": {"env": "HELM_EPISODE_TOKEN"},
    }


# ----- drivers -------------------------------------------------------------------------------


def _open(run: Run) -> None:
    run.stream = run.client.stream(
        "SendStreamingMessage",
        episode_message(run.episode, EPISODE_MEDIA_TYPE),
        extensions=[EXTENSION_URI],
    )


def _finish(run: Run, timeout: float = SCENARIO_TIMEOUT) -> None:
    assert run.stream is not None
    run.stream.wait(lambda s: s.closed or s.rpc_error is not None, timeout)
    run.world.stop.set()


def _standard(run: Run, final: set[str], *, name: str = "streaming_events") -> None:
    """Common tail for scenarios that run to a final state: protocol, traffic and secrets."""
    assert run.stream is not None
    problems = stream_problems(run, run.stream, final)
    run.check(name, not problems, "; ".join(problems[:6]))
    check_credentials(run)
    check_model_requests(run)
    check_tools_offered(run)
    check_prompt(run)
    check_token_not_leaked(run)
    check_no_egress(run)


def _mcp_tools(run: Run) -> list[str]:
    return [c.tool for c in run.world.mcp_calls]


def drive_report_completes(run: Run) -> None:
    _open(run)
    _finish(run)
    assert run.stream is not None
    _standard(run, {"TASK_STATE_COMPLETED"})
    reports = [c for c in run.world.mcp_calls if c.tool == "helm_work_report"]
    completed = next((e for e in run.stream.snapshot() if e.state == "TASK_STATE_COMPLETED"), None)
    run.check(
        "report_before_completed",
        bool(reports) and completed is not None and (reports[0].t_end or 1e18) <= completed.t,
        f"helm_work_report calls: {len(reports)}; the COMPLETED event must come after the report was applied",
    )
    problems = []
    proposals = artifact_events(run.stream, "helm.proposal")
    if not proposals:
        problems.append("no helm.proposal artifact for the github_repository_get call")
    for event in proposals:
        problems += [
            f"helm.proposal: {i}" for i in schema_issues("proposal.v1", artifact_data(event))
        ]
    mirrors = artifact_events(run.stream, "helm.report")
    if len(mirrors) != 1:
        problems.append(f"want one helm.report artifact, got {len(mirrors)}")
    for event in mirrors:
        problems += [f"helm.report: {i}" for i in schema_issues("report.v1", artifact_data(event))]
    run.check("artifact_mirrors", not problems, "; ".join(problems))
    problems = status_problems(run.stream)
    payload, _ = final_status(run.stream)
    if payload is not None and payload.get("report", {}).get("status") != "done":
        problems.append(
            f"COMPLETED status carries report {payload.get('report')!r}, want the applied report (done)"
        )
    run.check("completed_status_payload", not problems, "; ".join(problems))
    if reports and reports[0].t_end:
        check_quiet_after(run, "stops_after_report", reports[0].t_end)
        run.check(
            "stops_after_report_model",
            len([c for c in run.world.model_calls if c.dialect != "other"]) == 2,
            f"the model was called {len([c for c in run.world.model_calls if c.dialect != 'other'])} times; the loop must stop once the report is applied (2 calls)",
        )


def drive_parks(
    run: Run, *, tool: str, key: str, expected: Callable[[Run], Any], stop_after: str
) -> None:
    _open(run)
    _finish(run)
    assert run.stream is not None
    _standard(run, {"TASK_STATE_INPUT_REQUIRED"})
    payload, _ = final_status(run.stream)
    problems = status_problems(run.stream)
    want = expected(run)
    got = (payload or {}).get("waiting_on", {}).get(key)
    if got != want:
        problems.append(f"waiting_on.{key} is {got!r}, want {want!r}")
    run.check("parks_input_required", not problems, "; ".join(problems))
    calls = run.world.mcp_calls
    model_calls = [c for c in run.world.model_calls if c.dialect != "other"]
    problems = []
    if _mcp_tools(run) != [tool]:
        problems.append(f"tool calls were {_mcp_tools(run)}, want only [{tool}]")
    if len(model_calls) != 1:
        problems.append(
            f"the model was called {len(model_calls)} times; the loop must stop after {stop_after}"
        )
    run.check("stops_the_loop", not problems, "; ".join(problems))
    if calls and calls[0].t_end:
        check_quiet_after(run, "quiet_after_park", calls[0].t_end)


def _first_attempt(run: Run) -> list[str]:
    for call in run.world.mcp_calls:
        structured = (call.result or {}).get("structuredContent") or {}
        if structured.get("attempt_id"):
            return [structured["attempt_id"]]
        try:
            text = json.loads(call.result["content"][0]["text"])  # type: ignore[index]
            if text.get("attempt_id"):
                return [text["attempt_id"]]
        except (TypeError, KeyError, ValueError, IndexError):
            continue
    return []


def drive_no_report(run: Run) -> None:
    _open(run)
    _finish(run)
    assert run.stream is not None
    _standard(run, {"TASK_STATE_FAILED"})
    payload, _ = final_status(run.stream)
    problems = status_problems(run.stream)
    if (payload or {}).get("error", {}).get("code") != "NO_REPORT":
        problems.append(f"error is {(payload or {}).get('error')!r}, want code NO_REPORT")
    if artifact_events(run.stream, "helm.report"):
        problems.append("a helm.report artifact was mirrored although no report was made")
    run.check("fails_with_no_report", not problems, "; ".join(problems))


def drive_evaluation(run: Run) -> None:
    _open(run)
    _finish(run)
    assert run.stream is not None
    _standard(run, {"TASK_STATE_COMPLETED"})
    payload, _ = final_status(run.stream)
    review = (payload or {}).get("review", {})
    expected = run.world.script[1]["tools"][0]["arguments"]
    problems = status_problems(run.stream)
    if review != {"target": expected["target"], **expected["arguments"]}:
        problems.append("completed review mirror is not the exact bound judgment")
    if (payload or {}).get("report") or artifact_events(run.stream, "helm.report"):
        problems.append("review completion fabricated a report")
    run.check("completes_bound_review", not problems, "; ".join(problems))
    calls = [c for c in run.world.model_calls if c.dialect != "other"]
    run.check(
        "stops_after_review",
        _mcp_tools(run) == ["helm_work_get", "helm_work_review"] and len(calls) == 2,
        f"tools={_mcp_tools(run)}, model calls={len(calls)}",
    )
    if run.world.mcp_calls and run.world.mcp_calls[-1].t_end:
        check_quiet_after(run, "quiet_after_review", run.world.mcp_calls[-1].t_end)


# Model-typed targets that differ from the episode's binding. The first is the retained reviewer
# failure: the episode's own work id with one group mistyped (7ef7 for ff7e). Episodes get a
# random work id, so neither can be the bound one.
WRONG_WORK = "work:450c7298-7ef7-4a1b-9c3d-5e6f7a8b9c0d"
WRONG_ORG = "org:org-elsewhere"
TARGET_REFUSAL_CODE = "SCHEMA_VIOLATION"


def bound_targets(episode: dict[str, Any]) -> dict[str, str]:
    """The target CP admits for each self-targeted tool of this episode, written from the CP
    rules rather than taken from the contract package under test: the episode's own work for
    get, report and request_input, its organization for request_capability, and an evaluator's
    original work for review."""
    own = "work:" + episode["work_item_id"]
    targets = {
        "helm_work_get": own,
        "helm_work_report": own,
        "helm_work_request_input": own,
        "helm_org_request_capability": "org:" + episode["organization"]["id"],
    }
    if episode.get("evaluation"):
        targets["helm_work_review"] = "work:" + episode["evaluation"]["work_item_id"]
    return targets


def drive_bound_targets(run: Run, *, sent: list[str]) -> None:
    """A wrong self target is refused inside the worker, the model is told and recovers, and
    only calls carrying the bound target reach the gateway. The last script step is a trap."""
    _open(run)
    _finish(run)
    assert run.stream is not None
    _standard(run, {"TASK_STATE_COMPLETED"})
    bound = bound_targets(run.episode)
    refused = [
        (turn, call)
        for turn, step in enumerate(run.world.script)
        for call in step.get("tools", [])
        if call["name"] in bound
        and (call.get("arguments") or {}).get("target") not in (None, "", bound[call["name"]])
    ]
    problems = []
    if _mcp_tools(run) != sent:
        problems.append(f"tool calls reaching the gateway were {_mcp_tools(run)}, want {sent}")
    for call in run.world.mcp_calls:
        target = call.arguments.get("target")
        if call.tool in bound and target != bound[call.tool]:
            problems.append(f"{call.tool} reached the gateway with target {target!r}")
    run.check("bound_targets_sent", not problems, "; ".join(problems))

    model_calls = [c for c in run.world.model_calls if c.dialect != "other"]
    problems = []
    for turn, call in refused:
        # Each request resends the history, so an earlier refusal is already in it: the turn
        # after this refusal must carry one more tool error than the turn that made the call.
        before = max(
            (c.body.count(TARGET_REFUSAL_CODE) for c in model_calls if c.turn == turn), default=0
        )
        after = [c for c in model_calls if c.turn == turn + 1]
        if not any(c.body.count(TARGET_REFUSAL_CODE) > before for c in after):
            problems.append(
                f"the model turn after the refused {call['name']} (turn {turn}) did not carry "
                f"the {TARGET_REFUSAL_CODE} tool error"
            )
    if len(model_calls) != len(run.world.script) - 1:
        problems.append(
            f"the model was called {len(model_calls)} times, want {len(run.world.script) - 1}: "
            "a refusal must not end the episode, and the applied effect must"
        )
    run.check("refusals_reach_the_model", not problems, "; ".join(problems))

    mirrored = [
        (p.get("tool"), (p.get("arguments") or {}).get("target"))
        for p in map(artifact_data, artifact_events(run.stream, "helm.proposal"))
        if p.get("status") == "error"
    ]
    problems = [
        f"no error proposal mirror for the refused {call['name']}"
        for _turn, call in refused
        if call["name"] != "helm_work_report"
        and (call["name"], call["arguments"]["target"]) not in mirrored
    ]
    notes = [
        str(part.get("text") or "")
        for event in run.stream.snapshot()
        if event.state == "TASK_STATE_WORKING"
        for part in ((event.body.get("status") or {}).get("message") or {}).get("parts") or []
        if TARGET_REFUSAL_CODE in str(part.get("text") or "")
    ]
    for _turn, call in refused:
        if not any(call["name"] in note for note in notes):
            problems.append(f"no WORKING note names the refused {call['name']}")
    if len(notes) != len(refused):
        problems.append(f"{len(notes)} refusal notes for {len(refused)} refused calls")
    run.check("refusals_in_transcript", not problems, "; ".join(problems))

    payload, _ = final_status(run.stream)
    problems = status_problems(run.stream)
    if run.episode.get("evaluation"):
        review = (payload or {}).get("review") or {}
        if review.get("target") != bound["helm_work_review"]:
            problems.append(f"completed review mirror is {review!r}, want the bound target")
    elif ((payload or {}).get("report") or {}).get("status") != "done":
        problems.append(f"COMPLETED status carries report {(payload or {}).get('report')!r}")
    run.check("completes_on_bound_effect", not problems, "; ".join(problems))
    if run.world.mcp_calls and run.world.mcp_calls[-1].t_end:
        check_quiet_after(run, "quiet_after_bound_effect", run.world.mcp_calls[-1].t_end)


def drive_reconciling(run: Run) -> None:
    _open(run)
    _finish(run)
    assert run.stream is not None
    _standard(run, {"TASK_STATE_FAILED"})
    payload, _ = final_status(run.stream)
    problems = status_problems(run.stream)
    if (payload or {}).get("error", {}).get("code") != "EFFECT_OUTCOME_PENDING":
        problems.append("uncertain effect was not distinguished from an ordinary retryable failure")
    if artifact_events(run.stream, "helm.report"):
        problems.append("an unconfirmed report was mirrored as applied")
    run.check("retains_uncertain_outcome", not problems, "; ".join(problems))
    calls = [c for c in run.world.model_calls if c.dialect != "other"]
    run.check(
        "stops_after_uncertain_effect",
        _mcp_tools(run) == [run.world.mcp_reconciling_tool] and len(calls) == 1,
        f"tools={_mcp_tools(run)}, model calls={len(calls)}",
    )
    proposals = artifact_events(run.stream, "helm.proposal")
    attempt = _first_attempt(run)
    run.check(
        "retains_original_attempt",
        bool(attempt) and any(artifact_data(p).get("attempt_id") == attempt[0] for p in proposals),
        "the proposal mirror must retain the original gateway attempt",
    )
    if run.world.mcp_calls and run.world.mcp_calls[0].t_end:
        check_quiet_after(run, "quiet_after_uncertain_effect", run.world.mcp_calls[0].t_end)


def _wait_for_traffic(run: Run, what: str, timeout: float = 45.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if what == "model" and any(c.dialect != "other" and c.step for c in run.world.model_calls):
            return True
        if what == "tool" and run.world.mcp_calls:
            return True
        time.sleep(0.05)
    return False


def drive_cancel(run: Run, *, waiting_for: str) -> None:
    _open(run)
    assert run.stream is not None
    if not (
        run.stream.wait(lambda s: s.task_id() is not None, 30)
        and _wait_for_traffic(run, waiting_for)
    ):
        run.world.stop.set()
        run.check(
            "cancel_within_10s",
            False,
            f"the worker never reached the {waiting_for} call the script holds open",
        )
        return
    held_since = min(
        [c.t for c in run.world.model_calls if c.step == "sleep"]
        or [c.t_start for c in run.world.mcp_calls]
        or [time.monotonic()]
    )
    time.sleep(0.5)
    task_id = run.stream.task_id()
    sent = time.monotonic()
    run.marks["cancel_sent"] = sent
    problems = []
    try:
        response = run.client.call(
            "CancelTask", {"id": task_id}, extensions=[EXTENSION_URI], timeout=CANCEL_LIMIT + 5
        )
    except OSError as exc:
        response = None
        problems.append(f"CancelTask got no answer within {CANCEL_LIMIT + 5:.0f}s ({exc})")
    answered = time.monotonic()
    run.marks["cancel_answered"] = answered
    run.stream.wait(lambda s: s.closed, max(0.0, CANCEL_LIMIT - (answered - sent)) + 1)
    if response is not None:
        try:
            envelope = response.json()
        except ValueError:
            envelope = {}
        if response.status != 200 or "result" not in envelope:
            problems.append(
                f"CancelTask answered HTTP {response.status} {str(response.body[:200])}"
            )
        elif envelope["result"].get("status", {}).get("state") != "TASK_STATE_CANCELED":
            problems.append(
                f"CancelTask returned state {envelope['result'].get('status', {}).get('state')}"
            )
    if answered - sent > CANCEL_LIMIT:
        problems.append(f"CancelTask took {answered - sent:.1f}s")
    if run.stream.final_state() != "TASK_STATE_CANCELED":
        problems.append(f"the stream ended in {run.stream.final_state()}, want TASK_STATE_CANCELED")
    closed = run.stream.t_closed
    if closed is None or closed - sent > CANCEL_LIMIT:
        problems.append("the stream did not close within 10s of the cancel request")
    run.check("cancel_within_10s", not problems, "; ".join(problems))
    # Wait past the moment the held call would have finished on its own: a worker that ignored
    # the cancel would carry on from there.
    time.sleep(max(1.0, held_since + HOLD + 1.5 - time.monotonic()))
    run.world.stop.set()
    check_quiet_after(run, "cancel_stops_work", answered, grace=0.5)
    if waiting_for == "model":
        aborted = [c.aborted for c in run.world.model_calls if c.step == "sleep"]
    else:
        aborted = [c.aborted for c in run.world.mcp_calls[:1]]
    aborted_all = bool(aborted) and all(aborted)
    run.check(
        "cancel_aborts_inflight_call",
        aborted_all,
        "the call the worker was waiting on was not abandoned after the cancel",
    )
    check_token_not_leaked(run)
    check_no_egress(run)


def drive_extension_required(run: Run) -> None:
    stream = run.client.stream(
        "SendStreamingMessage", episode_message(run.episode, EPISODE_MEDIA_TYPE), extensions=None
    )
    stream.wait_closed(20)
    error = stream.rpc_error or {}
    problems = []
    if error.get("code") != -32008:
        problems.append(
            f"want JSON-RPC error -32008 (ExtensionSupportRequiredError), got {error or stream.events or stream.error}"
        )
    if stream.events:
        problems.append("a task was started without the required extension")
    run.check("extension_required", not problems, "; ".join(problems))
    run.check(
        "no_traffic_without_extension",
        not run.world.mcp_calls and not [c for c in run.world.model_calls if c.dialect != "other"],
        "the worker used the model or tools although the request was rejected",
    )
    run.world.stop.set()


def drive_ingress_auth(run: Run) -> None:
    problems = []
    message = episode_message(run.episode, EPISODE_MEDIA_TYPE)
    for label, bearer in (("no bearer", None), ("a wrong bearer", "not-the-secret")):
        result = run.client.call(
            "SendMessage", message, bearer=bearer, extensions=[EXTENSION_URI], timeout=15
        )
        if result.status not in (401, 403):
            problems.append(f"{label}: HTTP {result.status}, want 401 or 403")
    card = run.client.fetch_card()
    if card.status != 200:
        problems.append(f"the AgentCard needs no credentials but answered HTTP {card.status}")
    run.check("ingress_auth", not problems, "; ".join(problems))
    run.check(
        "no_traffic_without_auth",
        not run.world.mcp_calls and not [c for c in run.world.model_calls if c.dialect != "other"],
        "an unauthenticated request started work",
    )
    run.world.stop.set()


def drive_rejected(
    run: Run,
    code: str,
    *,
    message: Callable[[Run], dict[str, Any]] | None = None,
    episode: Callable[[Run], dict[str, Any]] | None = None,
) -> None:
    """Send an episode (or a whole message) the worker must refuse with a REJECTED task."""
    params = (
        {"message": message(run)}
        if message
        else episode_message(episode(run) if episode else run.episode, EPISODE_MEDIA_TYPE)
    )
    run.stream = run.client.stream("SendStreamingMessage", params, extensions=[EXTENSION_URI])
    _finish(run, 30)
    stream = run.stream
    problems = []
    if stream.rpc_error is not None and not stream.events:
        # A JSON-RPC error is also a refusal, but the contract asks for a REJECTED task.
        problems.append(f"JSON-RPC error {stream.rpc_error.get('code')} instead of a REJECTED task")
    else:
        problems += stream_problems(run, stream, {"TASK_STATE_REJECTED"})
        payload, _ = final_status(stream)
        problems += status_problems(stream)
        if (payload or {}).get("error", {}).get("code") != code:
            problems.append(f"error is {(payload or {}).get('error')!r}, want code {code}")
    run.check(f"rejects_with_{code.lower()}", not problems, "; ".join(problems[:6]))
    run.check(
        "no_traffic_when_rejected",
        not run.world.mcp_calls and not [c for c in run.world.model_calls if c.dialect != "other"],
        "the worker used the model or tools for a rejected episode",
    )
    check_token_not_leaked(run)


def drive_inert_tools(run: Run) -> None:
    _open(run)
    _finish(run)
    assert run.stream is not None
    problems = []
    state = run.stream.final_state()
    if state not in TERMINAL_STATES:
        problems.append(f"the episode ended in {state}, not a terminal state")
    stray = [t for t in _mcp_tools(run) if t not in ("helm_work_report",)]
    if stray:
        problems.append(f"tools ran that the model was never offered: {stray}")
    if state == "TASK_STATE_COMPLETED" and "helm_work_report" not in _mcp_tools(run):
        problems.append("COMPLETED without an applied report")
    run.check("hallucinated_tools_are_inert", not problems, "; ".join(problems))
    check_tools_offered(run)
    check_no_egress(run)
    check_token_not_leaked(run)


def drive_deadline(run: Run) -> None:
    _open(run)
    assert run.stream is not None
    started = time.monotonic()
    _finish(run, 60)
    deadline = datetime.fromisoformat(run.episode["deadline"].replace("Z", "+00:00"))
    budget = (deadline - datetime.now(timezone.utc)).total_seconds()
    ended = run.stream.t_closed or time.monotonic()
    payload, _ = final_status(run.stream)
    problems = status_problems(run.stream)
    if run.stream.final_state() != "TASK_STATE_FAILED":
        problems.append(f"the episode ended in {run.stream.final_state()}, want TASK_STATE_FAILED")
    if (payload or {}).get("error", {}).get("code") != "DEADLINE_EXCEEDED":
        problems.append(f"error is {(payload or {}).get('error')!r}, want DEADLINE_EXCEEDED")
    # The deadline was set `deadline_seconds` after the episode was built; allow 8s to stop.
    late = ended - started - (DEADLINE_SCENARIO_SECONDS + 8)
    if late > 0:
        problems.append(f"the worker stopped {late:.1f}s after the 8s allowance past the deadline")
    del budget
    run.check("deadline_enforced", not problems, "; ".join(problems[:5]))
    check_quiet_after(run, "deadline_stops_work", ended, grace=1.0)


def drive_model_error(run: Run) -> None:
    _open(run)
    _finish(run)
    assert run.stream is not None
    _standard(run, {"TASK_STATE_FAILED"})
    payload, _ = final_status(run.stream)
    problems = status_problems(run.stream)
    if (payload or {}).get("error", {}).get("code") != "MODEL_ERROR":
        problems.append(f"error is {(payload or {}).get('error')!r}, want MODEL_ERROR")
    run.check("fails_with_model_error", not problems, "; ".join(problems))


def drive_resume(run: Run) -> None:
    _open(run)
    assert run.stream is not None
    stream = run.stream
    problems: list[str] = []
    if not stream.wait(
        lambda s: s.task_id() is not None and "TASK_STATE_WORKING" in s.states(), 30
    ):
        run.check(
            "task_survives_client_disconnect", False, "the episode never reached TASK_STATE_WORKING"
        )
        run.world.stop.set()
        return
    task_id = stream.task_id()
    stream.close()  # the control plane restarted mid-episode
    time.sleep(0.5)
    got = run.client.call("GetTask", {"id": task_id}, extensions=[EXTENSION_URI])
    try:
        task = got.json().get("result", {})
    except ValueError:
        task = {}
    state = task.get("status", {}).get("state")
    if got.status != 200 or state not in ("TASK_STATE_WORKING", "TASK_STATE_SUBMITTED"):
        problems.append(f"GetTask during the run answered HTTP {got.status} state {state}")
    resumed = run.client.stream("SubscribeToTask", {"id": task_id}, extensions=[EXTENSION_URI])
    resumed.wait(lambda s: s.closed or s.rpc_error is not None, SCENARIO_TIMEOUT)
    events = resumed.snapshot()
    if not events or events[0].kind != "task":
        problems.append(
            f"SubscribeToTask must open with the current task, got {events[0].kind if events else resumed.rpc_error or resumed.error}"
        )
    if resumed.final_state() != "TASK_STATE_COMPLETED":
        problems.append(
            f"the resumed stream ended in {resumed.final_state()}, want TASK_STATE_COMPLETED"
        )
    if not resumed.closed:
        problems.append("the resumed stream stayed open")
    run.check("task_survives_client_disconnect_and_resumes", not problems, "; ".join(problems))
    final = run.client.call("GetTask", {"id": task_id}, extensions=[EXTENSION_URI])
    try:
        done = final.json().get("result", {})
    except ValueError:
        done = {}
    ok = done.get("status", {}).get("state") == "TASK_STATE_COMPLETED"
    run.check(
        "get_task_after_completion",
        ok,
        f"GetTask after the run answered state {done.get('status', {}).get('state')}",
    )
    run.stream = resumed
    run.world.stop.set()
    check_token_not_leaked(run)


def drive_card(run: Run) -> None:
    result = run.client.fetch_card()
    problems = []
    if result.status != 200:
        run.check(
            "agent_card", False, f"GET /.well-known/agent-card.json answered HTTP {result.status}"
        )
        return
    card = run.client.card
    interfaces = card.get("supportedInterfaces") or []
    if (
        not interfaces
        or interfaces[0].get("protocolBinding") != "JSONRPC"
        or interfaces[0].get("protocolVersion") != "1.0"
    ):
        problems.append(f"first supportedInterfaces entry is {interfaces[:1]}, want JSONRPC 1.0")
    elif not str(interfaces[0].get("url", "")).startswith(("http://", "https://")):
        problems.append(f"interface url {interfaces[0].get('url')!r} is not absolute")
    capabilities = card.get("capabilities") or {}
    if capabilities.get("streaming") is not True:
        problems.append("capabilities.streaming is not true")
    apis = next(
        (
            e.get("params", {}).get("model_apis")
            for e in capabilities.get("extensions", [])
            if e.get("uri") == EXTENSION_URI
        ),
        None,
    )
    if not apis:
        problems.append("the extension params do not list model_apis")
    for key in (
        "name",
        "description",
        "version",
        "skills",
        "defaultInputModes",
        "defaultOutputModes",
    ):
        if not card.get(key):
            problems.append(f"card has no {key}")
    if EPISODE_MEDIA_TYPE not in (card.get("defaultInputModes") or []):
        problems.append(f"defaultInputModes lacks {EPISODE_MEDIA_TYPE}")
    run.check("agent_card", not problems, "; ".join(problems))
    check_extension_declared(run)
    run.world.stop.set()


def _bad_schema(run: Run) -> dict[str, Any]:
    return {**run.episode, "schema": "helm.episode.v9"}


def _message_without_episode(run: Run) -> dict[str, Any]:
    return {
        "messageId": run.episode["episode_id"],
        "contextId": run.episode["work_item_id"],
        "role": "ROLE_USER",
        "parts": [{"text": run.episode["goal"], "mediaType": "text/plain"}],
    }


SCENARIOS: dict[str, Scenario] = {}


def _add(scenario: Scenario) -> None:
    SCENARIOS[scenario.id] = scenario


_add(
    Scenario(
        "agent_card",
        "AgentCard declares the required extension",
        [],
        drive_card,
        api_independent=True,
    )
)
_add(
    Scenario(
        "extension_required",
        "A request without the required extension is refused",
        [],
        drive_extension_required,
        api_independent=True,
    )
)
_add(
    Scenario(
        "ingress_auth",
        "The JSON-RPC endpoint needs the ingress bearer",
        [],
        drive_ingress_auth,
        api_independent=True,
    )
)
_add(
    Scenario(
        "report_completes",
        "Streams progress, mirrors, and completes only after helm_work_report",
        [
            {"tools": [{"name": "github_repository_get", "arguments": {"repo": "acme/sandbox"}}]},
            {"tools": [report_call()]},
        ],
        drive_report_completes,
    )
)
for _pending_tool, _structured, _suffix in (
    ("github_pull_request_create_draft", True, "effect"),
    ("github_pull_request_create_draft", False, "text_only"),
    ("helm_work_report", True, "report"),
):
    _call = (
        report_call()
        if _pending_tool == "helm_work_report"
        else {"name": _pending_tool, "arguments": {"title": "Uncertain effect probe"}}
    )
    _add(
        Scenario(
            "reconciling_" + _suffix + "_stops",
            "An uncertain effect stops before another tool or model call",
            [{"tools": [_call, report_call()]}, {"tools": [report_call()]}],
            drive_reconciling,
            mcp_structured=_structured,
            mcp_reconciling_tool=_pending_tool,
        )
    )

for _structured in (True, False):
    _add(
        Scenario(
            "escalated_parks" if _structured else "escalated_parks_text_only",
            "An escalated tool result parks the episode"
            + ("" if _structured else " (result without structuredContent)"),
            [
                {
                    "tools": [
                        {
                            "name": "github_pull_request_create_draft",
                            "arguments": {"title": "Fix lint"},
                        }
                    ]
                },
                {"tools": [report_call()]},  # a trap: the loop must have stopped before this turn
            ],
            lambda run: drive_parks(
                run,
                tool="github_pull_request_create_draft",
                key="attempts",
                expected=_first_attempt,
                stop_after="an escalated result",
            ),
            mcp_structured=_structured,
        )
    )
_add(
    Scenario(
        "escalated_batch_stops",
        "An escalated first tool suppresses the remaining calls in a model tool batch",
        [
            {
                "tools": [
                    {
                        "name": "github_pull_request_create_draft",
                        "arguments": {"repo": "org/repo", "title": "Escalation probe"},
                    },
                    report_call(),
                ]
            },
            {"tools": [report_call()]},
        ],
        lambda run: drive_parks(
            run,
            tool="github_pull_request_create_draft",
            key="attempts",
            expected=_first_attempt,
            stop_after="an escalated result in a tool batch",
        ),
    )
)
_add(
    Scenario(
        "delegate_parks_children",
        "A successful helm_work_delegate parks the episode on the child",
        [
            {
                "tools": [
                    {
                        "name": "helm_work_delegate",
                        "arguments": {"target": "seat:engineer", "goal": "Fix it"},
                    }
                ]
            },
            {"tools": [report_call()]},
        ],
        lambda run: drive_parks(
            run,
            tool="helm_work_delegate",
            key="children",
            expected=lambda _r: ["child-1"],
            stop_after="a delegation",
        ),
        allowed=[*DEFAULT_ALLOWED, "helm_work_delegate"],
    )
)
_add(
    Scenario(
        "request_input_parks_input",
        "A successful helm_work_request_input parks the episode on the question",
        [
            {
                "tools": [
                    {
                        "name": "helm_work_request_input",
                        "arguments": {"question": "Which branch?", "options": ["main", "next"]},
                    }
                ]
            },
            {"tools": [report_call()]},
        ],
        lambda run: drive_parks(
            run,
            tool="helm_work_request_input",
            key="input",
            expected=lambda _r: {"question": "Which branch?", "options": ["main", "next"]},
            stop_after="a question",
        ),
        allowed=[*DEFAULT_ALLOWED, "helm_work_request_input"],
    )
)
_add(
    Scenario(
        "no_report_fails",
        "Ending without helm_work_report fails with NO_REPORT",
        [{"text": "I am done."}],
        drive_no_report,
    )
)
_add(
    Scenario(
        "cancel_during_model_call",
        "CancelTask is honored within 10s while the model call is open",
        [{"sleep": HOLD, "then": {"tools": [report_call()]}}],
        lambda run: drive_cancel(run, waiting_for="model"),
    )
)
_add(
    Scenario(
        "cancel_during_tool_call",
        "CancelTask is honored within 10s while a tool call is open",
        [
            {
                "tools": [
                    {
                        "name": "github_repository_get",
                        "arguments": {"repo": "acme/sandbox", "delay_seconds": HOLD},
                    }
                ]
            },
            {"tools": [report_call()]},
        ],
        lambda run: drive_cancel(run, waiting_for="tool"),
    )
)
_add(
    Scenario(
        "invalid_episode",
        "A message with an invalid episode is REJECTED",
        [],
        lambda run: drive_rejected(run, "INVALID_EPISODE", episode=_bad_schema),
        api_independent=True,
    )
)
_add(
    Scenario(
        "missing_episode",
        "A message without the episode part is REJECTED",
        [],
        lambda run: drive_rejected(run, "INVALID_EPISODE", message=_message_without_episode),
        api_independent=True,
    )
)
_add(
    Scenario(
        "unsupported_model_api",
        "An episode for a model API the worker does not support is REJECTED",
        [],
        lambda run: drive_rejected(run, "UNSUPPORTED_MODEL_API"),
        only_unsupported_api=True,
        api_independent=True,
    )
)
_add(
    Scenario(
        "hallucinated_tools_are_inert",
        "Calls to built-in or hosted tools the model was never offered do nothing",
        [
            {
                "tools": [
                    {
                        "name": "Bash",
                        "arguments": {"command": "curl -s http://exfil.example.test/x"},
                    },
                    {
                        "name": "WebFetch",
                        "arguments": {"url": "http://exfil.example.test/y", "prompt": "x"},
                    },
                    {"name": "web_search", "arguments": {"query": "x"}},
                    {"name": "Read", "arguments": {"file_path": "/etc/passwd"}},
                ]
            },
            {"tools": [report_call()]},
        ],
        drive_inert_tools,
    )
)
_add(
    Scenario(
        "deadline_exceeded",
        "The worker stops at the episode deadline",
        [{"sleep": 120, "then": {"text": "too late"}}],
        drive_deadline,
        deadline_seconds=DEADLINE_SCENARIO_SECONDS,
    )
)
_add(
    Scenario(
        "model_error_fails",
        "A model error fails the episode with MODEL_ERROR",
        [{"http_error": 400, "message": "scripted provider error"}],
        drive_model_error,
    )
)
_add(
    Scenario(
        "resume_via_subscribe",
        "GetTask and SubscribeToTask resume an episode after the client dropped",
        [
            {
                "tools": [
                    {
                        "name": "github_repository_get",
                        "arguments": {"repo": "acme/sandbox", "delay_seconds": 5},
                    }
                ]
            },
            {"tools": [report_call()]},
        ],
        drive_resume,
    )
)


def catalog() -> list[dict[str, Any]]:
    """The scenarios in run order, for the orchestrator (which cannot import this module)."""
    return [
        {"id": s.id, "title": s.title, "api_independent": s.api_independent}
        for s in SCENARIOS.values()
    ]


# A top-level evaluator finishes on its bound applied review, without an extra
# report grant. Later tools in the same batch and later model turns are traps.
for _decision, _structured in (("accept", True), ("reject", True), ("accept", False)):
    _review_work = "83ddc0d6-0861-4df4-a79a-0a13d9d2dd10"
    _add(
        Scenario(
            "evaluation_" + _decision + ("" if _structured else "_text_only"),
            "Independent evaluation completes only after the bound review is applied",
            [
                {"tools": [{"name": "helm_work_get", "arguments": {}}]},
                {
                    "tools": [
                        {
                            "name": "helm_work_review",
                            "arguments": {
                                "target": "work:" + _review_work,
                                "arguments": {
                                    "decision": _decision,
                                    "reason": "Checked original figures and acceptance criteria.",
                                },
                            },
                        },
                        {"name": "helm_work_get", "arguments": {}},
                    ]
                },
                {"tools": [{"name": "helm_work_get", "arguments": {}}]},
            ],
            drive_evaluation,
            allowed=["helm_work_get", "helm_work_review"],
            mcp_structured=_structured,
            evaluation={
                "work_item_id": _review_work,
                "episode_id": "5fc6970a-fb68-4817-bced-b2b8d7325b7f",
                "report_attempt_id": "original-report",
            },
        )
    )


# A model that types a wrong self target cannot make a mistargeted call leave the worker. Each
# wrong call is followed by the same call with the target left out, which the worker fills in,
# except helm_work_request_input: a sent question would park the episode, so it is only refused.
_REPORT = {
    "status": "done",
    "summary": "All finished.",
    "outputs": [{"kind": "note", "ref": "n-1"}],
}
_CAPABILITY = {"capability": "github.issue.comment", "justification": "Needed to answer the issue."}
_add(
    Scenario(
        "self_target_bound",
        "A self target other than the episode's own is refused in the worker, not sent",
        [
            {
                "tools": [
                    {"name": "helm_work_get", "arguments": {"target": WRONG_WORK, "arguments": {}}}
                ]
            },
            {"tools": [{"name": "helm_work_get", "arguments": {"arguments": {}}}]},
            {
                "tools": [
                    {
                        "name": "helm_org_request_capability",
                        "arguments": {"target": WRONG_ORG, "arguments": _CAPABILITY},
                    }
                ]
            },
            {
                "tools": [
                    {"name": "helm_org_request_capability", "arguments": {"arguments": _CAPABILITY}}
                ]
            },
            {
                "tools": [
                    {
                        "name": "helm_work_request_input",
                        "arguments": {
                            "target": WRONG_WORK,
                            "arguments": {"question": "Which branch?", "options": ["main"]},
                        },
                    }
                ]
            },
            {
                "tools": [
                    {
                        "name": "helm_work_report",
                        "arguments": {"target": WRONG_WORK, "arguments": _REPORT},
                    }
                ]
            },
            {"tools": [{"name": "helm_work_report", "arguments": {"arguments": _REPORT}}]},
            {"tools": [report_call()]},  # a trap: the applied report ended the loop
        ],
        lambda run: drive_bound_targets(
            run, sent=["helm_work_get", "helm_org_request_capability", "helm_work_report"]
        ),
        allowed=[
            "helm_work_get",
            "helm_org_request_capability",
            "helm_work_request_input",
            "helm_work_report",
        ],
    )
)
_add(
    Scenario(
        "evaluation_target_bound",
        "An evaluator's mistyped own or original work target is refused in the worker, not sent",
        [
            {
                "tools": [
                    {"name": "helm_work_get", "arguments": {"target": WRONG_WORK, "arguments": {}}}
                ]
            },
            {"tools": [{"name": "helm_work_get", "arguments": {"arguments": {}}}]},
            {
                "tools": [
                    {
                        "name": "helm_work_review",
                        "arguments": {
                            "target": "work:83ddc0d6-0861-4df4-a79a-0a13d9d2dd11",
                            "arguments": {"decision": "accept", "reason": "Checked the figures."},
                        },
                    }
                ]
            },
            {
                "tools": [
                    {
                        "name": "helm_work_review",
                        "arguments": {
                            "arguments": {"decision": "accept", "reason": "Checked the figures."}
                        },
                    }
                ]
            },
            {"tools": [{"name": "helm_work_get", "arguments": {}}]},  # a trap
        ],
        lambda run: drive_bound_targets(run, sent=["helm_work_get", "helm_work_review"]),
        allowed=["helm_work_get", "helm_work_review"],
        evaluation={
            "work_item_id": "83ddc0d6-0861-4df4-a79a-0a13d9d2dd10",
            "episode_id": "5fc6970a-fb68-4817-bced-b2b8d7325b7f",
            "report_attempt_id": "original-report",
        },
    )
)
