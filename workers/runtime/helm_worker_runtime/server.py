"""One pod, one bounded episode; reconnects replay the in-memory A2A stream.

The CP owns durable episode state and creates a new pod for a continuation. This server only
retains the current task for GetTask/SubscribeToTask while its pod exists.
"""

from __future__ import annotations

import asyncio
import hmac
import os
import threading
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any

from helm_worker_contract import (
    EXTENSION_URI,
    Episode,
    EpisodeError,
    OutcomeTracker,
    ToolResult,
    episode_from_message,
    render_agent_card,
    require_supported_api,
    status_metadata,
    status_parts,
    status_payload,
)

from .http import Request, serve, stop

TERMINAL = {
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_REJECTED",
    "TASK_STATE_INPUT_REQUIRED",
}


class Cancelled(Exception):
    pass


class DeadlineExceeded(Exception):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Task:
    def __init__(self, ident: str, context: str) -> None:
        self.id, self.context = ident, context
        self.state = "TASK_STATE_SUBMITTED"
        self.events: list[dict[str, Any]] = []
        self.artifacts: list[dict[str, Any]] = []
        self.condition = threading.Condition()
        self.cancel = threading.Event()
        self.status: dict[str, Any] = {"state": self.state, "timestamp": now()}

    def publish(self, member: str, value: dict[str, Any]) -> None:
        with self.condition:
            if self.state in TERMINAL:
                return
            self.events.append({member: value})
            if member in ("task", "statusUpdate"):
                self.status = value["status"]
                self.state = self.status["state"]
            if member == "artifactUpdate":
                self.artifacts.append(value["artifact"])
            self.condition.notify_all()

    def snapshot(self) -> dict[str, Any]:
        with self.condition:
            return {
                "id": self.id,
                "contextId": self.context,
                "status": dict(self.status),
                "artifacts": list(self.artifacts),
            }


class Session:
    def __init__(self, worker: Worker, task: Task, episode: Episode, token: str) -> None:
        self.worker, self.task, self.episode, self.token = worker, task, episode, token
        self.tracker = OutcomeTracker()
        self.last_text = ""

    def guard(self) -> None:
        if self.task.cancel.is_set():
            raise Cancelled
        if self.episode.seconds_left() <= 0:
            raise DeadlineExceeded

    def observe(self, name: str, args: Any, result: ToolResult) -> bool:
        self.guard()
        if name not in self.episode.tools.allowed or self.tracker.stopped:
            raise ValueError("Tool is not allowed in this episode")
        observation = self.tracker.observe(name, args, result)
        if observation.proposal:
            self.worker.artifact(self.task, "helm.proposal", observation.proposal)
        if observation.report:
            self.worker.artifact(self.task, "helm.report", observation.report)
        return observation.stop

    def progress(self, text: str = "Working.") -> None:
        self.guard()
        self.worker.status(self.task, "TASK_STATE_WORKING", text)


Engine = Callable[[Session], Awaitable[None]]


class Worker:
    def __init__(
        self,
        framework: str,
        apis: tuple[str, ...],
        engine: Engine,
        *,
        ingress_token: str,
        env: dict[str, str],
    ) -> None:
        if not ingress_token:
            raise ValueError("HELM_A2A_BEARER_TOKEN must be set")
        self.framework, self.apis, self.engine = framework, apis, engine
        self.ingress_token, self.env = ingress_token, env
        self.tasks: dict[str, Task] = {}
        self.lock = threading.Lock()
        self.server: Any = None

    def start(self, host: str = "127.0.0.1", port: int = 0) -> str:
        self.server = serve(self.handle, host, port)
        return f"http://{host}:{self.server.server_address[1]}"

    def stop(self) -> None:
        for task in self.tasks.values():
            task.cancel.set()
        if self.server:
            stop(self.server)

    def safe(self, value: Any) -> Any:
        # SDK errors or malicious tool content must not expose bearer credentials.
        if isinstance(value, str):
            for token in {self.ingress_token, self.env.get("HELM_EPISODE_TOKEN", "")}:
                if token:
                    value = value.replace(token, "[REDACTED]")
            return value
        if isinstance(value, dict):
            return {self.safe(key): self.safe(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self.safe(item) for item in value]
        return value

    def status(
        self, task: Task, state: str, text: str, payload: dict[str, Any] | None = None
    ) -> None:
        message = {
            "messageId": str(uuid.uuid4()),
            "role": "ROLE_AGENT",
            "taskId": task.id,
            "contextId": task.context,
            "parts": status_parts(text, payload)
            if payload
            else [{"text": text, "mediaType": "text/plain"}],
        }
        body: dict[str, Any] = {
            "taskId": task.id,
            "contextId": task.context,
            "status": {"state": state, "timestamp": now(), "message": message},
        }
        if payload:
            body["metadata"] = status_metadata(payload)
        task.publish("statusUpdate", self.safe(body))

    def artifact(self, task: Task, name: str, data: dict[str, Any]) -> None:
        task.publish(
            "artifactUpdate",
            self.safe(
                {
                    "taskId": task.id,
                    "contextId": task.context,
                    "artifact": {
                        "artifactId": str(uuid.uuid4()),
                        "name": name,
                        "parts": [{"data": data, "mediaType": "application/json"}],
                    },
                }
            ),
        )

    def handle(self, req: Request) -> None:
        if req.method == "GET" and req.path == "/.well-known/agent-card.json":
            public = self.env.get("HELM_A2A_PUBLIC_URL", f"http://{req.header('Host')}/")
            req.respond_json(
                200,
                render_agent_card(
                    framework=self.framework,
                    url=public,
                    version="0.1.0",
                    model_apis=list(self.apis),
                ),
            )
            return
        if req.method != "POST" or req.path != "/":
            req.respond_json(404, {"error": "not found"})
            return
        if not hmac.compare_digest(req.bearer() or "", self.ingress_token):
            req.respond_json(401, {"error": "unauthorized"}, WWW_Authenticate="Bearer")
            return
        try:
            body = req.json()
            if not isinstance(body, dict) or body.get("jsonrpc") != "2.0":
                raise ValueError
            method, ident, params = body["method"], body.get("id"), body.get("params") or {}
            if not isinstance(params, dict):
                raise TypeError
        except (ValueError, KeyError, TypeError):
            req.respond_json(
                200,
                {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}},
            )
            return

        def error(code: int, text: str) -> None:
            req.respond_json(
                200, {"jsonrpc": "2.0", "id": ident, "error": {"code": code, "message": text}}
            )

        if EXTENSION_URI not in [s.strip() for s in req.header("A2A-Extensions").split(",")]:
            error(-32008, "Extension support required")
            return
        if req.header("A2A-Version") not in ("", "1.0"):
            error(-32009, "Unsupported protocol version")
            return
        if method == "SendStreamingMessage":
            message = params.get("message") or {}
            if not isinstance(message, dict):
                error(-32602, "Invalid message")
                return
            with self.lock:
                if self.tasks:
                    error(
                        -32602,
                        "This sandbox already has an episode; use GetTask or SubscribeToTask",
                    )
                    return
                task = Task(str(uuid.uuid4()), str(message.get("contextId") or uuid.uuid4()))
                self.tasks[task.id] = task
            threading.Thread(target=self.run, args=(task, message), daemon=True).start()
            self.stream(req, ident, task, replay=True)
            return
        task = self.tasks.get(str(params.get("id", "")))
        if task is None:
            error(-32001, "Task not found")
        elif method == "GetTask":
            req.respond_json(200, {"jsonrpc": "2.0", "id": ident, "result": task.snapshot()})
        elif method == "SubscribeToTask":
            self.stream(req, ident, task, replay=False)
        elif method == "CancelTask":
            if task.state in TERMINAL:
                error(-32002, "Task is not cancelable")
                return
            task.cancel.set()
            with task.condition:
                task.condition.wait_for(lambda: task.state in TERMINAL, timeout=5)
            req.respond_json(200, {"jsonrpc": "2.0", "id": ident, "result": task.snapshot()})
        else:
            error(-32601, "Method not found")

    def stream(self, req: Request, ident: Any, task: Task, *, replay: bool) -> None:
        req.start_sse()
        sent = 0
        if not replay:
            # Snapshot and event cursor are captured under the same lock; no update is lost.
            with task.condition:
                snapshot, sent = task.snapshot(), len(task.events)
            if not req.sse({"jsonrpc": "2.0", "id": ident, "result": {"task": snapshot}}):
                return
            if snapshot["status"]["state"] in TERMINAL:
                return
        while True:
            with task.condition:
                while sent >= len(task.events):
                    if task.state in TERMINAL or req.client_gone():
                        return
                    task.condition.wait(0.1)
                pending = task.events[sent:]
                sent = len(task.events)
            for event in pending:
                if not req.sse({"jsonrpc": "2.0", "id": ident, "result": event}):
                    return
                update = event.get("statusUpdate")
                if update and update["status"]["state"] in TERMINAL:
                    return

    async def bounded(self, session: Session) -> None:
        session.guard()
        operation = asyncio.create_task(self.engine(session))
        try:
            while not operation.done():
                session.guard()
                await asyncio.wait({operation}, timeout=0.05)
            await operation
            session.guard()
        finally:
            if not operation.done():
                operation.cancel()
                try:
                    await asyncio.wait_for(operation, 3)
                except (asyncio.CancelledError, asyncio.TimeoutError):
                    pass

    def run(self, task: Task, message: dict[str, Any]) -> None:
        task.publish("task", task.snapshot())
        try:
            episode = episode_from_message(message)
            require_supported_api(episode, self.apis)
            if episode.credentials_env != "HELM_EPISODE_TOKEN":
                raise EpisodeError("MISSING_CREDENTIAL", "Only HELM_EPISODE_TOKEN is supported")
            token = self.env.get(episode.credentials_env)
            if not token:
                raise EpisodeError("MISSING_CREDENTIAL", "Episode token is not set")
        except EpisodeError as exc:
            self.status(
                task,
                "TASK_STATE_REJECTED",
                exc.message,
                status_payload(error=(exc.code, exc.message)),
            )
            return
        self.status(task, "TASK_STATE_WORKING", "Starting episode.")
        session = Session(self, task, episode, token)
        try:
            asyncio.run(self.bounded(session))
            outcome = session.tracker.outcome(session.last_text)
            state = {
                "completed": "TASK_STATE_COMPLETED",
                "input_required": "TASK_STATE_INPUT_REQUIRED",
                "failed": "TASK_STATE_FAILED",
            }[outcome.state]
            self.status(task, state, outcome.text, outcome.status)
        except Cancelled:
            self.status(task, "TASK_STATE_CANCELED", "Cancelled.")
        except DeadlineExceeded:
            self.status(
                task,
                "TASK_STATE_FAILED",
                "Episode deadline exceeded.",
                status_payload(error=("DEADLINE_EXCEEDED", "Episode deadline exceeded.")),
            )
        except Exception:  # noqa: BLE001 - always terminate the A2A stream without leaking SDK data
            # Vendor exceptions may carry headers, request bodies or credentials. Keep them out
            # of A2A and container logs; CP/gateway own the detailed attempt evidence.
            self.status(
                task,
                "TASK_STATE_FAILED",
                "Framework or model call failed.",
                status_payload(error=("MODEL_ERROR", "Framework or model call failed.")),
            )


def serve_worker(framework: str, apis: tuple[str, ...], engine: Engine) -> None:
    worker = Worker(
        framework,
        apis,
        engine,
        ingress_token=os.environ.get("HELM_A2A_BEARER_TOKEN", ""),
        env=dict(os.environ),
    )
    worker.start("0.0.0.0", int(os.environ.get("PORT", "8080")))
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        worker.stop()
