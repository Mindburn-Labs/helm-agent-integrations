import json
import threading
import unittest
import uuid
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from helm_worker_contract import CONTROL_EXTENSION_URI, EXTENSION_URI, PAUSE, RESUME, STEER
from helm_worker_runtime import Session, Worker
from helm_worker_runtime.server import Task


class UnavailableControlTests(unittest.TestCase):
    def setUp(self) -> None:
        self.started = 0

        async def engine(_session: Session) -> None:
            self.started += 1
            raise AssertionError("A control request must not start another engine")

        self.ingress = str(uuid.uuid4())
        self.worker = Worker(
            "openclaw", ("openai-responses",), engine, ingress_token=self.ingress, env={}
        )
        self.task = Task(str(uuid.uuid4()), str(uuid.uuid4()))
        self.task.state = "TASK_STATE_WORKING"
        self.task.status["state"] = self.task.state
        self.worker.tasks[self.task.id] = self.task
        self.url = self.worker.start()

    def tearDown(self) -> None:
        self.worker.stop()

    def request(
        self, method: str, params: dict[str, Any], *, authenticated: bool = True
    ) -> dict[str, Any]:
        headers = {
            "Content-Type": "application/json",
            "A2A-Version": "1.0",
            "A2A-Extensions": EXTENSION_URI + "," + CONTROL_EXTENSION_URI,
        }
        if authenticated:
            headers["Authorization"] = "Bearer " + self.ingress
        wire = {"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": method, "params": params}
        with urlopen(
            Request(self.url + "/", json.dumps(wire).encode(), headers), timeout=3
        ) as response:
            result: dict[str, Any] = json.load(response)
        return result

    def test_each_unsupported_verb_returns_reason_without_cancel_or_second_task(self) -> None:
        requests = [
            ("SendMessage", {"message": {"taskId": self.task.id}}, STEER),
            ("message/send", {"message": {"taskId": self.task.id}}, STEER),
            ("SendStreamingMessage", {"message": {"taskId": self.task.id}}, STEER),
            (PAUSE, {"taskId": self.task.id}, PAUSE),
            (RESUME, {"id": self.task.id}, RESUME),
        ]
        for method, params, verb in requests:
            with self.subTest(method=method):
                error = self.request(method, params)["error"]
                self.assertEqual(error["code"], -32010)
                self.assertEqual(error["data"]["extension"], CONTROL_EXTENSION_URI)
                self.assertEqual(error["data"]["verb"], verb)
                self.assertEqual(error["data"]["taskId"], self.task.id)
                self.assertIs(error["data"]["supported"], False)
                self.assertIn("one-shot isolated child process", error["data"]["reason"])
        self.assertEqual(self.started, 0)
        self.assertEqual(set(self.worker.tasks), {self.task.id})
        self.assertFalse(self.task.cancel.is_set())
        self.assertEqual(self.task.state, "TASK_STATE_WORKING")
        self.assertEqual(self.task.events, [])

    def test_foreign_missing_and_conflicting_task_identity_never_admits_work(self) -> None:
        foreign = str(uuid.uuid4())
        for method, params, code in [
            ("SendMessage", {"message": {"taskId": foreign}}, -32001),
            (PAUSE, {"taskId": foreign}, -32001),
            (RESUME, {"taskId": self.task.id, "id": foreign}, -32602),
            ("SendMessage", {"message": {}}, -32602),
            ("SendStreamingMessage", {"message": {"taskId": None}}, -32602),
        ]:
            with self.subTest(method=method, params=params):
                self.assertEqual(self.request(method, params)["error"]["code"], code)
        self.worker.tasks.clear()
        self.assertEqual(
            self.request("SendMessage", {"message": {"taskId": foreign}})["error"]["code"],
            -32001,
        )
        self.assertEqual(self.worker.tasks, {})
        self.assertEqual(self.started, 0)
        self.assertFalse(self.task.cancel.is_set())

    def test_control_authentication_is_required_and_errors_do_not_expose_ingress(self) -> None:
        with self.assertRaises(HTTPError) as denied:
            self.request(PAUSE, {"taskId": self.task.id}, authenticated=False)
        self.assertEqual(denied.exception.code, 401)
        self.assertNotIn(self.ingress, denied.exception.read().decode())
        self.assertFalse(self.task.cancel.is_set())
        self.assertEqual(self.started, 0)

    def test_cancel_remains_terminal_and_never_reports_paused(self) -> None:
        def complete_cancel() -> None:
            if self.task.cancel.wait(timeout=2):
                self.worker.status(self.task, "TASK_STATE_CANCELED", "Cancelled.")

        completion = threading.Thread(target=complete_cancel, daemon=True)
        completion.start()
        result = self.request("CancelTask", {"id": self.task.id})["result"]
        completion.join(timeout=2)
        self.assertFalse(completion.is_alive())
        self.assertTrue(self.task.cancel.is_set())
        self.assertEqual(result["status"]["state"], "TASK_STATE_CANCELED")
        self.assertNotIn("paused", json.dumps(result))
        self.assertEqual(self.started, 0)


if __name__ == "__main__":
    unittest.main()
