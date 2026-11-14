import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from helm_worker_contract import ToolResult, bind_target, parse_episode
from helm_worker_runtime import Worker
from helm_worker_runtime.server import Session, Task

FIXTURES = Path(__file__).resolve().parents[2] / "contract" / "fixtures"
# The shared fixture episode, with a deadline still ahead so the session accepts calls.
EPISODE = {
    **json.loads((FIXTURES / "episode.cases.json").read_text())["valid"]["full"],
    "deadline": (datetime.now(timezone.utc) + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
OWN = "work:" + EPISODE["work_item_id"]
REPORT = {"status": "done", "summary": "Fixed."}


def notes(task: Task) -> list[str]:
    return [
        part["text"]
        for event in task.events
        for member, body in event.items()
        if member == "statusUpdate" and body["status"]["state"] == "TASK_STATE_WORKING"
        for part in body["status"]["message"]["parts"]
    ]


class SessionBindingTests(unittest.TestCase):
    def setUp(self) -> None:
        worker = Worker("test", (), None, ingress_token="ingress", env={})  # type: ignore[arg-type]
        self.task = Task("task-1", "context-1")
        self.session = Session(worker, self.task, parse_episode(EPISODE), "episode-token")

    def test_targets_are_the_episodes_own(self) -> None:
        self.assertEqual(self.session.targets["helm_work_report"], OWN)
        self.assertEqual(self.session.targets["helm_org_request_capability"], "org:org-7a1")

    def test_a_refused_call_is_noted_and_does_not_stop_the_episode(self) -> None:
        wrong = {"target": "work:0b7e3c1a-7ef7-4c6f-8a90-3e4f5a6b7c02", "arguments": REPORT}
        _, refusal = bind_target("helm_work_report", wrong, self.session.targets)
        assert refusal is not None
        self.assertFalse(self.session.observe("helm_work_report", wrong, refusal))
        self.assertFalse(self.session.tracker.stopped)
        self.assertEqual(len(notes(self.task)), 1)
        self.assertIn("helm_work_report", notes(self.task)[0])
        self.assertIn("SCHEMA_VIOLATION", notes(self.task)[0])

    def test_a_sent_call_with_the_bound_target_is_not_noted(self) -> None:
        sent, refusal = bind_target("helm_work_report", {"arguments": REPORT}, self.session.targets)
        self.assertIsNone(refusal)
        stop = self.session.observe(
            "helm_work_report", sent, ToolResult(structured={"status": "succeeded"})
        )
        self.assertTrue(stop)
        self.assertEqual(notes(self.task), [])


if __name__ == "__main__":
    unittest.main()
