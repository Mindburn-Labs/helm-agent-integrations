"""The kit against the reference worker: a clean sweep, and every defect caught by its check."""

from __future__ import annotations

import unittest
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from helm_worker_contract import MODEL_APIS

from helm_worker_conformance.scenarios import SCENARIOS

from .support import run_reference, statuses

COMMON = {
    "streaming_events",
    "credentials_and_urls",
    "model_requests",
    "only_helm_tools",
    "prompt_carries_episode",
    "secrets_not_leaked",
    "no_egress",
}
PARKS = COMMON | {"parks_input_required", "stops_the_loop", "quiet_after_park"}
CANCEL = {
    "cancel_within_10s",
    "cancel_stops_work",
    "cancel_aborts_inflight_call",
    "secrets_not_leaked",
    "no_egress",
}

# What every scenario must have asserted (and passed) against a conforming worker. A check that
# silently disappears from a scenario fails here, so a green run cannot come from doing less.
MANIFEST: dict[str, set[str]] = {
    "agent_card": {"agent_card", "card_declares_required_extension"},
    "extension_required": {"extension_required", "no_traffic_without_extension"},
    "ingress_auth": {"ingress_auth", "no_traffic_without_auth"},
    "report_completes": COMMON
    | {
        "report_before_completed",
        "artifact_mirrors",
        "completed_status_payload",
        "stops_after_report",
        "stops_after_report_model",
    },
    "escalated_parks": PARKS,
    "escalated_parks_text_only": PARKS,
    "delegate_parks_children": PARKS,
    "request_input_parks_input": PARKS,
    "no_report_fails": COMMON | {"fails_with_no_report"},
    "cancel_during_model_call": CANCEL,
    "cancel_during_tool_call": CANCEL,
    "invalid_episode": {
        "rejects_with_invalid_episode",
        "no_traffic_when_rejected",
        "secrets_not_leaked",
    },
    "missing_episode": {
        "rejects_with_invalid_episode",
        "no_traffic_when_rejected",
        "secrets_not_leaked",
    },
    "hallucinated_tools_are_inert": {
        "hallucinated_tools_are_inert",
        "only_helm_tools",
        "no_egress",
        "secrets_not_leaked",
    },
    "deadline_exceeded": {"deadline_enforced", "deadline_stops_work"},
    "model_error_fails": COMMON | {"fails_with_model_error"},
    "resume_via_subscribe": {
        "task_survives_client_disconnect_and_resumes",
        "get_task_after_completion",
        "secrets_not_leaked",
    },
}
API_INDEPENDENT = {
    "agent_card",
    "extension_required",
    "ingress_auth",
    "invalid_episode",
    "missing_episode",
    "unsupported_model_api",
}


class ReferenceSweep(unittest.TestCase):
    def test_reference_worker_passes_every_scenario_on_every_api(self) -> None:
        jobs = [
            (sid, api)
            for sid in MANIFEST
            for api in (MODEL_APIS[:1] if sid in API_INDEPENDENT else MODEL_APIS)
        ]
        with ThreadPoolExecutor(max_workers=24) as pool:
            results = list(pool.map(lambda job: (job, run_reference(*job)), jobs))
        problems = []
        for (sid, api), result in results:
            got = statuses(result)
            if result.get("error"):
                problems.append(f"{sid}/{api}: harness error {result['error'][-300:]}")
            problems += [
                f"{sid}/{api}: {c['name']} failed: {c['detail'][:300]}"
                for c in result["checks"]
                if c["status"] == "fail"
            ]
            missing = sorted(name for name in MANIFEST[sid] if got.get(name) != "pass")
            if missing:
                problems.append(f"{sid}/{api}: expected passing checks not seen: {missing}")
        self.assertEqual(problems, [])

    def test_the_manifest_covers_every_scenario(self) -> None:
        self.assertEqual(set(SCENARIOS) - {"unsupported_model_api"}, set(MANIFEST))

    def test_unsupported_model_api_is_rejected_and_skipped_when_everything_is_supported(
        self,
    ) -> None:
        narrow = run_reference(
            "unsupported_model_api", "anthropic-messages", supported_apis=("anthropic-messages",)
        )
        self.assertEqual(
            statuses(narrow),
            {
                "rejects_with_unsupported_model_api": "pass",
                "no_traffic_when_rejected": "pass",
                "secrets_not_leaked": "pass",
            },
        )
        self.assertEqual(narrow["api"], "openai-responses")
        broad = run_reference("unsupported_model_api")
        self.assertEqual(statuses(broad), {"rejects_unsupported_model_api": "skip"})


# (defect, scenario, api, checks that must fail because of it)
MUTANTS: list[tuple[str, str, str, set[str]]] = [
    ("no_auth", "ingress_auth", "openai-chat-completions", {"ingress_auth"}),
    ("no_extension_check", "extension_required", "openai-chat-completions", {"extension_required"}),
    (
        "card_without_required_extension",
        "agent_card",
        "openai-chat-completions",
        {"card_declares_required_extension"},
    ),
    ("ignore_escalation", "escalated_parks", "openai-chat-completions", {"stops_the_loop"}),
    (
        "complete_without_report",
        "no_report_fails",
        "openai-chat-completions",
        {"fails_with_no_report", "streaming_events"},
    ),
    ("slow_cancel", "cancel_during_model_call", "openai-chat-completions", {"cancel_within_10s"}),
    (
        "keeps_working_after_cancel",
        "cancel_during_model_call",
        "anthropic-messages",
        {"cancel_stops_work", "cancel_aborts_inflight_call"},
    ),
    (
        "keeps_working_after_cancel",
        "cancel_during_tool_call",
        "openai-responses",
        {"cancel_stops_work", "cancel_aborts_inflight_call"},
    ),
    ("extra_tool", "report_completes", "openai-responses", {"only_helm_tools"}),
    ("extra_tool", "hallucinated_tools_are_inert", "anthropic-messages", {"only_helm_tools"}),
    ("egress", "report_completes", "openai-chat-completions", {"no_egress"}),
    ("leaks_token", "report_completes", "anthropic-messages", {"secrets_not_leaked"}),
    ("wrong_context_id", "report_completes", "openai-chat-completions", {"streaming_events"}),
    ("no_close_after_final", "no_report_fails", "openai-chat-completions", {"streaming_events"}),
    ("no_status_mirror", "escalated_parks", "openai-chat-completions", {"parks_input_required"}),
    ("no_status_mirror", "no_report_fails", "openai-chat-completions", {"fails_with_no_report"}),
    (
        "continue_after_report",
        "report_completes",
        "openai-chat-completions",
        {"stops_after_report_model"},
    ),
    (
        "reject_becomes_failed",
        "invalid_episode",
        "openai-chat-completions",
        {"rejects_with_invalid_episode"},
    ),
    ("kind_members", "report_completes", "openai-chat-completions", {"streaming_events"}),
]


class Mutants(unittest.TestCase):
    def test_each_defect_is_caught_by_its_check(self) -> None:
        def run(
            mutant: tuple[str, str, str, set[str]],
        ) -> tuple[tuple[str, str, str, set[str]], dict[str, Any]]:
            defect, scenario, api, _ = mutant
            return mutant, run_reference(scenario, api, mutations=frozenset({defect}))

        with ThreadPoolExecutor(max_workers=len(MUTANTS)) as pool:
            results = list(pool.map(run, MUTANTS))
        problems = []
        for (defect, scenario, api, must_fail), result in results:
            got = statuses(result)
            missed = sorted(name for name in must_fail if got.get(name) != "fail")
            if missed:
                problems.append(
                    f"defect {defect} in {scenario}/{api} was not caught by {missed}; statuses: {got}"
                )
        self.assertEqual(problems, [])


if __name__ == "__main__":
    unittest.main()
