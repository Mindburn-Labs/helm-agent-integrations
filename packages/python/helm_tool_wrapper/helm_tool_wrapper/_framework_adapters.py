"""Normalize framework calls into proposed HELM tool actions."""

from __future__ import annotations

from typing import Any, Mapping, Optional, cast

from ._intent import (
    TRUSTED_AGENT_EFFECT_CLASS,
    TRUSTED_AGENT_RISK_CLASS,
    BoundaryIntent,
    _record,
    _without_authority_metadata,
)


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
