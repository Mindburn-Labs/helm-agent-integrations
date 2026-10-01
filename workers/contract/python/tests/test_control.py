import json
import unittest

from helm_worker_contract import CONTROL_EXTENSION_URI, PAUSE, RESUME, STEER, render_agent_card


class ControlDeclarationTests(unittest.TestCase):
    def test_actual_adapters_declare_each_unavailable_control_with_its_reason(self) -> None:
        for framework in ("claude-agent-sdk", "openai-agents", "langgraph", "openclaw"):
            with self.subTest(framework=framework):
                card = render_agent_card(
                    framework=framework,
                    url="http://worker:8080/",
                    version="0.1.0",
                    model_apis=["openai-responses"],
                )
                control = next(
                    item
                    for item in card["capabilities"]["extensions"]
                    if item["uri"] == CONTROL_EXTENSION_URI
                )
                self.assertIs(control["required"], False)
                verbs = control["params"]["verbs"]
                self.assertEqual(set(verbs), {STEER, PAUSE, RESUME})
                for declaration in verbs.values():
                    self.assertIs(declaration["supported"], False)
                    self.assertGreater(len(declaration["reason"]), 30)
                self.assertNotIn("{{", json.dumps(card))

    def test_unknown_worker_cannot_acquire_controls_and_copies_are_independent(self) -> None:
        from helm_worker_contract import control_capabilities

        first = control_capabilities("__proto__")
        first["verbs"][PAUSE]["supported"] = True
        second = control_capabilities("__proto__")
        for declaration in second["verbs"].values():
            self.assertIs(declaration["supported"], False)
            self.assertIn("No retained-task control handler", declaration["reason"])


if __name__ == "__main__":
    unittest.main()
