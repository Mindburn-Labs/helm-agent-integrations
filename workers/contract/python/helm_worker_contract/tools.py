"""What the agent's tool calls mean for the episode.

The rules here are the worker half of the contract and are identical in every adapter:

* a tool result `{status: "escalated", attempt_id}` parks the episode (INPUT_REQUIRED, attempts);
* an uncertain effect stops the episode (FAILED, EFFECT_OUTCOME_PENDING) for CP reconciliation;
* an applied `helm_work_report` ends it (COMPLETED);
* a successful `helm_work_delegate` / `helm_work_request_input` parks it on children / input;
* ending without an applied report is FAILED (NO_REPORT).

Adapters feed every MCP tool result to `OutcomeTracker.observe` and stop their agent loop when
the returned observation says so.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from .constants import (
    DELEGATE_TOOL,
    PROPOSAL_SCHEMA,
    REPORT_SCHEMA,
    REPORT_TOOL,
    REQUEST_INPUT_TOOL,
)
from .status import status_payload

Kind = Literal["ok", "error", "escalated"]

# Result statuses that cannot establish a successful effect.
_NOT_APPLIED = frozenset(
    {
        "denied",
        "failed",
        "error",
        "rejected",
        "escalated",
        "expired",
        "cancelled",
        "canceled",
    }
)
_CHILD_ID_KEYS = ("work_id", "child_id", "work_item_id", "id")
_REPORT_STATUSES = ("done", "blocked", "failed")


@dataclass(frozen=True, slots=True)
class ToolResult:
    """An MCP tool result reduced to what the rules need."""

    is_error: bool = False
    structured: Any = None
    text: str | None = None


def result_payload(result: ToolResult) -> dict[str, Any] | None:
    """The result as a JSON object: structuredContent, else the text content parsed as JSON."""
    if isinstance(result.structured, dict):
        return result.structured
    text = (result.text or "").strip()
    if text.startswith("{"):
        try:
            parsed = json.loads(text)
        except ValueError:
            return None
        if isinstance(parsed, dict):
            return parsed
    return None


@dataclass(frozen=True, slots=True)
class Observation:
    kind: Kind
    # True when the agent loop must stop now (after the current tool batch, where the framework
    # groups tool calls into batches).
    stop: bool = False
    reason: (
        Literal[
            "escalated", "reported", "delegated", "input_requested", "effect_pending", "reviewed"
        ]
        | None
    ) = None
    # helm.proposal.v1 mirror of this call (None for helm_work_report).
    proposal: dict[str, Any] | None = None
    # helm.report.v1 mirror when this call was helm_work_report.
    report: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class Outcome:
    state: Literal["completed", "input_required", "failed"]
    text: str
    status: dict[str, Any]


def _lower_status(payload: Mapping[str, Any] | None) -> str | None:
    value = payload.get("status") if payload else None
    return value.lower() if isinstance(value, str) else None


def _child_id(payload: Mapping[str, Any] | None) -> str | None:
    if not payload:
        return None
    for source in (payload, payload.get("child"), payload.get("result")):
        if isinstance(source, Mapping):
            for key in _CHILD_ID_KEYS:
                value = source.get(key)
                if isinstance(value, str) and value:
                    return value
    return None


@dataclass(slots=True)
class OutcomeTracker:
    attempts: list[str] = field(default_factory=list)
    children: list[str] = field(default_factory=list)
    delegated: bool = False
    input: dict[str, Any] | None = None
    report: dict[str, Any] | None = None
    effect_pending: bool = False
    review_target: str | None = None
    review: dict[str, str] | None = None

    @property
    def stopped(self) -> bool:
        return (
            self.effect_pending
            or bool(self.attempts)
            or self.delegated
            or self.input is not None
            or self.report is not None
            or self.review is not None
        )

    def observe(self, tool: str, arguments: object, result: ToolResult) -> Observation:
        args: dict[str, Any] = arguments if isinstance(arguments, dict) else {}
        # Native MCP wraps effect data in {target, arguments}. Keep the full
        # proposal for evidence, but mirror report/input fields from that data.
        values = args
        if "target" in args and "arguments" in args:
            values = args["arguments"] if isinstance(args["arguments"], dict) else {}
        payload = result_payload(result)
        status = _lower_status(payload)
        attempt_id = payload.get("attempt_id") if payload else None

        if status in ("reconciling", "unknown"):
            self.effect_pending = True
            # A missing ID is not evidence that nothing happened. Stop anyway;
            # CP retains the episode and can inspect its gateway attempts.
            ref = attempt_id if isinstance(attempt_id, str) and attempt_id else None
            return Observation(
                "error", True, "effect_pending", self._proposal(tool, args, "error", ref)
            )

        kind: Kind
        if status == "escalated" and isinstance(attempt_id, str) and attempt_id:
            kind = "escalated"
        elif result.is_error or status in _NOT_APPLIED:
            kind = "error"
        else:
            kind = "ok"

        if kind == "escalated":
            assert isinstance(attempt_id, str)
            if attempt_id not in self.attempts:
                self.attempts.append(attempt_id)
            return Observation(
                kind, True, "escalated", self._proposal(tool, args, kind, attempt_id)
            )

        if tool == "helm_work_review" and self.review_target is not None:
            review_reason = values.get("reason")
            if (
                kind == "ok"
                and status == "succeeded"
                and isinstance(attempt_id, str)
                and attempt_id
                and args.get("target") == self.review_target
                and _child_id(payload) == self.review_target.removeprefix("work:")
                and values.get("decision") in ("accept", "reject")
                and isinstance(review_reason, str)
                and review_reason.strip()
                and len(review_reason) <= 65536
            ):
                self.review = {
                    "target": self.review_target,
                    "decision": values["decision"],
                    "reason": review_reason,
                }
                return Observation(
                    kind, True, "reviewed", self._proposal(tool, args, kind, attempt_id)
                )

        if tool == REPORT_TOOL:
            mirror = self._report_mirror(values)
            if kind == "ok" and mirror is not None:
                self.report = {"status": mirror["status"], "summary": mirror["summary"]}
                return Observation(kind, True, "reported", report=mirror)
            return Observation(kind, report=mirror)

        stop = False
        reason: Literal["delegated", "input_requested"] | None = None
        if kind == "ok" and tool == DELEGATE_TOOL:
            child = _child_id(payload)
            if child and child not in self.children:
                self.children.append(child)
            self.delegated = True
            stop, reason = True, "delegated"
        elif kind == "ok" and tool == REQUEST_INPUT_TOOL:
            options = values.get("options")
            self.input = {
                "question": str(values.get("question") or "").strip() or "input requested",
                "options": [str(item) for item in options] if isinstance(options, list) else [],
            }
            stop, reason = True, "input_requested"
        return Observation(kind, stop, reason, self._proposal(tool, args, kind, None))

    @staticmethod
    def _proposal(
        tool: str, args: dict[str, Any], kind: Kind, attempt_id: str | None
    ) -> dict[str, Any]:
        proposal: dict[str, Any] = {
            "schema": PROPOSAL_SCHEMA,
            "tool": tool,
            "arguments": args,
            "status": "succeeded" if kind == "ok" else kind,
        }
        if attempt_id:
            proposal["attempt_id"] = attempt_id
        return proposal

    @staticmethod
    def _report_mirror(args: dict[str, Any]) -> dict[str, Any] | None:
        status = args.get("status")
        if status not in _REPORT_STATUSES:
            return None
        mirror: dict[str, Any] = {
            "schema": REPORT_SCHEMA,
            "status": status,
            "summary": str(args.get("summary") or ""),
        }
        outputs = args.get("outputs")
        if isinstance(outputs, list):
            mirror["outputs"] = [
                {"kind": str(o["kind"]), "ref": str(o["ref"])}
                for o in outputs
                if isinstance(o, dict) and o.get("kind") and o.get("ref")
            ]
        return mirror

    def outcome(self, last_text: str = "") -> Outcome:
        """The terminal A2A state for a loop that ended normally.

        Uncertain effects require reconciliation before any continuation. Otherwise approvals
        take priority over reports; then children / input park it, or the report is missing.
        """
        if self.effect_pending:
            message = (
                "A gateway effect is still being confirmed. The episode stopped; "
                "resolve the original attempt before retrying work."
            )
            return Outcome(
                "failed", message, status_payload(error=("EFFECT_OUTCOME_PENDING", message))
            )
        if self.attempts:
            waiting: dict[str, Any] = {"attempts": list(self.attempts)}
            if self.delegated:
                waiting["children"] = list(self.children)
            if self.input is not None:
                waiting["input"] = self.input
            return Outcome(
                "input_required",
                f"Waiting for a human decision on {len(self.attempts)} escalated attempt(s).",
                status_payload(waiting_on=waiting),
            )
        if self.report is not None and self.review_target is None:
            return Outcome(
                "completed",
                self.report["summary"] or f"Reported {self.report['status']}.",
                status_payload(report=self.report),
            )
        if self.delegated or self.input is not None:
            waiting = {}
            if self.delegated:
                waiting["children"] = list(self.children)
            if self.input is not None:
                waiting["input"] = self.input
            return Outcome(
                "input_required",
                "Waiting for delegated work." if self.delegated else "Waiting for an answer.",
                status_payload(waiting_on=waiting),
            )
        if self.review_target is not None:
            if self.review is not None:
                return Outcome(
                    "completed", self.review["reason"], status_payload(review=self.review)
                )
            message = "The evaluator finished without an applied review of its bound target."
            return Outcome("failed", message, status_payload(error=("NO_REVIEW", message)))
        detail = f" Last message: {last_text.strip()[:500]}" if last_text.strip() else ""
        message = f"The agent finished without an applied {REPORT_TOOL}.{detail}"
        return Outcome("failed", message, status_payload(error=("NO_REPORT", message)))
