from __future__ import annotations

import hashlib
import unittest
import sys
from pathlib import Path
from typing import Any, Mapping

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from helm_tool_wrapper import (
    HelmBoundaryError,
    HelmBoundaryResult,
    HelmDecision,
    from_browser_use_action,
    from_claude_tool_call,
    from_composio_action,
    from_codex_tool_call,
    from_daytona_process_exec,
    from_daytona_sandbox_create,
    from_daytona_ssh_grant,
    from_e2b_execution,
    from_tinyfish_agent_run,
    from_tinyfish_browser_session,
    from_tinyfish_fetch,
    from_tinyfish_search,
    normalize_daytona_network,
    normalize_e2b_network,
    preflight_action,
    with_helm_boundary,
)


class BoundaryWrapperTests(unittest.TestCase):
    def test_allow_dispatches(self) -> None:
        calls = {"count": 0}

        def transport(
            _url: str,
            _payload: Mapping[str, Any],
            _timeout: float,
            _headers: Mapping[str, str],
        ) -> tuple[int, Mapping[str, Any], Mapping[str, str]]:
            return 200, {"decision": {"verdict": "ALLOW", "decision_id": "dec-1"}}, {"x-helm-receipt-id": "rcpt-1"}

        @with_helm_boundary(
            action_urn="tool.demo.allow",
            session_id="session-allow",
            tenant_id="tenant-allow",
            principal="principal-allow",
            api_key="api-key-allow",
            transport=transport,
        )
        def tool(payload: Mapping[str, Any]) -> Mapping[str, Any]:
            calls["count"] += 1
            return {"ok": True, **payload}

        result = tool({"value": 42})
        self.assertTrue(result.allowed)
        self.assertTrue(result.dispatched)
        self.assertEqual(result.output, {"ok": True, "value": 42})
        self.assertEqual(result.receipt.receipt_id, "rcpt-1")
        self.assertEqual(calls["count"], 1)

    def test_deny_does_not_dispatch(self) -> None:
        calls = {"count": 0}

        def transport(
            _url: str,
            _payload: Mapping[str, Any],
            _timeout: float,
            _headers: Mapping[str, str],
        ) -> tuple[int, Mapping[str, Any], Mapping[str, str]]:
            return 200, {"decision": {"verdict": "DENY", "reason": "blocked", "receipt_id": "rcpt-deny"}}, {}

        @with_helm_boundary(
            action_urn="tool.shell.rm_rf",
            session_id="session-deny",
            tenant_id="tenant-deny",
            principal="principal-deny",
            api_key="api-key-deny",
            transport=transport,
        )
        def tool(_payload: Mapping[str, Any]) -> str:
            calls["count"] += 1
            return "should-not-run"

        result = tool({"command": "rm -rf ./secrets"})
        self.assertFalse(result.allowed)
        self.assertFalse(result.dispatched)
        self.assertEqual(result.verdict, "DENY")
        self.assertEqual(result.receipt.receipt_id, "rcpt-deny")
        self.assertEqual(calls["count"], 0)

    def test_preflight_payload_shape(self) -> None:
        captured: dict[str, Any] = {}
        captured_url = {"value": ""}
        captured_headers: dict[str, str] = {}

        def transport(
            _url: str,
            payload: Mapping[str, Any],
            _timeout: float,
            headers: Mapping[str, str],
        ) -> tuple[int, Mapping[str, Any], Mapping[str, str]]:
            captured_url["value"] = _url
            captured.update(payload)
            captured_headers.update(headers)
            return 200, {"verdict": "ESCALATE", "reason": "approval required"}, {}

        result = preflight_action(
            action_urn="tool.gmail.send_email",
            input={"to": "ops@example.com"},
            session_id="session-preflight",
            tenant_id="tenant-preflight",
            api_key="api-key-preflight",
            principal="agent-1",
            workspace_id="workspace-preflight",
            risk_class="T2",
            effect_class="E4",
            transport=transport,
        )

        self.assertEqual(result.verdict, "ESCALATE")
        self.assertEqual(captured_url["value"], "http://127.0.0.1:7714/api/v1/evaluate")
        self.assertEqual(captured_headers["Authorization"], "Bearer api-key-preflight")
        self.assertEqual(captured_headers["Content-Type"], "application/json")
        self.assertEqual(captured_headers["X-Helm-Tenant-ID"], "tenant-preflight")
        self.assertEqual(captured_headers["X-Helm-Principal-ID"], "agent-1")
        self.assertEqual(captured_headers["X-Helm-Workspace-ID"], "workspace-preflight")
        self.assertEqual(
            captured,
            {
                "principal": "agent-1",
                "action": "EXECUTE_TOOL",
                "resource": "tool.gmail.send_email",
                "tool": "EXECUTE_TOOL",
                "args": {"to": "ops@example.com"},
                "agent_id": "agent-1",
                "effect_level": "tool.gmail.send_email",
                "session_id": "session-preflight",
                "context": {
                    "tool": "tool.gmail.send_email",
                    "args": {"to": "ops@example.com"},
                    "arguments": {"to": "ops@example.com"},
                    "agent_id": "agent-1",
                    "effect_level": "E4",
                    "session_id": "session-preflight",
                    "action_urn": "tool.gmail.send_email",
                    "risk_class": "T2",
                    "effect_class": "E4",
                    "metadata": {},
                },
            },
        )

    def test_unauthorized_preflight_fails_closed(self) -> None:
        calls = {"count": 0}

        def transport(
            _url: str,
            _payload: Mapping[str, Any],
            _timeout: float,
            _headers: Mapping[str, str],
        ) -> tuple[int, Mapping[str, Any], Mapping[str, str]]:
            return 401, {"error": "unauthorized"}, {}

        @with_helm_boundary(
            action_urn="tool.demo.unauthorized",
            session_id="session-unauthorized",
            tenant_id="tenant-unauthorized",
            principal="principal-unauthorized",
            api_key="rejected-api-key",
            transport=transport,
        )
        def tool(_payload: Mapping[str, Any]) -> str:
            calls["count"] += 1
            return "should-not-run"

        with self.assertRaisesRegex(HelmBoundaryError, "HTTP 401"):
            tool({"value": 1})
        self.assertEqual(calls["count"], 0)

    def test_allow_without_durable_receipt_fails_closed(self) -> None:
        calls = {"count": 0}

        def transport(
            _url: str,
            _payload: Mapping[str, Any],
            _timeout: float,
            _headers: Mapping[str, str],
        ) -> tuple[int, Mapping[str, Any], Mapping[str, str]]:
            return 200, {"verdict": "ALLOW", "decision_id": "decision-only"}, {}

        @with_helm_boundary(
            action_urn="tool.demo.missing_receipt",
            session_id="session-missing-receipt",
            tenant_id="tenant-missing-receipt",
            principal="principal-missing-receipt",
            api_key="api-key-missing-receipt",
            transport=transport,
        )
        def tool(_payload: Mapping[str, Any]) -> str:
            calls["count"] += 1
            return "should-not-run"

        with self.assertRaisesRegex(HelmBoundaryError, "missing the durable receipt_id"):
            tool({"value": 1})
        self.assertEqual(calls["count"], 0)

    def test_malformed_or_conflicting_evaluate_evidence_fails_closed(self) -> None:
        malformed = [
            (
                {"verdict": "ALLOW", "receipt_id": "receipt-body"},
                {"x-helm-receipt-id": "receipt-body", "x-helm-verdict": "DENY"},
                "conflicting verdict values",
            ),
            (
                {"verdict": "ALLOW", "receipt_id": "receipt-body"},
                {"x-helm-receipt-id": "receipt-header"},
                "conflicting receipt_id values",
            ),
            (
                {"verdict": "ALLOW", "receipt_id": 123},
                {},
                "missing the durable receipt_id",
            ),
        ]

        for body, headers, error in malformed:
            with self.subTest(error=error):
                calls = {"count": 0}

                def transport(
                    _url: str,
                    _payload: Mapping[str, Any],
                    _timeout: float,
                    _headers: Mapping[str, str],
                ) -> tuple[int, Mapping[str, Any], Mapping[str, str]]:
                    return 200, body, headers

                @with_helm_boundary(
                    action_urn="tool.demo.malformed",
                    session_id="session-malformed",
                    tenant_id="tenant-malformed",
                    principal="principal-malformed",
                    api_key="api-key-malformed",
                    transport=transport,
                )
                def tool(_payload: Mapping[str, Any]) -> str:
                    calls["count"] += 1
                    return "should-not-run"

                with self.assertRaisesRegex(HelmBoundaryError, error):
                    tool({"value": 1})
                self.assertEqual(calls["count"], 0)

    def test_boundary_result_preserves_existing_positional_field_order(self) -> None:
        decision = HelmDecision(verdict="DENY")
        result = HelmBoundaryResult(False, False, "DENY", decision, None, "output", "raw")
        self.assertEqual(result.output, "output")
        self.assertEqual(result.raw, "raw")
        self.assertIsNone(result.evidence_pack)

    def test_preflight_rejects_missing_auth_service_credentials_and_bad_classification(self) -> None:
        calls = {"count": 0}

        def transport(
            _url: str,
            _payload: Mapping[str, Any],
            _timeout: float,
            _headers: Mapping[str, str],
        ) -> tuple[int, Mapping[str, Any], Mapping[str, str]]:
            calls["count"] += 1
            return 200, {"verdict": "ALLOW"}, {}

        base: dict[str, Any] = {
            "action_urn": "tool.demo.validation",
            "input": {"value": 1},
            "session_id": "session-validation",
            "tenant_id": "tenant-validation",
            "principal": "principal-validation",
            "transport": transport,
        }
        with self.assertRaisesRegex(HelmBoundaryError, "api_key is required"):
            preflight_action(**base)
        with self.assertRaisesRegex(HelmBoundaryError, "service_token is not authorized"):
            preflight_action(**base, service_token="service-key")
        with self.assertRaisesRegex(HelmBoundaryError, "Unsupported HELM effect_class"):
            preflight_action(**base, api_key="api-key", effect_class="E9")
        with self.assertRaisesRegex(HelmBoundaryError, "principal is required"):
            preflight_action(**{**base, "api_key": "api-key", "principal": ""})
        self.assertEqual(calls["count"], 0)

    def test_codex_and_claude_helpers_preserve_arguments_and_ignore_downgrades(self) -> None:
        codex = from_codex_tool_call(
            {
                "recipient_name": "functions.exec_command",
                "parameters": {"cmd": "gh pr merge 189 --merge"},
                "input": {"cmd": "wrong fallback"},
                "session_id": "codex-session-1",
                "thread_id": "thread-1",
                "risk_class": "T0",
                "effect_class": "E1",
                "principal": "spoofed-principal",
                "metadata": {
                    "framework": "spoofed",
                    "tool_name": "spoofed",
                    "principal": "spoofed-principal",
                    "risk_class": "T0",
                    "effect_class": "E1",
                },
            }
        )
        self.assertEqual(codex.action_urn, "tool.codex.functions.exec_command")
        self.assertEqual(codex.input, {"cmd": "gh pr merge 189 --merge"})
        self.assertEqual(codex.session_id, "codex-session-1")
        self.assertEqual(codex.risk_class, "T2")
        self.assertEqual(codex.effect_class, "E4")
        self.assertEqual(codex.metadata["framework"], "codex")
        self.assertEqual(codex.metadata["tool_name"], "functions.exec_command")
        self.assertEqual(codex.metadata["thread_id"], "thread-1")
        self.assertNotIn("principal", codex.metadata)
        self.assertNotIn("risk_class", codex.metadata)
        self.assertNotIn("effect_class", codex.metadata)
        self.assertIsNone(codex.principal)

        claude = from_claude_tool_call(
            {
                "tool_name": "Bash",
                "tool_input": {"command": "cat README.md"},
                "input": {"command": "wrong fallback"},
                "id": "toolu_1",
                "session_id": "claude-session-1",
                "risk_class": "T0",
                "effect_class": "E1",
                "principal": "spoofed-principal",
                "metadata": {
                    "framework": "spoofed",
                    "tool_name": "spoofed",
                    "principal": "spoofed-principal",
                    "risk_class": "T0",
                    "effect_class": "E1",
                },
            }
        )
        self.assertEqual(claude.action_urn, "tool.claude.Bash")
        self.assertEqual(claude.input, {"command": "cat README.md"})
        self.assertEqual(claude.session_id, "claude-session-1")
        self.assertEqual(claude.risk_class, "T2")
        self.assertEqual(claude.effect_class, "E4")
        self.assertEqual(claude.metadata["framework"], "claude")
        self.assertEqual(claude.metadata["tool_name"], "Bash")
        self.assertEqual(claude.metadata["tool_use_id"], "toolu_1")
        self.assertNotIn("principal", claude.metadata)
        self.assertNotIn("risk_class", claude.metadata)
        self.assertNotIn("effect_class", claude.metadata)
        self.assertIsNone(claude.principal)

    def test_codex_and_claude_compositions_enforce_verdicts_and_evidence(self) -> None:
        connectors = [
            (
                "Codex",
                from_codex_tool_call(
                    {
                        "recipient_name": "functions.exec_command",
                        "parameters": {"cmd": "git status --short"},
                        "session_id": "codex-session-2",
                    }
                ),
            ),
            (
                "Claude",
                from_claude_tool_call(
                    {
                        "tool_name": "Edit",
                        "tool_input": {
                            "file_path": "README.md",
                            "old_string": "old",
                            "new_string": "new",
                        },
                        "session_id": "claude-session-2",
                    }
                ),
            ),
        ]

        for connector_name, intent in connectors:
            with self.subTest(connector=connector_name, vector="allow"):
                pack = f"{connector_name} preflight EvidencePack".encode()
                pack_hash = f"sha256:{hashlib.sha256(pack).hexdigest()}"
                captured: dict[str, Any] = {}
                dispatches = {"count": 0}

                def allow_transport(
                    url: str,
                    payload: Mapping[str, Any],
                    _timeout: float,
                    headers: Mapping[str, str],
                ) -> tuple[int, Mapping[str, Any], Mapping[str, str]]:
                    self.assertEqual(url, "https://kernel.example.test/api/v1/evaluate")
                    captured.update(payload)
                    self.assertEqual(headers["Authorization"], "Bearer api-key-conformance")
                    self.assertEqual(headers["X-Helm-Tenant-ID"], "tenant-conformance")
                    self.assertEqual(headers["X-Helm-Principal-ID"], "principal-conformance")
                    self.assertEqual(headers["X-Helm-Workspace-ID"], "workspace-conformance")
                    slug = connector_name.lower()
                    return (
                        200,
                        {
                            "verdict": "ALLOW",
                            "decision_id": f"{slug}-decision-allow",
                            "receipt_id": f"{slug}-receipt-allow",
                        },
                        {},
                    )

                def evidence_transport(
                    url: str,
                    payload: Mapping[str, Any],
                    _timeout: float,
                    headers: Mapping[str, str],
                ) -> tuple[int, bytes, Mapping[str, str]]:
                    self.assertEqual(url, "https://kernel.example.test/api/v1/evidence/export")
                    self.assertEqual(
                        payload,
                        {"session_id": intent.session_id, "format": "tar.gz"},
                    )
                    self.assertEqual(headers["Authorization"], "Bearer api-key-conformance")
                    self.assertEqual(headers["X-Helm-Workspace-ID"], "workspace-conformance")
                    return (
                        200,
                        pack,
                        {
                            "content-type": "application/octet-stream",
                            "x-helm-evidence-hash": pack_hash,
                        },
                    )

                @with_helm_boundary(
                    action_urn=intent.action_urn,
                    session_id=intent.session_id or "",
                    tenant_id="tenant-conformance",
                    principal="principal-conformance",
                    workspace_id="workspace-conformance",
                    api_key="api-key-conformance",
                    helm_url="https://kernel.example.test",
                    risk_class=intent.risk_class,
                    effect_class=intent.effect_class,
                    metadata=intent.metadata,
                    export_evidence=True,
                    transport=allow_transport,
                    evidence_transport=evidence_transport,
                )
                def allowed_tool(payload: Any) -> Mapping[str, Any]:
                    dispatches["count"] += 1
                    return {"input": payload}

                allowed = allowed_tool(intent.input)
                self.assertTrue(allowed.allowed)
                self.assertTrue(allowed.dispatched)
                self.assertEqual(dispatches["count"], 1)
                self.assertEqual(
                    allowed.receipt.receipt_id,
                    f"{connector_name.lower()}-receipt-allow",
                )
                self.assertEqual(allowed.evidence_pack.evidence_hash, pack_hash)
                self.assertEqual(allowed.evidence_pack.content, pack)
                self.assertEqual(captured["action"], "EXECUTE_TOOL")
                self.assertEqual(captured["resource"], intent.action_urn)
                self.assertEqual(captured["tool"], "EXECUTE_TOOL")
                self.assertEqual(captured["args"], intent.input)
                self.assertEqual(captured["agent_id"], "principal-conformance")
                self.assertEqual(captured["effect_level"], intent.action_urn)
                self.assertEqual(captured["session_id"], intent.session_id)
                self.assertEqual(captured["context"]["tool"], intent.action_urn)
                self.assertEqual(captured["context"]["args"], intent.input)
                self.assertEqual(captured["context"]["effect_level"], "E4")
                self.assertEqual(captured["context"]["session_id"], intent.session_id)

            with self.subTest(connector=connector_name, vector="deny"):
                pack = f"{connector_name} denied preflight EvidencePack".encode()
                pack_hash = f"sha256:{hashlib.sha256(pack).hexdigest()}"
                dispatches = {"count": 0}

                def deny_transport(
                    _url: str,
                    _payload: Mapping[str, Any],
                    _timeout: float,
                    _headers: Mapping[str, str],
                ) -> tuple[int, Mapping[str, Any], Mapping[str, str]]:
                    return (
                        200,
                        {
                            "verdict": "DENY",
                            "receipt_id": f"{connector_name}-receipt-deny",
                        },
                        {},
                    )

                def denied_evidence_transport(
                    _url: str,
                    _payload: Mapping[str, Any],
                    _timeout: float,
                    _headers: Mapping[str, str],
                ) -> tuple[int, bytes, Mapping[str, str]]:
                    return 200, pack, {"x-helm-evidence-hash": pack_hash}

                @with_helm_boundary(
                    action_urn=intent.action_urn,
                    session_id=intent.session_id or "",
                    tenant_id="tenant-conformance",
                    principal="principal-conformance",
                    api_key="api-key-conformance",
                    export_evidence=True,
                    transport=deny_transport,
                    evidence_transport=denied_evidence_transport,
                )
                def denied_tool(_payload: Any) -> str:
                    dispatches["count"] += 1
                    return "unexpected"

                denied = denied_tool(intent.input)
                self.assertFalse(denied.allowed)
                self.assertFalse(denied.dispatched)
                self.assertEqual(denied.receipt.receipt_id, f"{connector_name}-receipt-deny")
                self.assertEqual(denied.evidence_pack.evidence_hash, pack_hash)
                self.assertEqual(dispatches["count"], 0)

            with self.subTest(connector=connector_name, vector="error"):
                dispatches = {"count": 0}

                def error_transport(
                    _url: str,
                    _payload: Mapping[str, Any],
                    _timeout: float,
                    _headers: Mapping[str, str],
                ) -> tuple[int, Mapping[str, Any], Mapping[str, str]]:
                    return 503, {"error": "unavailable"}, {}

                @with_helm_boundary(
                    action_urn=intent.action_urn,
                    session_id=intent.session_id or "",
                    tenant_id="tenant-conformance",
                    principal="principal-conformance",
                    api_key="api-key-conformance",
                    export_evidence=True,
                    transport=error_transport,
                )
                def error_tool(_payload: Any) -> str:
                    dispatches["count"] += 1
                    return "unexpected"

                with self.assertRaisesRegex(HelmBoundaryError, "HTTP 503"):
                    error_tool(intent.input)
                self.assertEqual(dispatches["count"], 0)

            with self.subTest(connector=connector_name, vector="tamper"):
                pack = f"{connector_name} tampered preflight EvidencePack".encode()
                dispatches = {"count": 0}

                def tamper_allow_transport(
                    _url: str,
                    _payload: Mapping[str, Any],
                    _timeout: float,
                    _headers: Mapping[str, str],
                ) -> tuple[int, Mapping[str, Any], Mapping[str, str]]:
                    return (
                        200,
                        {
                            "verdict": "ALLOW",
                            "receipt_id": f"{connector_name}-receipt-tamper",
                        },
                        {},
                    )

                def tampered_evidence_transport(
                    _url: str,
                    _payload: Mapping[str, Any],
                    _timeout: float,
                    _headers: Mapping[str, str],
                ) -> tuple[int, bytes, Mapping[str, str]]:
                    return 200, pack, {"x-helm-evidence-hash": f"sha256:{'0' * 64}"}

                @with_helm_boundary(
                    action_urn=intent.action_urn,
                    session_id=intent.session_id or "",
                    tenant_id="tenant-conformance",
                    principal="principal-conformance",
                    api_key="api-key-conformance",
                    export_evidence=True,
                    transport=tamper_allow_transport,
                    evidence_transport=tampered_evidence_transport,
                )
                def tampered_tool(_payload: Any) -> str:
                    dispatches["count"] += 1
                    return "unexpected"

                with self.assertRaisesRegex(HelmBoundaryError, "hash mismatch"):
                    tampered_tool(intent.input)
                self.assertEqual(dispatches["count"], 0)

    def test_evidence_export_http_failure_blocks_dispatch(self) -> None:
        intent = from_codex_tool_call(
            {
                "recipient_name": "functions.exec_command",
                "parameters": {"cmd": "git status --short"},
                "session_id": "codex-export-error",
            }
        )
        calls = {"count": 0}

        def allow_transport(
            _url: str,
            _payload: Mapping[str, Any],
            _timeout: float,
            _headers: Mapping[str, str],
        ) -> tuple[int, Mapping[str, Any], Mapping[str, str]]:
            return 200, {"verdict": "ALLOW", "receipt_id": "receipt-export-error"}, {}

        def evidence_transport(
            _url: str,
            _payload: Mapping[str, Any],
            _timeout: float,
            _headers: Mapping[str, str],
        ) -> tuple[int, bytes, Mapping[str, str]]:
            return 503, b"evidence service unavailable", {}

        @with_helm_boundary(
            action_urn=intent.action_urn,
            session_id=intent.session_id or "",
            tenant_id="tenant-export-error",
            principal="principal-export-error",
            api_key="api-key-export-error",
            export_evidence=True,
            transport=allow_transport,
            evidence_transport=evidence_transport,
        )
        def tool(_payload: Any) -> str:
            calls["count"] += 1
            return "should-not-run"

        with self.assertRaisesRegex(HelmBoundaryError, "evidence export failed with HTTP 503"):
            tool(intent.input)
        self.assertEqual(calls["count"], 0)

    def test_browser_use_and_composio_helpers(self) -> None:

        browser = from_browser_use_action({"action": "submit", "url": "https://shop.example/checkout"})
        self.assertEqual(browser.action_urn, "tool.browser_use.submit")
        self.assertEqual(browser.risk_class, "T2")
        self.assertEqual(browser.effect_class, "E4")

        composio = from_composio_action({"app": "salesforce", "action": "export_records", "payload": {"object": "Lead"}})
        self.assertEqual(composio.action_urn, "tool.composio.salesforce.export_records")
        self.assertEqual(composio.input, {"object": "Lead"})

    def test_tinyfish_helpers(self) -> None:
        search = from_tinyfish_search({"query": "HELM governed web capability"})
        self.assertEqual(search.action_urn, "tool.tinyfish.search.query")
        self.assertEqual(search.effect_class, "E2")
        self.assertEqual(search.metadata["connector_id"], "tinyfish-web-v1")
        self.assertEqual(search.metadata["endpoint_family"], "search")

        fetch = from_tinyfish_fetch({"urls": ["https://example.com"], "ttl": 3600})
        self.assertEqual(fetch.action_urn, "tool.tinyfish.fetch.extract")
        self.assertEqual(fetch.effect_class, "E2")
        self.assertEqual(fetch.metadata["endpoint_family"], "fetch")

        browser = from_tinyfish_browser_session(
            {
                "url": "https://portal.example",
                "credential_grant_ref": "grant:demo",
                "ttl_seconds": 900,
            }
        )
        self.assertEqual(browser.action_urn, "tool.tinyfish.browser.session")
        self.assertEqual(browser.effect_class, "E3")
        self.assertEqual(browser.metadata["endpoint_family"], "browser")

        agent = from_tinyfish_agent_run(
            {
                "url": "https://shop.example/checkout",
                "goal": "Submit the saved cart",
                "action_intent": "submit",
            }
        )
        self.assertEqual(agent.action_urn, "tool.tinyfish.agent.external_action")
        self.assertEqual(agent.effect_class, "E4")
        self.assertEqual(agent.metadata["endpoint_family"], "agent")

    def test_e2b_helper_normalizes_network_and_fails_closed(self) -> None:
        external = from_e2b_execution({"language": "python", "code": "print(1)", "network": True})
        self.assertEqual(external.action_urn, "tool.e2b.execute")
        self.assertEqual(external.metadata["network"], "external")
        self.assertEqual(external.effect_class, "E4")

        # Missing network capability must not be treated as isolated.
        unknown = from_e2b_execution({"language": "python", "code": "print(1)"})
        self.assertEqual(unknown.metadata["network"], "external")
        self.assertEqual(unknown.effect_class, "E4")

        isolated = from_e2b_execution({"language": "python", "code": "print(1)", "network": "none"})
        self.assertEqual(isolated.metadata["network"], "isolated")
        self.assertEqual(isolated.effect_class, "E3")

        self.assertEqual(normalize_e2b_network(False), "isolated")
        self.assertEqual(normalize_e2b_network("external"), "external")
        self.assertEqual(normalize_e2b_network({"internet_access": True}), "external")

    def test_daytona_helpers_normalize_network_and_fail_closed(self) -> None:
        # No explicit network settings must not be treated as isolated.
        unbounded = from_daytona_sandbox_create({"snapshot": "daytona-small"})
        self.assertEqual(unbounded.action_urn, "tool.daytona.sandbox.create")
        self.assertEqual(unbounded.metadata["network"], "external")
        self.assertEqual(unbounded.effect_class, "E4")

        allowlisted = from_daytona_sandbox_create(
            {
                "snapshot": "daytona-small",
                "domain_allow_list": ["api.example.com"],
                "auto_delete_interval": 0,
            }
        )
        self.assertEqual(allowlisted.metadata["network"], "allowlisted")
        self.assertEqual(allowlisted.effect_class, "E3")
        self.assertTrue(allowlisted.metadata["ephemeral"])

        isolated = from_daytona_sandbox_create(
            {"snapshot": "daytona-small", "network_block_all": True}
        )
        self.assertEqual(isolated.metadata["network"], "isolated")
        self.assertEqual(isolated.effect_class, "E3")

        exec_unknown = from_daytona_process_exec({"sandbox_id": "sbx-1", "command": "make test"})
        self.assertEqual(exec_unknown.action_urn, "tool.daytona.process.exec")
        self.assertEqual(exec_unknown.metadata["network"], "external")
        self.assertEqual(exec_unknown.effect_class, "E4")

        ssh = from_daytona_ssh_grant({"sandbox_id": "sbx-1", "expires_in_minutes": 60})
        self.assertEqual(ssh.action_urn, "tool.daytona.sandbox.ssh_grant")
        self.assertEqual(ssh.metadata["access_channel"], "ssh")
        self.assertEqual(ssh.effect_class, "E4")

        self.assertEqual(normalize_daytona_network({"network_block_all": True}), "isolated")
        self.assertEqual(normalize_daytona_network({"networkAllowList": "10.0.0.0/24"}), "allowlisted")
        self.assertEqual(normalize_daytona_network(None), "external")


if __name__ == "__main__":
    unittest.main()
