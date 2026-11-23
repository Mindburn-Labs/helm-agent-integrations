from __future__ import annotations

import sys
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[4]
with patch.object(sys, "path", [str(REPO_ROOT / "scripts"), *sys.path]):
    import generate_samples
    import sample_scenarios


class SampleGenerationAssertionTests(unittest.TestCase):
    LOOP_SCENARIOS = {
        "claude-code-goal-docs-truth-allow",
        "claude-code-loop-operate-deny",
        "codex-cloud-task-build-test-fix-allow",
        "langgraph-evaluator-certification-escalate",
        "github-pr-bot-overnight-triage-allow",
    }

    def _scenario(self, scenario_id: str):
        for scenario in sample_scenarios.SCENARIOS:
            if scenario.scenario_id == scenario_id:
                return scenario
        raise AssertionError(f"missing scenario {scenario_id}")

    def test_every_scenario_reason_code_is_backed_by_reference_policy(self) -> None:
        for scenario in sample_scenarios.SCENARIOS:
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
        self.assertEqual(sample_scenarios.normalize_e2b_network(None), "external")
        self.assertEqual(sample_scenarios.normalize_e2b_network(True), "external")
        self.assertEqual(sample_scenarios.normalize_e2b_network("internet"), "external")
        self.assertEqual(sample_scenarios.normalize_e2b_network({"internet_access": True}), "external")
        self.assertEqual(sample_scenarios.normalize_e2b_network(False), "isolated")
        self.assertEqual(sample_scenarios.normalize_e2b_network("none"), "isolated")
        self.assertEqual(sample_scenarios.normalize_e2b_network("ISOLATED"), "isolated")

    def test_loop_adapter_samples_emit_v2_loop_metadata(self) -> None:
        for scenario_id in self.LOOP_SCENARIOS:
            scenario = self._scenario(scenario_id)
            receipt = generate_samples.receipt_for(scenario)
            loop = receipt["loop"]
            self.assertEqual(loop["agent_run_receipt_version"], "agent_run_receipt.v2")
            self.assertIn(loop["loop_class"], {"observe", "report", "propose", "patch_pr", "operate"})
            self.assertNotEqual(loop["stop_condition"].strip(), "")
            self.assertGreaterEqual(loop["max_iterations"], loop["iteration_count"])
            self.assertIsInstance(loop["verifier_refs"], list)
            self.assertIsInstance(loop["evidence_refs"], list)
            self.assertFalse(loop["memory_effects"]["accepted_without_review"])

    def test_operate_loop_without_approval_is_denied(self) -> None:
        scenario = self._scenario("claude-code-loop-operate-deny")
        receipt = generate_samples.receipt_for(scenario)
        self.assertEqual(receipt["verdict"], "DENY")
        self.assertFalse(receipt["dispatched"])
        self.assertEqual(receipt["loop"]["loop_class"], "operate")
        self.assertEqual(receipt["loop"]["approval_refs"], [])
        self.assertNotEqual(receipt["loop"]["denied_effects"], [])


if __name__ == "__main__":
    unittest.main()
