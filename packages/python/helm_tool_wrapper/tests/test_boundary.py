from __future__ import annotations

import unittest
import sys
from pathlib import Path
from typing import Any, Mapping

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from helm_tool_wrapper import (
    from_browser_use_action,
    from_composio_action,
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
        self.assertEqual(browser.effect_class, "IRREVERSIBLE")

        composio = from_composio_action({"app": "salesforce", "action": "export_records", "payload": {"object": "Lead"}})
        self.assertEqual(composio.action_urn, "tool.composio.salesforce.export_records")
        self.assertEqual(composio.input, {"object": "Lead"})


if __name__ == "__main__":
    unittest.main()
