"""Direct HELM AI Kernel preflight wrappers.

This module is intentionally small: it normalizes a proposed tool action,
submits it to `POST /api/v1/evaluate`, and dispatches only on ALLOW.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from functools import wraps
from typing import Any, Awaitable, Callable, Mapping, Optional, TypeVar, Union, cast

InputT = TypeVar("InputT")
OutputT = TypeVar("OutputT")
Transport = Callable[[str, Mapping[str, Any], float], tuple[int, Mapping[str, Any], Mapping[str, str]]]

DEFAULT_HELM_URL = "http://127.0.0.1:7715"
DEFAULT_PRINCIPAL = "helm-agent-integrations"


@dataclass(frozen=True)
class HelmDecision:
    verdict: str
    id: Optional[str] = None
    decision_id: Optional[str] = None
    reason: Optional[str] = None
    reason_code: Optional[str] = None
    receipt_id: Optional[str] = None
    raw: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class HelmReceiptRef:
    receipt_id: Optional[str] = None
    decision_id: Optional[str] = None
    reason_code: Optional[str] = None
    status: Optional[str] = None


@dataclass(frozen=True)
class HelmBoundaryResult:
    allowed: bool
    dispatched: bool
    verdict: str
    decision: HelmDecision
    receipt: Optional[HelmReceiptRef] = None
    output: Any = None
    raw: Any = None


@dataclass(frozen=True)
class BoundaryIntent:
    action_urn: str
    input: Any
    principal: Optional[str] = None
    risk_class: Optional[str] = None
    effect_class: Optional[str] = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


class HelmBoundaryError(RuntimeError):
    """Raised when HELM cannot be reached or returns a transport error."""

    def __init__(self, message: str, status: Optional[int] = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


def _normalize_url(url: Optional[str]) -> str:
    return (url or DEFAULT_HELM_URL).rstrip("/")


def _default_transport(url: str, payload: Mapping[str, Any], timeout: float) -> tuple[int, Mapping[str, Any], Mapping[str, str]]:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
            headers = {key.lower(): value for key, value in response.headers.items()}
            return response.status, cast(Mapping[str, Any], body), headers
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            body = {"error": raw}
        raise HelmBoundaryError(f"HELM preflight failed with HTTP {exc.code}", exc.code, body) from exc
    except urllib.error.URLError as exc:
        raise HelmBoundaryError(f"HELM preflight transport failed: {exc}") from exc


def _record(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _decision_from_payload(payload: Mapping[str, Any]) -> HelmDecision:
    candidate = _record(payload.get("decision") or payload.get("record") or payload.get("result") or payload)
    verdict = str(candidate.get("verdict") or candidate.get("status") or payload.get("verdict") or "DENY").upper()
    return HelmDecision(
        verdict=verdict,
        id=cast(Optional[str], candidate.get("id")),
        decision_id=cast(Optional[str], candidate.get("decision_id") or payload.get("decision_id")),
        reason=cast(Optional[str], candidate.get("reason") or payload.get("reason")),
        reason_code=cast(Optional[str], candidate.get("reason_code") or payload.get("reason_code")),
        receipt_id=cast(Optional[str], candidate.get("receipt_id") or payload.get("receipt_id")),
        raw=dict(candidate),
    )


def _receipt_from(decision: HelmDecision, headers: Mapping[str, str]) -> Optional[HelmReceiptRef]:
    receipt_id = headers.get("x-helm-receipt-id") or decision.receipt_id
    decision_id = headers.get("x-helm-decision-id") or decision.decision_id or decision.id
    reason_code = headers.get("x-helm-reason-code") or decision.reason_code
    status = headers.get("x-helm-status") or decision.verdict
    if not any([receipt_id, decision_id, reason_code, status]):
        return None
    return HelmReceiptRef(
        receipt_id=receipt_id,
        decision_id=decision_id,
        reason_code=reason_code,
        status=status,
    )


def preflight_action(
    *,
    action_urn: str,
    input: Any,
    helm_url: Optional[str] = None,
    principal: Optional[str] = None,
    risk_class: Optional[str] = None,
    effect_class: Optional[str] = None,
    metadata: Optional[Mapping[str, Any]] = None,
    timeout: float = 30.0,
    transport: Optional[Transport] = None,
) -> HelmBoundaryResult:
    """Submit a direct HELM evaluate request without dispatching a tool."""

    payload: Mapping[str, Any] = {
        "principal": principal or DEFAULT_PRINCIPAL,
        "action": "EXECUTE_TOOL",
        "resource": action_urn,
        "context": {
            "action_urn": action_urn,
            "risk_class": risk_class,
            "effect_class": effect_class,
            "arguments": input,
            "metadata": dict(metadata or {}),
        },
    }
    url = f"{_normalize_url(helm_url)}/api/v1/evaluate"
    status, body, headers = (transport or _default_transport)(url, payload, timeout)
    if status >= 400:
        raise HelmBoundaryError(f"HELM preflight failed with HTTP {status}", status, body)
    decision = _decision_from_payload(body)
    return HelmBoundaryResult(
        allowed=decision.verdict == "ALLOW",
        dispatched=False,
        verdict=decision.verdict,
        decision=decision,
        receipt=_receipt_from(decision, headers),
        raw=body,
    )


def _call_input(args: tuple[Any, ...], kwargs: Mapping[str, Any]) -> Any:
    if len(args) == 1 and not kwargs:
        return args[0]
    return {"args": list(args), "kwargs": dict(kwargs)}


def with_helm_boundary(
    *,
    action_urn: str,
    helm_url: Optional[str] = None,
    principal: Optional[str] = None,
    risk_class: Optional[str] = None,
    effect_class: Optional[str] = None,
    metadata: Optional[Mapping[str, Any]] = None,
    timeout: float = 30.0,
    transport: Optional[Transport] = None,
) -> Callable[[Callable[..., Union[OutputT, Awaitable[OutputT]]]], Callable[..., Union[HelmBoundaryResult, Awaitable[HelmBoundaryResult]]]]:
    """Decorate a function so it dispatches only after a HELM ALLOW verdict."""

    def decorate(fn: Callable[..., Union[OutputT, Awaitable[OutputT]]]) -> Callable[..., Union[HelmBoundaryResult, Awaitable[HelmBoundaryResult]]]:
        if inspect.iscoroutinefunction(fn):

            @wraps(fn)
            async def async_wrapped(*args: Any, **kwargs: Any) -> HelmBoundaryResult:
                proposed_input = _call_input(args, kwargs)
                preflight = preflight_action(
                    action_urn=action_urn,
                    input=proposed_input,
                    helm_url=helm_url,
                    principal=principal,
                    risk_class=risk_class,
                    effect_class=effect_class,
                    metadata=metadata,
                    timeout=timeout,
                    transport=transport,
                )
                if not preflight.allowed:
                    return preflight
                output = await cast(Callable[..., Awaitable[OutputT]], fn)(*args, **kwargs)
                return HelmBoundaryResult(
                    allowed=True,
                    dispatched=True,
                    verdict=preflight.verdict,
                    decision=preflight.decision,
                    receipt=preflight.receipt,
                    output=output,
                    raw=preflight.raw,
                )

            return async_wrapped

        @wraps(fn)
        def wrapped(*args: Any, **kwargs: Any) -> HelmBoundaryResult:
            proposed_input = _call_input(args, kwargs)
            preflight = preflight_action(
                action_urn=action_urn,
                input=proposed_input,
                helm_url=helm_url,
                principal=principal,
                risk_class=risk_class,
                effect_class=effect_class,
                metadata=metadata,
                timeout=timeout,
                transport=transport,
            )
            if not preflight.allowed:
                return preflight
            output = cast(Callable[..., OutputT], fn)(*args, **kwargs)
            return HelmBoundaryResult(
                allowed=True,
                dispatched=True,
                verdict=preflight.verdict,
                decision=preflight.decision,
                receipt=preflight.receipt,
                output=output,
                raw=preflight.raw,
            )

        return wrapped

    return decorate


def _intent(
    action_urn: str,
    input_value: Any,
    metadata: Mapping[str, Any],
    *,
    principal: Optional[str] = None,
    risk_class: Optional[str] = None,
    effect_class: Optional[str] = None,
) -> BoundaryIntent:
    return BoundaryIntent(
        action_urn=action_urn,
        input=input_value,
        principal=principal,
        risk_class=risk_class,
        effect_class=effect_class,
        metadata=metadata,
    )


def from_hermes_tool_call(call: Mapping[str, Any]) -> BoundaryIntent:
    tool_name = str(call.get("tool_name") or call.get("name") or "unknown")
    return _intent(
        f"tool.hermes.{tool_name}",
        call.get("arguments", call.get("args", {})),
        {
            "framework": "hermes",
            "profile": call.get("profile"),
            "task_id": call.get("task_id"),
            "run_id": call.get("run_id"),
        },
    )


def from_openclaw_skill_call(call: Mapping[str, Any]) -> BoundaryIntent:
    action = str(call.get("action") or call.get("skill") or "unknown")
    return _intent(
        f"tool.openclaw.{action}",
        call.get("input", call.get("args", {})),
        {
            "framework": "openclaw",
            "skill": call.get("skill"),
            "user_id": call.get("user_id"),
            "conversation_id": call.get("conversation_id"),
        },
    )


def from_mastra_tool_call(call: Mapping[str, Any]) -> BoundaryIntent:
    tool_name = str(call.get("toolName") or call.get("toolId") or "unknown")
    return _intent(
        f"tool.mastra.{tool_name}",
        call.get("args", call.get("input", {})),
        {"framework": "mastra", "run_id": call.get("runId"), "agent_id": call.get("agentId")},
    )


def from_browser_use_action(call: Mapping[str, Any]) -> BoundaryIntent:
    action = str(call.get("action") or "browser.action")
    return _intent(
        f"tool.browser_use.{action}",
        {"url": call.get("url"), "form": call.get("form")},
        {"framework": "browser-use", "url": call.get("url"), **_record(call.get("metadata"))},
        risk_class="T2",
        effect_class="IRREVERSIBLE",
    )


def from_e2b_execution(call: Mapping[str, Any]) -> BoundaryIntent:
    return _intent(
        "tool.e2b.execute",
        dict(call),
        {
            "framework": "e2b",
            "language": call.get("language"),
            "network": call.get("network"),
            **_record(call.get("metadata")),
        },
        risk_class="T2",
        effect_class="REVERSIBLE",
    )


def from_composio_action(call: Mapping[str, Any]) -> BoundaryIntent:
    app = str(call.get("app") or "unknown")
    action = str(call.get("action") or "unknown")
    return _intent(
        f"tool.composio.{app}.{action}",
        call.get("payload", {}),
        {
            "framework": "composio",
            "app": app,
            "action": action,
            "connected_account_id": call.get("connected_account_id"),
            **_record(call.get("metadata")),
        },
    )


async def run_async_result(value: Union[HelmBoundaryResult, Awaitable[HelmBoundaryResult]]) -> HelmBoundaryResult:
    """Test helper for callers that accept sync or async wrapped functions."""

    if inspect.isawaitable(value):
        return await cast(Awaitable[HelmBoundaryResult], value)
    return cast(HelmBoundaryResult, value)


def run_result(value: Union[HelmBoundaryResult, Awaitable[HelmBoundaryResult]]) -> HelmBoundaryResult:
    """Synchronously resolve a wrapper result for examples and tests."""

    if inspect.isawaitable(value):
        return asyncio.run(cast(Awaitable[HelmBoundaryResult], value))
    return cast(HelmBoundaryResult, value)
