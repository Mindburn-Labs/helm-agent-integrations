from __future__ import annotations

import importlib.util
import sys
import unittest
from dataclasses import replace
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
_SPEC = importlib.util.spec_from_file_location(
    "generate_samples", REPO_ROOT / "scripts" / "generate_samples.py"
)
assert _SPEC is not None and _SPEC.loader is not None
generate_samples = importlib.util.module_from_spec(_SPEC)
sys.modules["generate_samples"] = generate_samples
_SPEC.loader.exec_module(generate_samples)


class SampleGenerationAssertionTests(unittest.TestCase):
    def _scenario(self, scenario_id: str):
        for scenario in generate_samples.SCENARIOS:
            if scenario.scenario_id == scenario_id:
                return scenario
        raise AssertionError(f"missing scenario {scenario_id}")

    def test_every_scenario_reason_code_is_backed_by_reference_policy(self) -> None:
        for scenario in generate_samples.SCENARIOS:
            facts = generate_samples.assert_reason_code_backed(scenario)
            self.assertIsInstance(facts, dict)

    def test_e2b_receipt_records_network_egress_policy_facts(self) -> None:
        scenario = self._scenario("e2b-network-egress-deny")
        receipt = generate_samples.receipt_for(scenario)
        self.assertEqual(receipt["reason_code"], "SANDBOX_NETWORK_EGRESS_DENY")
        self.assertEqual(receipt["verdict"], "DENY")
        self.assertEqual(receipt["effect_class"], "E4")
        self.assertEqual(
            receipt["policy_facts"],
            {"action_urn": "tool.e2b.execute", "network": "external"},
        )
        self.assertEqual(scenario.arguments["network"], "external")

    def test_unbacked_reason_code_fails_generation(self) -> None:
        scenario = replace(
            self._scenario("e2b-network-egress-deny"),
            reason_code="REASON_CODE_WITHOUT_BACKING_RULE",
        )
        with self.assertRaises(ValueError):
            generate_samples.assert_reason_code_backed(scenario)

    def test_missing_network_fact_fails_generation(self) -> None:
        scenario = self._scenario("e2b-network-egress-deny")
        arguments = {k: v for k, v in scenario.arguments.items() if k != "network"}
        with self.assertRaises(ValueError):
            generate_samples.assert_reason_code_backed(replace(scenario, arguments=arguments))

    def test_verdict_mismatch_fails_generation(self) -> None:
        scenario = replace(self._scenario("e2b-network-egress-deny"), verdict="ESCALATE")
        with self.assertRaises(ValueError):
            generate_samples.assert_reason_code_backed(scenario)

    def test_normalize_e2b_network_fails_closed(self) -> None:
        self.assertEqual(generate_samples.normalize_e2b_network(None), "external")
        self.assertEqual(generate_samples.normalize_e2b_network(True), "external")
        self.assertEqual(generate_samples.normalize_e2b_network("internet"), "external")
        self.assertEqual(generate_samples.normalize_e2b_network({"internet_access": True}), "external")
        self.assertEqual(generate_samples.normalize_e2b_network(False), "isolated")
        self.assertEqual(generate_samples.normalize_e2b_network("none"), "isolated")
        self.assertEqual(generate_samples.normalize_e2b_network("ISOLATED"), "isolated")


if __name__ == "__main__":
    unittest.main()
