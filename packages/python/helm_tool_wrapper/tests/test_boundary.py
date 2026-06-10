from __future__ import annotations

import unittest
import sys
from pathlib import Path
from typing import Any, Mapping

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from helm_tool_wrapper import (
    from_browser_use_action,
    from_composio_action,
    from_e2b_execution,
    from_tinyfish_agent_run,
    from_tinyfish_browser_session,
    from_tinyfish_fetch,
    from_tinyfish_search,
    normalize_e2b_network,
    preflight_action,
    with_helm_boundary,
)


class BoundaryWrapperTests(unittest.TestCase):
    def test_allow_dispatches(self) -> None:
        calls = {"count": 0}

        def transport(_url: str, _payload: Mapping[str, Any], _timeout: float) -> tuple[int, Mapping[str, Any], Mapping[str, str]]:
            return 200, {"decision": {"verdict": "ALLOW", "decision_id": "dec-1"}}, {"x-helm-receipt-id": "rcpt-1"}

        @with_helm_boundary(action_urn="tool.demo.allow", transport=transport)
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

        def transport(_url: str, _payload: Mapping[str, Any], _timeout: float) -> tuple[int, Mapping[str, Any], Mapping[str, str]]:
            return 200, {"decision": {"verdict": "DENY", "reason": "blocked", "receipt_id": "rcpt-deny"}}, {}

        @with_helm_boundary(action_urn="tool.shell.rm_rf", transport=transport)
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

        def transport(_url: str, payload: Mapping[str, Any], _timeout: float) -> tuple[int, Mapping[str, Any], Mapping[str, str]]:
            captured.update(payload)
            return 200, {"verdict": "ESCALATE", "reason": "approval required"}, {}

        result = preflight_action(
            action_urn="tool.gmail.send_email",
            input={"to": "ops@example.com"},
            principal="agent-1",
            risk_class="T2",
            effect_class="IRREVERSIBLE",
            transport=transport,
        )

        self.assertEqual(result.verdict, "ESCALATE")
        self.assertEqual(captured["principal"], "agent-1")
        self.assertEqual(captured["action"], "EXECUTE_TOOL")
        self.assertEqual(captured["resource"], "tool.gmail.send_email")
        self.assertEqual(captured["context"]["risk_class"], "T2")

    def test_framework_helpers(self) -> None:
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


if __name__ == "__main__":
    unittest.main()
