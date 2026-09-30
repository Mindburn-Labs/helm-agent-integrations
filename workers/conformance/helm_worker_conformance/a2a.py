"""A minimal A2A v1.0 JSON-RPC client written from the specification, not from an SDK.

It plays the control plane's side: it sends the episode as the first message, reads the SSE
stream, and cancels or re-subscribes. It is deliberately strict about the wire format, because
the control plane's Go client (a2a-go) is.
"""

from __future__ import annotations

import http.client
import json
import socket
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

TERMINAL_STATES = frozenset(
    {"TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"}
)
INTERRUPTED_STATES = frozenset({"TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"})
ALL_STATES = TERMINAL_STATES | INTERRUPTED_STATES | {"TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"}
STREAM_MEMBERS = ("task", "message", "statusUpdate", "artifactUpdate")


@dataclass
class HttpResult:
    status: int
    headers: dict[str, str]
    body: bytes
    t_sent: float
    t_done: float

    def json(self) -> Any:
        return json.loads(self.body or b"null")


def _connect(url: str, timeout: float) -> tuple[http.client.HTTPConnection, str]:
    parts = urlsplit(url)
    cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    conn = cls(parts.hostname or "", parts.port, timeout=timeout)
    path = parts.path or "/"
    return conn, path + (f"?{parts.query}" if parts.query else "")


def http_request(
    method: str,
    url: str,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    timeout: float = 30.0,
) -> HttpResult:
    conn, path = _connect(url, timeout)
    try:
        sent = time.monotonic()
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        data = response.read()
        return HttpResult(
            response.status,
            {k.lower(): v for k, v in response.getheaders()},
            data,
            sent,
            time.monotonic(),
        )
    finally:
        conn.close()


@dataclass
class Event:
    """One decoded StreamResponse."""

    t: float
    kind: str  # task | message | statusUpdate | artifactUpdate | unknown
    body: dict[str, Any]
    raw: dict[str, Any]  # the whole JSON-RPC envelope
    sse_event: str | None = None

    @property
    def state(self) -> str | None:
        if self.kind in ("task", "statusUpdate"):
            status = self.body.get("status")
            return status.get("state") if isinstance(status, dict) else None
        return None


class Stream:
    """An open SSE response read on a background thread."""

    def __init__(
        self, url: str, headers: dict[str, str], payload: dict[str, Any], timeout: float
    ) -> None:
        self.events: list[Event] = []
        self.rpc_error: dict[str, Any] | None = None
        self.result: Any = None  # a non-streamed JSON-RPC result, if the server answered that way
        self.http_status = 0
        self.content_type = ""
        self.error: str | None = None
        self.t_sent = 0.0
        self.t_closed: float | None = None
        self._cond = threading.Condition()
        self._conn, path = _connect(url, timeout)
        self._headers = {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            **headers,
        }
        self._body = json.dumps(payload).encode()
        self._path = path
        self._thread = threading.Thread(target=self._read, daemon=True, name="a2a-stream")
        self._thread.start()

    # -- reading ---------------------------------------------------------------------------

    def _read(self) -> None:
        try:
            self.t_sent = time.monotonic()
            self._conn.request("POST", self._path, body=self._body, headers=self._headers)
            # http.client hands the socket to the response once it will close; keep our own
            # reference so close() can still drop the connection.
            self._sock = self._conn.sock
            response = self._conn.getresponse()
            self.http_status = response.status
            self.content_type = response.getheader("Content-Type", "") or ""
            if "text/event-stream" not in self.content_type:
                self._absorb_json(response.read())
                return
            event_name: str | None = None
            data_lines: list[str] = []
            while True:
                line = response.readline()
                if not line:
                    break
                text = line.decode("utf-8", "replace").rstrip("\r\n")
                if text == "":
                    if data_lines:
                        self._absorb_event(event_name, "\n".join(data_lines))
                    event_name, data_lines = None, []
                elif text.startswith("event:"):
                    event_name = text[6:].strip()
                elif text.startswith("data:"):
                    data_lines.append(text[5:].lstrip(" "))
            if data_lines:
                self._absorb_event(event_name, "\n".join(data_lines))
        except (OSError, http.client.HTTPException) as exc:
            with self._cond:
                self.error = f"{type(exc).__name__}: {exc}"
        finally:
            with self._cond:
                self.t_closed = time.monotonic()
                self._cond.notify_all()
            try:
                self._conn.close()
            except OSError:
                pass

    def _absorb_json(self, body: bytes) -> None:
        try:
            envelope = json.loads(body or b"null")
        except ValueError:
            with self._cond:
                self.error = f"non-JSON body (HTTP {self.http_status}): {body[:200]!r}"
            return
        with self._cond:
            if isinstance(envelope, dict) and "error" in envelope:
                self.rpc_error = envelope["error"]
            elif isinstance(envelope, dict) and "result" in envelope:
                self.result = envelope["result"]
            else:
                self.error = f"unexpected body (HTTP {self.http_status}): {body[:200]!r}"

    def _absorb_event(self, sse_event: str | None, data: str) -> None:
        now = time.monotonic()
        try:
            envelope = json.loads(data)
        except ValueError:
            with self._cond:
                self.error = f"SSE data is not JSON: {data[:200]!r}"
            return
        with self._cond:
            if not isinstance(envelope, dict):
                self.error = f"SSE data is not an object: {data[:200]!r}"
            elif "error" in envelope:
                self.rpc_error = envelope["error"]
            else:
                result = envelope.get("result")
                members = [m for m in STREAM_MEMBERS if isinstance(result, dict) and m in result]
                kind = members[0] if len(members) == 1 else "unknown"
                body = result[kind] if kind != "unknown" and isinstance(result, dict) else {}
                self.events.append(
                    Event(now, kind, body if isinstance(body, dict) else {}, envelope, sse_event)
                )
            self._cond.notify_all()

    # -- waiting ---------------------------------------------------------------------------

    def wait(self, predicate: Callable[["Stream"], bool], timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        with self._cond:
            while not predicate(self):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._cond.wait(min(remaining, 0.25))
        return True

    def wait_closed(self, timeout: float) -> bool:
        return self.wait(lambda s: s.t_closed is not None, timeout)

    @property
    def closed(self) -> bool:
        return self.t_closed is not None

    def close(self) -> None:
        """Drop the connection like a control plane that restarted."""
        sock = self._sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()

    # -- views -----------------------------------------------------------------------------

    def snapshot(self) -> list[Event]:
        with self._cond:
            return list(self.events)

    def states(self) -> list[str]:
        return [e.state for e in self.snapshot() if e.state]

    def final_state(self) -> str | None:
        states = self.states()
        return states[-1] if states else None

    def task_id(self) -> str | None:
        for event in self.snapshot():
            if event.kind == "task" and isinstance(event.body.get("id"), str):
                return str(event.body["id"])
            if event.kind in ("statusUpdate", "artifactUpdate") and event.body.get("taskId"):
                return str(event.body["taskId"])
        return None

    def last_status_event(self) -> Event | None:
        for event in reversed(self.snapshot()):
            if event.kind == "statusUpdate":
                return event
        return None


@dataclass
class A2AClient:
    base_url: str
    ingress_token: str | None
    rpc_url: str = ""
    timeout: float = 30.0
    version: str = "1.0"
    card: dict[str, Any] = field(default_factory=dict)

    def card_url(self) -> str:
        return self.base_url.rstrip("/") + "/.well-known/agent-card.json"

    def fetch_card(self) -> HttpResult:
        result = http_request("GET", self.card_url(), timeout=self.timeout)
        if result.status == 200:
            try:
                self.card = result.json()
                interfaces = self.card.get("supportedInterfaces") or []
                self.rpc_url = interfaces[0]["url"] if interfaces else ""
            except (ValueError, KeyError, IndexError, TypeError, AttributeError):
                self.card = {}
        return result

    def _headers(
        self, *, bearer: str | None, extensions: list[str] | None, version: str | None
    ) -> dict[str, str]:
        headers: dict[str, str] = {}
        if bearer is not None:
            headers["Authorization"] = f"Bearer {bearer}"
        if extensions:
            headers["A2A-Extensions"] = ",".join(extensions)
        if version is not None:
            headers["A2A-Version"] = version
        return headers

    def _envelope(self, method: str, params: dict[str, Any] | None) -> dict[str, Any]:
        envelope: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": f"kit-{time.monotonic_ns()}",
            "method": method,
        }
        if params is not None:
            envelope["params"] = params
        return envelope

    def _url(self) -> str:
        return self.rpc_url or self.base_url

    def call(
        self,
        method: str,
        params: dict[str, Any] | None,
        *,
        bearer: str | None | bool = True,
        extensions: list[str] | None = None,
        version: str | None = "1.0",
        timeout: float | None = None,
    ) -> HttpResult:
        token = self.ingress_token if bearer is True else (bearer or None)
        headers = {
            "Content-Type": "application/json",
            **self._headers(bearer=token, extensions=extensions, version=version),
        }
        return http_request(
            "POST",
            self._url(),
            headers,
            json.dumps(self._envelope(method, params)).encode(),
            timeout or self.timeout,
        )

    def stream(
        self,
        method: str,
        params: dict[str, Any],
        *,
        bearer: str | None | bool = True,
        extensions: list[str] | None = None,
        version: str | None = "1.0",
    ) -> Stream:
        token = self.ingress_token if bearer is True else (bearer or None)
        return Stream(
            self._url(),
            self._headers(bearer=token, extensions=extensions, version=version),
            self._envelope(method, params),
            self.timeout,
        )


def episode_message(episode: dict[str, Any], episode_media_type: str) -> dict[str, Any]:
    """SendStreamingMessage params: goal text plus the episode data part, as the CP sends them."""
    return {
        "message": {
            "messageId": episode["episode_id"],
            "contextId": episode["work_item_id"],
            "role": "ROLE_USER",
            "parts": [
                {"text": episode["goal"], "mediaType": "text/plain"},
                {"data": episode, "mediaType": episode_media_type},
            ],
        },
        "configuration": {"returnImmediately": False},
    }
