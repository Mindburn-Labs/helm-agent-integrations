"""Direct HELM AI Kernel preflight wrappers.

This module is intentionally small: it normalizes a proposed tool action,
submits it to `POST /api/v1/evaluate`, and dispatches only on ALLOW.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from functools import wraps
from typing import Any, Awaitable, Callable, Mapping, Optional, TypeVar, Union, cast

InputT = TypeVar("InputT")
OutputT = TypeVar("OutputT")
Transport = Callable[
    [str, Mapping[str, Any], float, Mapping[str, str]],
    tuple[int, Mapping[str, Any], Mapping[str, str]],
]
EvidenceTransport = Callable[
    [str, Mapping[str, Any], float, Mapping[str, str]],
    tuple[int, bytes, Mapping[str, str]],
]

DEFAULT_HELM_URL = "http://127.0.0.1:7714"
TRUSTED_AGENT_RISK_CLASS = "T2"
TRUSTED_AGENT_EFFECT_CLASS = "E4"
SUPPORTED_RISK_CLASSES = frozenset({"T0", "T1", "T2", "T3"})
SUPPORTED_EFFECT_CLASSES = frozenset({"E0", "E1", "E2", "E3", "E4"})
UNTRUSTED_AUTHORITY_METADATA = frozenset(
    {
        "principal",
        "agent_id",
        "tenant_id",
        "risk_class",
        "riskClass",
        "effect_class",
        "effectClass",
    }
)


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
class HelmEvidencePackRef:
    """Authenticated, content-addressed preflight EvidencePack export.

    The pack contains receipts available immediately after preflight. It does
    not attest to the later tool output.
    """

    evidence_hash: str
    content: bytes
    content_type: Optional[str] = None


@dataclass(frozen=True)
class HelmBoundaryResult:
    allowed: bool
    dispatched: bool
    verdict: str
    decision: HelmDecision
    receipt: Optional[HelmReceiptRef] = None
    output: Any = None
    raw: Any = None
    evidence_pack: Optional[HelmEvidencePackRef] = None


@dataclass(frozen=True)
class BoundaryIntent:
    action_urn: str
    input: Any
    session_id: Optional[str] = None
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


def _resolve_evaluate_api_key(api_key: Optional[str], service_token: Optional[str]) -> str:
    if service_token and service_token.strip():
        raise HelmBoundaryError(
            "HELM service_token is not authorized for tenant-scoped /api/v1/evaluate; "
            "configure api_key"
        )
    normalized = (api_key or "").strip()
    if not normalized:
        raise HelmBoundaryError("HELM api_key is required for tenant-scoped /api/v1/evaluate")
    return normalized


def _require_value(value: Optional[str], name: str) -> str:
    normalized = (value or "").strip()
    if not normalized:
        raise HelmBoundaryError(f"HELM {name} is required")
    return normalized


def _normalize_classification(
    value: Optional[str],
    fallback: str,
    supported: frozenset[str],
    name: str,
) -> str:
    normalized = (value or "").strip().upper() or fallback
    if normalized not in supported:
        raise HelmBoundaryError(f"Unsupported HELM {name} {value!r}")
    return normalized


def _default_transport(
    url: str,
    payload: Mapping[str, Any],
    timeout: float,
    headers: Mapping[str, str],
) -> tuple[int, Mapping[str, Any], Mapping[str, str]]:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers=dict(headers),
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
            response_headers = {key.lower(): value for key, value in response.headers.items()}
            return response.status, cast(Mapping[str, Any], body), response_headers
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            body = {"error": raw}
        raise HelmBoundaryError(
            f"HELM preflight failed with HTTP {exc.code}", exc.code, body
        ) from exc
    except urllib.error.URLError as exc:
        raise HelmBoundaryError(f"HELM preflight transport failed: {exc}") from exc


def _default_evidence_transport(
    url: str,
    payload: Mapping[str, Any],
    timeout: float,
    headers: Mapping[str, str],
) -> tuple[int, bytes, Mapping[str, str]]:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers=dict(headers),
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read()
            response_headers = {key.lower(): value for key, value in response.headers.items()}
            return response.status, body, response_headers
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            error_body: Any = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            error_body = raw
        raise HelmBoundaryError(
            f"HELM evidence export failed with HTTP {exc.code}", exc.code, error_body
        ) from exc
    except urllib.error.URLError as exc:
        raise HelmBoundaryError(f"HELM evidence export transport failed: {exc}") from exc


def _record(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _without_authority_metadata(value: Any) -> Mapping[str, Any]:
    return {
        key: item for key, item in _record(value).items() if key not in UNTRUSTED_AUTHORITY_METADATA
    }


def _normalized_string(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    return value.strip() or None


def _canonical_verdict(value: Any) -> str:
    return (_normalized_string(value) or "DENY").upper()


def _decision_from_payload(payload: Mapping[str, Any]) -> HelmDecision:
    candidate = _record(
        payload.get("decision") or payload.get("record") or payload.get("result") or payload
    )
    verdict = _canonical_verdict(
        candidate.get("verdict") or candidate.get("status") or payload.get("verdict")
    )
    return HelmDecision(
        verdict=verdict,
        id=_normalized_string(candidate.get("id")),
        decision_id=_normalized_string(candidate.get("decision_id"))
        or _normalized_string(payload.get("decision_id")),
        reason=_normalized_string(candidate.get("reason"))
        or _normalized_string(payload.get("reason")),
        reason_code=_normalized_string(candidate.get("reason_code"))
        or _normalized_string(payload.get("reason_code")),
        receipt_id=_normalized_string(candidate.get("receipt_id"))
        or _normalized_string(payload.get("receipt_id")),
        raw=dict(candidate),
    )


def _receipt_from(decision: HelmDecision, headers: Mapping[str, str]) -> Optional[HelmReceiptRef]:
    header_receipt_id = _normalized_string(headers.get("x-helm-receipt-id"))
    body_receipt_id = _normalized_string(decision.receipt_id)
    if header_receipt_id and body_receipt_id and header_receipt_id != body_receipt_id:
        raise HelmBoundaryError("HELM evaluate response has conflicting receipt_id values")
    header_verdict = _normalized_string(headers.get("x-helm-verdict"))
    response_status = _normalized_string(headers.get("x-helm-status"))
    for explicit_verdict in (header_verdict, response_status):
        if explicit_verdict and _canonical_verdict(explicit_verdict) != _canonical_verdict(
            decision.verdict
        ):
            raise HelmBoundaryError("HELM evaluate response has conflicting verdict values")
    header_status = header_verdict or response_status
    receipt_id = header_receipt_id or body_receipt_id
    decision_id = (
        _normalized_string(headers.get("x-helm-decision-id"))
        or _normalized_string(decision.decision_id)
        or _normalized_string(decision.id)
    )
    reason_code = _normalized_string(headers.get("x-helm-reason-code")) or _normalized_string(
        decision.reason_code
    )
    status = _canonical_verdict(header_status or decision.verdict)
    if not receipt_id:
        return None
    return HelmReceiptRef(
        receipt_id=receipt_id,
        decision_id=decision_id,
        reason_code=reason_code,
        status=status,
    )


def _authenticated_headers(
    auth_token: str,
    tenant_id: str,
    principal: str,
    workspace_id: Optional[str],
) -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {auth_token}",
        "Content-Type": "application/json",
        "X-Helm-Tenant-ID": tenant_id,
        "X-Helm-Principal-ID": principal,
    }
    normalized_workspace_id = (workspace_id or "").strip()
    if normalized_workspace_id:
        headers["X-Helm-Workspace-ID"] = normalized_workspace_id
    return headers


def export_evidence_pack(
    *,
    session_id: str,
    tenant_id: str,
    principal: str,
    workspace_id: Optional[str] = None,
    api_key: Optional[str] = None,
    service_token: Optional[str] = None,
    helm_url: Optional[str] = None,
    timeout: float = 30.0,
    transport: Optional[EvidenceTransport] = None,
) -> HelmEvidencePackRef:
    """Export and hash-check the current session's authenticated EvidencePack."""

    auth_token = _resolve_evaluate_api_key(api_key, service_token)
    normalized_session_id = _require_value(session_id, "session_id")
    normalized_tenant_id = _require_value(tenant_id, "tenant_id")
    normalized_principal = _require_value(principal, "principal")
    url = f"{_normalize_url(helm_url)}/api/v1/evidence/export"
    status, content, response_headers = (transport or _default_evidence_transport)(
        url,
        {"session_id": normalized_session_id, "format": "tar.gz"},
        timeout,
        _authenticated_headers(
            auth_token,
            normalized_tenant_id,
            normalized_principal,
            workspace_id,
        ),
    )
    if not 200 <= status < 300:
        raise HelmBoundaryError(f"HELM evidence export failed with HTTP {status}", status, content)

    evidence_hash = (response_headers.get("x-helm-evidence-hash") or "").strip().lower()
    prefix = "sha256:"
    hex_digest = evidence_hash.removeprefix(prefix)
    if (
        not evidence_hash.startswith(prefix)
        or len(hex_digest) != 64
        or any(character not in "0123456789abcdef" for character in hex_digest)
    ):
        raise HelmBoundaryError("HELM evidence export is missing a valid X-Helm-Evidence-Hash")
    actual_hash = f"sha256:{hashlib.sha256(content).hexdigest()}"
    if evidence_hash != actual_hash:
        raise HelmBoundaryError(
            "HELM evidence export hash mismatch",
            status,
            {"expected": evidence_hash, "actual": actual_hash},
        )
    return HelmEvidencePackRef(
        evidence_hash=evidence_hash,
        content=content,
        content_type=response_headers.get("content-type"),
    )


def preflight_action(
    *,
    action_urn: str,
    input: Any,
    session_id: str,
    tenant_id: str,
    principal: str,
    workspace_id: Optional[str] = None,
    api_key: Optional[str] = None,
    service_token: Optional[str] = None,
    helm_url: Optional[str] = None,
    risk_class: Optional[str] = None,
    effect_class: Optional[str] = None,
    metadata: Optional[Mapping[str, Any]] = None,
    export_evidence: bool = False,
    timeout: float = 30.0,
    transport: Optional[Transport] = None,
    evidence_transport: Optional[EvidenceTransport] = None,
) -> HelmBoundaryResult:
    """Submit a direct HELM evaluate request without dispatching a tool."""

    auth_token = _resolve_evaluate_api_key(api_key, service_token)
    normalized_action_urn = _require_value(action_urn, "action_urn")
    normalized_session_id = _require_value(session_id, "session_id")
    normalized_tenant_id = _require_value(tenant_id, "tenant_id")
    normalized_principal = _require_value(principal, "principal")
    normalized_risk_class = _normalize_classification(
        risk_class,
        TRUSTED_AGENT_RISK_CLASS,
        SUPPORTED_RISK_CLASSES,
        "risk_class",
    )
    normalized_effect_class = _normalize_classification(
        effect_class,
        TRUSTED_AGENT_EFFECT_CLASS,
        SUPPORTED_EFFECT_CLASSES,
        "effect_class",
    )
    payload: Mapping[str, Any] = {
        "principal": normalized_principal,
        "action": "EXECUTE_TOOL",
        "resource": normalized_action_urn,
        "tool": "EXECUTE_TOOL",
        "args": input,
        "agent_id": normalized_principal,
        "effect_level": normalized_action_urn,
        "session_id": normalized_session_id,
        "context": {
            "tool": normalized_action_urn,
            "args": input,
            "arguments": input,
            "agent_id": normalized_principal,
            "effect_level": normalized_effect_class,
            "session_id": normalized_session_id,
            "action_urn": normalized_action_urn,
            "risk_class": normalized_risk_class,
            "effect_class": normalized_effect_class,
            "metadata": dict(metadata or {}),
        },
    }
    url = f"{_normalize_url(helm_url)}/api/v1/evaluate"
    request_headers = _authenticated_headers(
        auth_token,
        normalized_tenant_id,
        normalized_principal,
        workspace_id,
    )
    status, body, response_headers = (transport or _default_transport)(
        url,
        payload,
        timeout,
        request_headers,
    )
    if not 200 <= status < 300:
        raise HelmBoundaryError(f"HELM preflight failed with HTTP {status}", status, body)
    decision = _decision_from_payload(body)
    receipt = _receipt_from(decision, response_headers)
    evidence_pack = None
    if export_evidence:
        if not receipt or not receipt.receipt_id:
            raise HelmBoundaryError(
                "HELM evidence export requires a receipt_id from the evaluate response"
            )
        evidence_pack = export_evidence_pack(
            session_id=normalized_session_id,
            tenant_id=normalized_tenant_id,
            principal=normalized_principal,
            workspace_id=workspace_id,
            api_key=api_key,
            service_token=service_token,
            helm_url=helm_url,
            timeout=timeout,
            transport=evidence_transport,
        )
    return HelmBoundaryResult(
        allowed=decision.verdict == "ALLOW",
        dispatched=False,
        verdict=decision.verdict,
        decision=decision,
        receipt=receipt,
        evidence_pack=evidence_pack,
        raw=body,
    )


def _call_input(args: tuple[Any, ...], kwargs: Mapping[str, Any]) -> Any:
    if len(args) == 1 and not kwargs:
        return args[0]
    return {"args": list(args), "kwargs": dict(kwargs)}


def with_helm_boundary(
    *,
    action_urn: str,
    session_id: str,
    tenant_id: str,
    principal: str,
    workspace_id: Optional[str] = None,
    api_key: Optional[str] = None,
    service_token: Optional[str] = None,
    helm_url: Optional[str] = None,
    risk_class: Optional[str] = None,
    effect_class: Optional[str] = None,
    metadata: Optional[Mapping[str, Any]] = None,
    export_evidence: bool = False,
    timeout: float = 30.0,
    transport: Optional[Transport] = None,
    evidence_transport: Optional[EvidenceTransport] = None,
) -> Callable[
    [Callable[..., Union[OutputT, Awaitable[OutputT]]]],
    Callable[..., Union[HelmBoundaryResult, Awaitable[HelmBoundaryResult]]],
]:
    """Decorate a function so it dispatches only after a HELM ALLOW verdict."""

    def decorate(
        fn: Callable[..., Union[OutputT, Awaitable[OutputT]]],
    ) -> Callable[..., Union[HelmBoundaryResult, Awaitable[HelmBoundaryResult]]]:
        if inspect.iscoroutinefunction(fn):

            @wraps(fn)
            async def async_wrapped(*args: Any, **kwargs: Any) -> HelmBoundaryResult:
                proposed_input = _call_input(args, kwargs)
                preflight = preflight_action(
                    action_urn=action_urn,
                    input=proposed_input,
                    session_id=session_id,
                    tenant_id=tenant_id,
                    principal=principal,
                    workspace_id=workspace_id,
                    api_key=api_key,
                    service_token=service_token,
                    helm_url=helm_url,
                    risk_class=risk_class,
                    effect_class=effect_class,
                    metadata=metadata,
                    export_evidence=export_evidence,
                    timeout=timeout,
                    transport=transport,
                    evidence_transport=evidence_transport,
                )
                if not preflight.allowed:
                    return preflight
                if not preflight.receipt or not preflight.receipt.receipt_id:
                    raise HelmBoundaryError(
                        "HELM ALLOW response is missing the durable receipt_id required before dispatch"
                    )
                output = await cast(Callable[..., Awaitable[OutputT]], fn)(*args, **kwargs)
                return HelmBoundaryResult(
                    allowed=True,
                    dispatched=True,
                    verdict=preflight.verdict,
                    decision=preflight.decision,
                    receipt=preflight.receipt,
                    evidence_pack=preflight.evidence_pack,
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
                session_id=session_id,
                tenant_id=tenant_id,
                principal=principal,
                workspace_id=workspace_id,
                api_key=api_key,
                service_token=service_token,
                helm_url=helm_url,
                risk_class=risk_class,
                effect_class=effect_class,
                metadata=metadata,
                export_evidence=export_evidence,
                timeout=timeout,
                transport=transport,
                evidence_transport=evidence_transport,
            )
            if not preflight.allowed:
                return preflight
            if not preflight.receipt or not preflight.receipt.receipt_id:
                raise HelmBoundaryError(
                    "HELM ALLOW response is missing the durable receipt_id required before dispatch"
                )
            output = cast(Callable[..., OutputT], fn)(*args, **kwargs)
            return HelmBoundaryResult(
                allowed=True,
                dispatched=True,
                verdict=preflight.verdict,
                decision=preflight.decision,
                receipt=preflight.receipt,
                evidence_pack=preflight.evidence_pack,
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
    session_id: Optional[str] = None,
    principal: Optional[str] = None,
    risk_class: Optional[str] = None,
    effect_class: Optional[str] = None,
) -> BoundaryIntent:
    return BoundaryIntent(
        action_urn=action_urn,
        input=input_value,
        session_id=session_id,
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


def from_codex_tool_call(call: Mapping[str, Any]) -> BoundaryIntent:
    tool_name = str(
        call.get("tool_name") or call.get("name") or call.get("recipient_name") or "unknown"
    )
    return _intent(
        f"tool.codex.{tool_name}",
        call.get("arguments", call.get("parameters", call.get("input", call.get("payload", {})))),
        {
            **_without_authority_metadata(call.get("metadata")),
            "framework": "codex",
            "tool_name": tool_name,
            "session_id": call.get("session_id"),
            "thread_id": call.get("thread_id"),
            "worktree": call.get("worktree"),
        },
        session_id=cast(Optional[str], call.get("session_id")),
        risk_class=TRUSTED_AGENT_RISK_CLASS,
        effect_class=TRUSTED_AGENT_EFFECT_CLASS,
    )


def from_claude_tool_call(call: Mapping[str, Any]) -> BoundaryIntent:
    tool_name = str(call.get("tool_name") or call.get("name") or "unknown")
    return _intent(
        f"tool.claude.{tool_name}",
        call.get("tool_input", call.get("input", call.get("arguments", {}))),
        {
            **_without_authority_metadata(call.get("metadata")),
            "framework": "claude",
            "tool_name": tool_name,
            "tool_use_id": call.get("tool_use_id") or call.get("id"),
            "session_id": call.get("session_id"),
            "transcript_path": call.get("transcript_path"),
        },
        session_id=cast(Optional[str], call.get("session_id")),
        risk_class=TRUSTED_AGENT_RISK_CLASS,
        effect_class=TRUSTED_AGENT_EFFECT_CLASS,
    )


def from_browser_use_action(call: Mapping[str, Any]) -> BoundaryIntent:
    action = str(call.get("action") or "browser.action")
    return _intent(
        f"tool.browser_use.{action}",
        {"url": call.get("url"), "form": call.get("form")},
        {"framework": "browser-use", "url": call.get("url"), **_record(call.get("metadata"))},
        risk_class="T2",
        effect_class="E4",
    )


def _tinyfish_metadata(endpoint_family: str, metadata: Any = None) -> Mapping[str, Any]:
    return {
        "framework": "tinyfish",
        "connector_id": "tinyfish-web-v1",
        "endpoint_family": endpoint_family,
        **_record(metadata),
    }


def from_tinyfish_search(call: Mapping[str, Any]) -> BoundaryIntent:
    return _intent(
        "tool.tinyfish.search.query",
        dict(call),
        _tinyfish_metadata("search", call.get("metadata")),
        risk_class="T2",
        effect_class="E2",
    )


def from_tinyfish_fetch(call: Mapping[str, Any]) -> BoundaryIntent:
    return _intent(
        "tool.tinyfish.fetch.extract",
        dict(call),
        _tinyfish_metadata("fetch", call.get("metadata")),
        risk_class="T2",
        effect_class="E2",
    )


def from_tinyfish_browser_session(call: Mapping[str, Any]) -> BoundaryIntent:
    return _intent(
        "tool.tinyfish.browser.session",
        dict(call),
        _tinyfish_metadata("browser", call.get("metadata")),
        risk_class="T2",
        effect_class="E3",
    )


def from_tinyfish_agent_run(call: Mapping[str, Any]) -> BoundaryIntent:
    action_intent = str(call.get("action_intent") or "").lower()
    external_intent = action_intent in {"submit", "purchase", "send", "publish"}
    external_action = bool(call.get("external_action")) or external_intent
    action_urn = (
        "tool.tinyfish.agent.external_action" if external_action else "tool.tinyfish.agent.run"
    )
    effect_class = "E4" if external_action else "E3"
    return _intent(
        action_urn,
        dict(call),
        _tinyfish_metadata(
            "agent",
            {
                "action_intent": call.get("action_intent"),
                "external_action": call.get("external_action"),
                **_record(call.get("metadata")),
            },
        ),
        risk_class="T2",
        effect_class=effect_class,
    )


# Camel-case aliases match the TypeScript helper names used in docs.
fromTinyFishSearch = from_tinyfish_search
fromTinyFishFetch = from_tinyfish_fetch
fromTinyFishBrowserSession = from_tinyfish_browser_session
fromTinyFishAgentRun = from_tinyfish_agent_run
fromCodexToolCall = from_codex_tool_call
fromClaudeToolCall = from_claude_tool_call


def normalize_e2b_network(value: Any) -> str:
    """Normalize raw E2B network capability metadata into a stable enum.

    E2B sandboxes have internet access enabled by default, so anything that is
    not an explicit opt-out normalizes to "external" (fail closed).
    """
    if value is False:
        return "isolated"
    if isinstance(value, str) and value.strip().lower() in {
        "none",
        "isolated",
        "offline",
        "disabled",
        "false",
    }:
        return "isolated"
    return "external"


def from_e2b_execution(call: Mapping[str, Any]) -> BoundaryIntent:
    network = normalize_e2b_network(call.get("network"))
    return _intent(
        "tool.e2b.execute",
        dict(call),
        {
            "framework": "e2b",
            "language": call.get("language"),
            "network": network,
            **_record(call.get("metadata")),
        },
        risk_class="T2",
        effect_class="E4" if network == "external" else "E3",
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


def normalize_daytona_network(params: Any) -> str:
    """Normalize Daytona sandbox network settings into a stable enum.

    Daytona sandboxes have network egress enabled by default. Only an explicit
    block-all opts out ("isolated"), and an explicit CIDR or domain allowlist
    narrows egress ("allowlisted"). Anything else fails closed to "external".
    """
    record = _record(params)
    if record.get("network_block_all") is True or record.get("networkBlockAll") is True:
        return "isolated"
    if (
        record.get("network_allow_list")
        or record.get("networkAllowList")
        or record.get("domain_allow_list")
        or record.get("domainAllowList")
    ):
        return "allowlisted"
    return "external"


def from_daytona_sandbox_create(call: Mapping[str, Any]) -> BoundaryIntent:
    network = normalize_daytona_network(call)
    return _intent(
        "tool.daytona.sandbox.create",
        dict(call),
        {
            "framework": "daytona",
            "sandbox_class": call.get("sandbox_class", call.get("class", "container")),
            "network": network,
            "target": call.get("target"),
            "ephemeral": call.get("auto_delete_interval") == 0,
            **_record(call.get("metadata")),
        },
        risk_class="T2",
        effect_class="E3" if network in {"isolated", "allowlisted"} else "E4",
    )


def from_daytona_process_exec(call: Mapping[str, Any]) -> BoundaryIntent:
    # The caller passes the owning sandbox's network settings alongside the
    # command; a missing capability record fails closed to "external".
    network = normalize_daytona_network(call)
    return _intent(
        "tool.daytona.process.exec",
        dict(call),
        {
            "framework": "daytona",
            "sandbox_id": call.get("sandbox_id"),
            "network": network,
            **_record(call.get("metadata")),
        },
        risk_class="T2",
        effect_class="E3" if network in {"isolated", "allowlisted"} else "E4",
    )


def from_daytona_ssh_grant(call: Mapping[str, Any]) -> BoundaryIntent:
    return _intent(
        "tool.daytona.sandbox.ssh_grant",
        dict(call),
        {
            "framework": "daytona",
            "sandbox_id": call.get("sandbox_id"),
            "access_channel": "ssh",
            **_record(call.get("metadata")),
        },
        risk_class="T2",
        effect_class="E4",
    )


fromDaytonaSandboxCreate = from_daytona_sandbox_create
fromDaytonaProcessExec = from_daytona_process_exec
fromDaytonaSshGrant = from_daytona_ssh_grant


async def run_async_result(
    value: Union[HelmBoundaryResult, Awaitable[HelmBoundaryResult]],
) -> HelmBoundaryResult:
    """Test helper for callers that accept sync or async wrapped functions."""

    if inspect.isawaitable(value):
        return await value
    return value


async def _await_result(value: Awaitable[HelmBoundaryResult]) -> HelmBoundaryResult:
    """Adapt a general awaitable to the coroutine required by ``asyncio.run``."""

    return await value


def run_result(
    value: Union[HelmBoundaryResult, Awaitable[HelmBoundaryResult]],
) -> HelmBoundaryResult:
    """Synchronously resolve a wrapper result for examples and tests."""

    if inspect.isawaitable(value):
        return asyncio.run(_await_result(value))
    return value
