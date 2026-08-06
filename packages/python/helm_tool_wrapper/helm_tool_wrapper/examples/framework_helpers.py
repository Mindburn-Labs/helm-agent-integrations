"""Run deterministic examples for every HELM framework intent normalizer.

Run with::

    python -m helm_tool_wrapper.examples.framework_helpers

These examples normalize representative provider call payloads and exercise
the versioned ``/api/v1/evaluate`` request contract with an in-process
transport double. They do not call a provider API, a live Kernel, or dispatch
an external effect.
"""

from __future__ import annotations

import json
from typing import Any, Mapping

from ..boundary import (
    BoundaryIntent,
    from_browser_use_action,
    from_claude_tool_call,
    from_codex_tool_call,
    from_composio_action,
    from_e2b_execution,
    from_hermes_tool_call,
    from_mastra_tool_call,
    from_openclaw_skill_call,
    from_tinyfish_agent_run,
    from_tinyfish_browser_session,
    from_tinyfish_fetch,
    from_tinyfish_search,
    preflight_action,
    run_result,
    with_helm_boundary,
)


FrameworkHelperExample = tuple[str, BoundaryIntent]


def framework_helper_examples() -> list[FrameworkHelperExample]:
    """Return one representative, non-dispatching intent per public helper."""

    return [
        (
            "Hermes",
            from_hermes_tool_call(
                {
                    "tool_name": "shell.exec",
                    "arguments": {"command": "pwd"},
                    "task_id": "task-demo-1",
                }
            ),
        ),
        (
            "OpenClaw",
            from_openclaw_skill_call(
                {
                    "skill": "mail",
                    "action": "send",
                    "input": {"to": "review@example.test", "subject": "Review"},
                }
            ),
        ),
        (
            "Mastra",
            from_mastra_tool_call(
                {"toolName": "create_ticket", "args": {"project": "HELM", "title": "Review effect"}}
            ),
        ),
        (
            "Codex",
            from_codex_tool_call(
                {
                    "recipient_name": "functions.exec_command",
                    "parameters": {"cmd": "git status --short"},
                    "session_id": "codex-demo-1",
                    "risk_class": "T0",
                    "effect_class": "E1",
                }
            ),
        ),
        (
            "Claude Code",
            from_claude_tool_call(
                {
                    "tool_name": "Bash",
                    "tool_input": {"command": "git status --short"},
                    "session_id": "claude-demo-1",
                    "risk_class": "T0",
                    "effect_class": "E1",
                }
            ),
        ),
        (
            "Browser Use",
            from_browser_use_action(
                {
                    "action": "submit",
                    "url": "https://shop.example.test/checkout",
                    "form": {"confirm": True},
                }
            ),
        ),
        ("TinyFish Search", from_tinyfish_search({"query": "HELM governed effects"})),
        (
            "TinyFish Fetch",
            from_tinyfish_fetch({"urls": ["https://example.test/source"], "ttl": 3600}),
        ),
        (
            "TinyFish Browser",
            from_tinyfish_browser_session(
                {"url": "https://portal.example.test", "credential_grant_ref": "grant:demo"}
            ),
        ),
        (
            "TinyFish Agent",
            from_tinyfish_agent_run(
                {
                    "url": "https://shop.example.test/checkout",
                    "goal": "Submit the saved cart",
                    "action_intent": "submit",
                }
            ),
        ),
        ("E2B", from_e2b_execution({"language": "python", "code": "print(1)"})),
        (
            "Composio",
            from_composio_action(
                {"app": "salesforce", "action": "export_records", "payload": {"object": "Lead"}}
            ),
        ),
    ]


def verify_framework_helper_examples() -> list[FrameworkHelperExample]:
    """Assert the public examples retain their conservative classifications."""

    examples = framework_helper_examples()
    assert len(examples) == 12, "all twelve framework helpers must stay runnable"
    expected = [
        ("Hermes", "tool.hermes.shell.exec", None, None),
        ("OpenClaw", "tool.openclaw.send", None, None),
        ("Mastra", "tool.mastra.create_ticket", None, None),
        ("Codex", "tool.codex.functions.exec_command", "T2", "E4"),
        ("Claude Code", "tool.claude.Bash", "T2", "E4"),
        ("Browser Use", "tool.browser_use.submit", "T2", "E4"),
        ("TinyFish Search", "tool.tinyfish.search.query", "T2", "E2"),
        ("TinyFish Fetch", "tool.tinyfish.fetch.extract", "T2", "E2"),
        ("TinyFish Browser", "tool.tinyfish.browser.session", "T2", "E3"),
        ("TinyFish Agent", "tool.tinyfish.agent.external_action", "T2", "E4"),
        ("E2B", "tool.e2b.execute", "T2", "E4"),
        ("Composio", "tool.composio.salesforce.export_records", None, None),
    ]
    for example, (helper, action_urn, risk_class, effect_class) in zip(examples, expected):
        actual_helper, intent = example
        assert actual_helper == helper
        assert intent.action_urn == action_urn
        assert intent.risk_class == risk_class
        assert intent.effect_class == effect_class

    codex = examples[3][1]
    assert codex.input == {"cmd": "git status --short"}
    assert "risk_class" not in codex.metadata, "caller downgrades must not survive normalization"

    e2b = examples[10][1]
    assert e2b.metadata["network"] == "external", "unknown E2B network capability must fail closed"
    return examples


def verify_framework_helper_preflight_contract() -> list[FrameworkHelperExample]:
    """Exercise every normalizer through a deterministic preflight contract.

    The transport double validates the public request shape and the
    default-deny dispatch guard without claiming a live Kernel, provider call,
    or external execution.
    """

    examples = verify_framework_helper_examples()
    observed: list[dict[str, Any]] = []

    def allow_transport(
        url: str,
        payload: Mapping[str, Any],
        _timeout: float,
        headers: Mapping[str, str],
    ) -> tuple[int, dict[str, Any], dict[str, str]]:
        assert url == "https://kernel.example.test/api/v1/evaluate"
        assert headers["Authorization"] == "Bearer framework-example-api-key"
        assert headers["X-Helm-Tenant-ID"] == "framework-example-tenant"
        assert headers["X-Helm-Principal-ID"] == "framework-example-principal"
        observed.append(dict(payload))
        return (
            200,
            {
                "verdict": "ALLOW",
                "decision_id": "decision-allow",
                "receipt_id": "receipt-allow",
            },
            {
                "x-helm-decision-id": "decision-allow",
                "x-helm-receipt-id": "receipt-allow",
                "x-helm-verdict": "ALLOW",
            },
        )

    for _helper, intent in examples:
        session_id = intent.session_id or "framework-example-session"
        result = preflight_action(
            action_urn=intent.action_urn,
            input=intent.input,
            session_id=session_id,
            tenant_id="framework-example-tenant",
            principal="framework-example-principal",
            api_key="framework-example-api-key",
            helm_url="https://kernel.example.test",
            risk_class=intent.risk_class,
            effect_class=intent.effect_class,
            metadata=intent.metadata,
            transport=allow_transport,
        )
        assert result.verdict == "ALLOW"
        assert not result.dispatched, "preflight alone never dispatches"

        payload = observed[-1]
        assert payload["action"] == "EXECUTE_TOOL"
        assert payload["resource"] == intent.action_urn
        context = payload["context"]
        assert context["tool"] == intent.action_urn
        assert context["args"] == intent.input
        assert context["arguments"] == intent.input
        assert context["session_id"] == session_id

    def deny_transport(
        url: str,
        _payload: Mapping[str, Any],
        _timeout: float,
        headers: Mapping[str, str],
    ) -> tuple[int, dict[str, Any], dict[str, str]]:
        assert url == "https://kernel.example.test/api/v1/evaluate"
        assert headers["Authorization"] == "Bearer framework-example-api-key"
        return 200, {"verdict": "DENY", "decision_id": "decision-deny"}, {}

    dispatches = 0

    @with_helm_boundary(
        action_urn="tool.hermes.unknown",
        session_id="framework-example-session",
        tenant_id="framework-example-tenant",
        principal="framework-example-principal",
        api_key="framework-example-api-key",
        helm_url="https://kernel.example.test",
        transport=deny_transport,
    )
    def unknown_hermes_tool(payload: dict[str, Any]) -> dict[str, Any]:
        nonlocal dispatches
        dispatches += 1
        return {"unexpected": payload}

    denied = run_result(unknown_hermes_tool({"attempt": "unknown-tool"}))
    assert denied.verdict == "DENY"
    assert not denied.dispatched
    assert dispatches == 0, "the default-deny vector must not dispatch"

    return examples


def summary(examples: list[FrameworkHelperExample]) -> list[dict[str, Any]]:
    return [
        {
            "helper": helper,
            "action_urn": intent.action_urn,
            "risk_class": intent.risk_class,
            "effect_class": intent.effect_class,
        }
        for helper, intent in examples
    ]


def main() -> None:
    examples = verify_framework_helper_preflight_contract()
    print(
        json.dumps(
            {
                "helpers": summary(examples),
                "preflight_contracts": len(examples),
                "default_deny_dispatched": False,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
