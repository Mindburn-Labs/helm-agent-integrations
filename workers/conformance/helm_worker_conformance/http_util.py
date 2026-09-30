"""A small threaded HTTP server for the stubs: JSON and SSE responses, disconnect detection."""

from __future__ import annotations

import json
import select
import socket
import sys
import threading
import time
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit


class Request:
    """One HTTP request being served. The handler runs on its own thread."""

    def __init__(self, handler: BaseHTTPRequestHandler, body: bytes) -> None:
        self._handler = handler
        self.method = handler.command
        parts = urlsplit(handler.path)
        self.path = parts.path
        self.query = parse_qs(parts.query)
        self.headers = handler.headers
        self.body = body
        self.peer: str = handler.client_address[0]
        self.received_at = time.monotonic()
        self.responded = False

    def json(self) -> Any:
        return json.loads(self.body or b"null")

    def header(self, name: str) -> str:
        return self.headers.get(name, "") or ""

    def bearer(self) -> str | None:
        value = self.header("Authorization")
        return value[7:].strip() if value.lower().startswith("bearer ") else None

    def respond(
        self, status: int, body: bytes = b"", content_type: str | None = None, **headers: str
    ) -> None:
        self.responded = True
        h = self._handler
        h.send_response(status)
        if content_type:
            h.send_header("Content-Type", content_type)
        for name, value in headers.items():
            h.send_header(name.replace("_", "-"), value)
        h.send_header("Content-Length", str(len(body)))
        h.end_headers()
        if self.method != "HEAD":
            h.wfile.write(body)
            h.wfile.flush()

    def respond_json(self, status: int, payload: Any, **headers: str) -> None:
        self.respond(status, json.dumps(payload).encode(), "application/json", **headers)

    def start_sse(self) -> None:
        self.responded = True
        h = self._handler
        h.send_response(200)
        h.send_header("Content-Type", "text/event-stream")
        h.send_header("Cache-Control", "no-cache")
        h.send_header("Connection", "close")
        h.end_headers()
        h.close_connection = True

    def sse(self, data: Any, event: str | None = None) -> bool:
        """Write one SSE event; False when the client has gone."""
        text = data if isinstance(data, str) else json.dumps(data)
        frame = (f"event: {event}\n" if event else "") + f"data: {text}\n\n"
        try:
            self._handler.wfile.write(frame.encode())
            self._handler.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return False
        return True

    def client_gone(self) -> bool:
        """True once the peer closed the connection (checked without consuming data)."""
        sock: socket.socket = self._handler.connection
        try:
            readable, _, _ = select.select([sock], [], [], 0)
            if not readable:
                return False
            return sock.recv(1, socket.MSG_PEEK) == b""
        except (OSError, ValueError):
            return True


Handler = Callable[[Request], None]


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request: Any, client_address: Any) -> None:
        # Workers drop connections on purpose (cancel, disconnect); that is not a stub fault.
        if isinstance(sys.exc_info()[1], ConnectionError):
            return
        super().handle_error(request, client_address)


def serve(handle: Handler, host: str, port: int) -> ThreadingHTTPServer:
    """Serve `handle` on host:port from a background thread; port 0 picks a free port."""

    class BoundHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _serve(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b""
            request = Request(self, body)
            try:
                handle(request)
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception as exc:  # a stub bug must be visible, not a silent hang
                if not request.responded:
                    request.respond_json(500, {"error": f"stub error: {exc!r}"})
                raise

        do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = do_OPTIONS = _serve  # noqa: N815

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return

    server = _Server((host, port), BoundHandler)
    threading.Thread(target=server.serve_forever, name=f"stub-{port}", daemon=True).start()
    return server


def stop(server: ThreadingHTTPServer) -> None:
    server.shutdown()
    server.server_close()
