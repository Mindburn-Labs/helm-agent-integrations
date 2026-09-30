from __future__ import annotations

import json
import sys
import unittest
from datetime import timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from helm_worker_contract import (  # noqa: E402
    EPISODE_MEDIA_TYPE,
    EXTENSION_URI,
    STATUS_MEDIA_TYPE,
    Episode,
    EpisodeError,
    OutcomeTracker,
    ToolResult,
    build_prompts,
    episode_from_message,
    find_status_payload,
    load_schema,
    parse_episode,
    render_agent_card,
    require_supported_api,
    schema_issues,
    status_metadata,
    status_parts,
    status_payload,
)

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"
CASES: dict[str, Any] = json.loads((FIXTURES / "episode.cases.json").read_text())
OUTCOMES: list[dict[str, Any]] = json.loads((FIXTURES / "outcome.cases.json").read_text())
PROMPT: dict[str, Any] = json.loads((FIXTURES / "prompt.golden.json").read_text())


class EpisodeTests(unittest.TestCase):
    def test_valid_episodes_parse(self) -> None:
        for name, raw in CASES["valid"].items():
            with self.subTest(name):
                episode = parse_episode(raw)
                self.assertEqual(episode.credentials_env, "HELM_EPISODE_TOKEN")
                self.assertIs(episode.deadline.tzinfo, timezone.utc)

    def test_full_episode_fields(self) -> None:
        episode = parse_episode(CASES["valid"]["full"])
        self.assertEqual(episode.continuation, 2)
        self.assertEqual(episode.seat.key, "engineer_1")
        self.assertEqual(episode.tools.allowed[-1], "helm_work_report")
        self.assertEqual(episode.model.api, "anthropic-messages")
        self.assertEqual(episode.deadline.isoformat(), "2026-10-01T12:00:00+00:00")

    def test_minimal_episode_defaults(self) -> None:
        episode = parse_episode(CASES["valid"]["minimal"])
        self.assertEqual((episode.continuation, episode.context, episode.seat.role), (0, {}, ""))
        # 12:00:00.5 at +03:00 is 09:00:00.5 UTC.
        self.assertEqual(episode.deadline.isoformat(), "2026-10-01T09:00:00.500000+00:00")

    def test_base_url_loses_its_trailing_slash_and_unknown_members_are_ignored(self) -> None:
        episode = parse_episode(CASES["valid"]["responses_api"])
        self.assertEqual(episode.model.base_url, "https://helm-gateway-worker.helm.svc:8443")

    def test_invalid_episodes_are_rejected(self) -> None:
        for name, raw in CASES["invalid"].items():
            with self.subTest(name):
                with self.assertRaises(EpisodeError) as caught:
                    parse_episode(raw)
                self.assertEqual(caught.exception.code, "INVALID_EPISODE")

    def test_schema_issues_name_the_path(self) -> None:
        issues = schema_issues("episode.v1", CASES["invalid"]["unknown_api"])
        self.assertTrue(any(issue.startswith("model/api:") for issue in issues), issues)

    def test_episode_from_message(self) -> None:
        message = {
            "parts": [
                {"text": "goal"},
                {"data": CASES["valid"]["full"], "mediaType": EPISODE_MEDIA_TYPE},
            ]
        }
        self.assertIsInstance(episode_from_message(message), Episode)
        with self.assertRaises(EpisodeError):
            episode_from_message({"parts": [{"text": "goal"}]})
        with self.assertRaises(EpisodeError):
            # Right payload, wrong media type: not the episode part.
            episode_from_message(
                {"parts": [{"data": CASES["valid"]["full"], "mediaType": "application/json"}]}
            )

    def test_unsupported_model_api(self) -> None:
        episode = parse_episode(CASES["valid"]["full"])
        require_supported_api(episode, ["anthropic-messages"])
        with self.assertRaises(EpisodeError) as caught:
            require_supported_api(episode, ["openai-responses"])
        self.assertEqual(caught.exception.code, "UNSUPPORTED_MODEL_API")

    def test_prompts_match_the_golden_file(self) -> None:
        system, user = build_prompts(parse_episode(CASES["valid"][PROMPT["episode"]]))
        self.assertEqual(system, PROMPT["system"])
        self.assertEqual(user, PROMPT["user"])


class OutcomeTests(unittest.TestCase):
    def test_vectors(self) -> None:
        for case in OUTCOMES:
            with self.subTest(case["name"]):
                tracker = OutcomeTracker()
                seen = []
                for call in case["calls"]:
                    result = ToolResult(
                        is_error=call["result"].get("is_error", False),
                        structured=call["result"].get("structured"),
                        text=call["result"].get("text"),
                    )
                    observation = tracker.observe(call["tool"], call["arguments"], result)
                    seen.append(
                        {"kind": observation.kind, "stop": observation.stop}
                        | ({"reason": observation.reason} if observation.reason else {})
                    )
                self.assertEqual(seen, case["expect"]["observations"])
                outcome = tracker.outcome("final words")
                want = case["expect"]["outcome"]
                self.assertEqual(outcome.state, want["state"])
                if "status" in want:
                    self.assertEqual(outcome.status, want["status"])
                if "code" in want:
                    self.assertEqual(outcome.status["error"]["code"], want["code"])

    def test_stopped_property(self) -> None:
        tracker = OutcomeTracker()
        self.assertFalse(tracker.stopped)
        tracker.observe(
            "helm_work_report",
            {"status": "done", "summary": "s"},
            ToolResult(structured={"status": "succeeded"}),
        )
        self.assertTrue(tracker.stopped)

    def test_mirrors(self) -> None:
        tracker = OutcomeTracker()
        seen = tracker.observe(
            "github_pull_request_create_draft",
            {"title": "t"},
            ToolResult(structured={"status": "escalated", "attempt_id": "att_1"}),
        )
        self.assertEqual(
            seen.proposal,
            {
                "schema": "helm.proposal.v1",
                "tool": "github_pull_request_create_draft",
                "arguments": {"title": "t"},
                "status": "escalated",
                "attempt_id": "att_1",
            },
        )
        self.assertEqual(schema_issues("proposal.v1", seen.proposal), [])
        reported = tracker.observe(
            "helm_work_report",
            {
                "status": "blocked",
                "summary": "s",
                "outputs": [{"kind": "pr", "ref": "7"}, {"kind": "x"}],
            },
            ToolResult(structured={"status": "succeeded"}),
        )
        assert reported.report is not None
        self.assertEqual(reported.report["outputs"], [{"kind": "pr", "ref": "7"}])
        self.assertEqual(schema_issues("report.v1", reported.report), [])


class StatusTests(unittest.TestCase):
    def test_payloads_validate_and_round_trip(self) -> None:
        payloads = [
            status_payload(waiting_on={"attempts": ["a"]}),
            status_payload(waiting_on={"children": []}),
            status_payload(waiting_on={"input": {"question": "q", "options": []}}),
            status_payload(error=("NO_REPORT", "m")),
            status_payload(report={"status": "done", "summary": "s"}),
        ]
        for payload in payloads:
            with self.subTest(payload):
                self.assertEqual(schema_issues("status.v1", payload), [])
                parts = status_parts("text", payload)
                self.assertEqual(parts[1]["mediaType"], STATUS_MEDIA_TYPE)
                self.assertEqual(find_status_payload(parts), payload)
                self.assertNotIn("schema", status_metadata(payload))

    def test_invalid_payloads(self) -> None:
        self.assertNotEqual(
            schema_issues("status.v1", {"schema": "helm.episode.status.v1", "waiting_on": {}}), []
        )
        self.assertNotEqual(
            schema_issues("status.v1", status_payload(error=("SOMETHING_ELSE", "m"))), []
        )
        self.assertNotEqual(
            schema_issues("status.v1", status_payload(waiting_on={"attempts": []})), []
        )


class AgentCardTests(unittest.TestCase):
    def test_render(self) -> None:
        card = render_agent_card(
            framework="langgraph",
            url="http://worker:8080/",
            version="1.2.3",
            model_apis=["anthropic-messages", "openai-chat-completions"],
        )
        interface = card["supportedInterfaces"][0]
        self.assertEqual(
            interface,
            {"url": "http://worker:8080/", "protocolBinding": "JSONRPC", "protocolVersion": "1.0"},
        )
        (extension,) = card["capabilities"]["extensions"]
        self.assertEqual(extension["uri"], EXTENSION_URI)
        self.assertIs(extension["required"], True)
        self.assertEqual(
            extension["params"]["model_apis"], ["anthropic-messages", "openai-chat-completions"]
        )
        self.assertIs(card["capabilities"]["streaming"], True)
        self.assertIn(EPISODE_MEDIA_TYPE, card["defaultInputModes"])
        self.assertNotIn("{{", json.dumps(card))
        self.assertEqual(card["name"], "HELM worker (langgraph)")

    def test_schemas_are_loadable(self) -> None:
        for name in ("episode.v1", "status.v1", "proposal.v1", "report.v1"):
            self.assertIn("$id", load_schema(name))


if __name__ == "__main__":
    unittest.main()
