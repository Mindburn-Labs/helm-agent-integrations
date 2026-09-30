"""The stubs speak the wire formats real SDKs expect, checked with raw HTTP."""

from __future__ import annotations

import http.client
import json
import socket
import struct
import threading
import time
import unittest
from typing import Any

from helm_worker_conformance import mcp_stub, model_stub
from helm_worker_conformance.a2a import Stream
from helm_worker_conformance.http_util import Request, serve, stop
from helm_worker_conformance.sinkhole import Sinkhole, http_host, tls_server_name
from helm_worker_conformance.world import World

from .support import free_port

TOKEN = "stub-token"


def post(
    port: int, path: str, body: Any, token: str | None = TOKEN
) -> tuple[int, dict[str, str], bytes]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    conn.request("POST", path, json.dumps(body), headers)
    response = conn.getresponse()
    data = response.read()
    status, got = response.status, {k.lower(): v for k, v in response.getheaders()}
    conn.close()
    return status, got, data


def sse_events(data: bytes) -> list[tuple[str | None, str]]:
    events = []
    for block in data.decode().split("\n\n"):
        name, payload = None, []
        for line in block.splitlines():
            if line.startswith("event:"):
                name = line[6:].strip()
            elif line.startswith("data:"):
                payload.append(line[5:].lstrip())
        if payload:
            events.append((name, "\n".join(payload)))
    return events


class McpStubTests(unittest.TestCase):
    def setUp(self) -> None:
        self.world = World(token=TOKEN)
        self.server = serve(mcp_stub.make_handler(self.world), "127.0.0.1", 0)
        self.port = self.server.server_address[1]
        self.addCleanup(stop, self.server)

    def rpc(
        self, method: str, params: dict[str, Any] | None = None, ident: int | None = 1
    ) -> dict[str, Any]:
        message: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if ident is not None:
            message["id"] = ident
        if params is not None:
            message["params"] = params
        status, _, data = post(self.port, "/mcp", message)
        self.assertEqual(status, 200, data)
        parsed: dict[str, Any] = json.loads(data)
        return parsed

    def test_bearer_is_required_and_recorded(self) -> None:
        status, headers, _ = post(
            self.port, "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "ping"}, token=None
        )
        self.assertEqual((status, headers["www-authenticate"]), (401, "Bearer"))
        status, _, _ = post(
            self.port, "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "ping"}, token="wrong"
        )
        self.assertEqual(status, 401)
        self.assertEqual(len(self.world.violations), 2)

    def test_initialize_negotiates_the_protocol_version(self) -> None:
        for asked, want in (
            ("2025-06-18", "2025-06-18"),
            ("2024-11-05", "2025-11-25"),
            (None, "2025-11-25"),
        ):
            params = {"protocolVersion": asked} if asked else {}
            reply = self.rpc("initialize", params)
            self.assertEqual(reply["result"]["protocolVersion"], want)
            self.assertEqual(reply["result"]["capabilities"], {"tools": {"listChanged": False}})

    def test_notifications_get_202_and_get_or_delete_get_405(self) -> None:
        status, _, data = post(
            self.port, "/mcp", {"jsonrpc": "2.0", "method": "notifications/initialized"}
        )
        self.assertEqual((status, data), (202, b""))
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        self.addCleanup(conn.close)
        for method in ("GET", "DELETE"):
            conn.request(method, "/mcp", headers={"Authorization": f"Bearer {TOKEN}"})
            response = conn.getresponse()
            response.read()
            self.assertEqual(response.status, 405, method)

    def test_tools_list_offers_more_than_any_episode_allows(self) -> None:
        tools = self.rpc("tools/list")["result"]["tools"]
        names = {t["name"] for t in tools}
        self.assertEqual(names, set(mcp_stub.TOOLS))
        self.assertGreater(len(names), 3)
        for tool in tools:
            self.assertEqual(tool["inputSchema"]["type"], "object")

    def test_escalated_result_is_a_non_error_with_both_encodings(self) -> None:
        result = self.rpc(
            "tools/call", {"name": "github_pull_request_create_draft", "arguments": {"title": "t"}}
        )["result"]
        self.assertIs(result["isError"], False)
        self.assertEqual(
            result["structuredContent"], {"status": "escalated", "attempt_id": "att-1"}
        )
        self.assertEqual(json.loads(result["content"][0]["text"]), result["structuredContent"])
        self.assertEqual(
            self.rpc("tools/call", {"name": "github_pull_request_create_draft", "arguments": {}})[
                "result"
            ]["structuredContent"]["attempt_id"],
            "att-2",
        )

    def test_text_only_mode_omits_structured_content(self) -> None:
        self.world.mcp_structured = False
        result = self.rpc(
            "tools/call", {"name": "github_pull_request_create_draft", "arguments": {}}
        )["result"]
        self.assertNotIn("structuredContent", result)
        self.assertEqual(json.loads(result["content"][0]["text"])["status"], "escalated")

    def test_delegate_names_children_and_calls_are_recorded(self) -> None:
        first = self.rpc(
            "tools/call",
            {"name": "helm_work_delegate", "arguments": {"target": "seat:x", "goal": "g"}},
        )["result"]
        second = self.rpc("tools/call", {"name": "helm_work_delegate", "arguments": {}})["result"]
        self.assertEqual(
            [first["structuredContent"]["work_id"], second["structuredContent"]["work_id"]],
            ["child-1", "child-2"],
        )
        self.assertEqual([c.tool for c in self.world.mcp_calls], ["helm_work_delegate"] * 2)

    def test_unknown_tool_and_method_are_protocol_errors_and_batches_work(self) -> None:
        self.assertEqual(self.rpc("tools/call", {"name": "nope"})["error"]["code"], -32602)
        self.assertEqual(self.rpc("resources/list")["error"]["code"], -32601)
        status, _, data = post(
            self.port,
            "/mcp",
            [
                {"jsonrpc": "2.0", "id": 1, "method": "ping"},
                {"jsonrpc": "2.0", "id": 2, "method": "ping"},
            ],
        )
        self.assertEqual((status, [r["id"] for r in json.loads(data)]), (200, [1, 2]))

    def test_a_slow_tool_notices_a_vanished_client(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        body = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "github_repository_get", "arguments": {"delay_seconds": 30}},
        }
        conn.request(
            "POST",
            "/mcp",
            json.dumps(body),
            {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        )
        deadline = time.monotonic() + 5
        while not self.world.mcp_calls and time.monotonic() < deadline:
            time.sleep(0.02)
        conn.close()
        deadline = time.monotonic() + 5
        while self.world.mcp_calls[0].t_end is None and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(self.world.mcp_calls[0].aborted)


class ModelStubTests(unittest.TestCase):
    def setUp(self) -> None:
        self.world = World(token=TOKEN)
        self.world.script = [
            {"tools": [{"name": "github_repository_get", "arguments": {"repo": "a/b"}}]},
            {"text": "All done."},
        ]
        self.server = serve(model_stub.make_handler(self.world), "127.0.0.1", 0)
        self.port = self.server.server_address[1]
        self.addCleanup(stop, self.server)

    def ask(self, path: str, body: dict[str, Any]) -> tuple[int, bytes]:
        status, _, data = post(self.port, path, body)
        return status, data

    # -- anthropic

    def anthropic(self, **extra: Any) -> dict[str, Any]:
        return {
            "model": "claude-sonnet-5-5",
            "max_tokens": 100,
            "messages": [{"role": "user", "content": "go"}],
            "tools": [
                {
                    "name": "mcp__helm__github_repository_get",
                    "description": "d",
                    "input_schema": {"type": "object"},
                }
            ],
            **extra,
        }

    def test_anthropic_json_tool_use_uses_the_offered_name(self) -> None:
        status, data = self.ask("/v1/messages?beta=true", self.anthropic())
        message = json.loads(data)
        self.assertEqual(
            (status, message["stop_reason"], message["role"]), (200, "tool_use", "assistant")
        )
        (block,) = message["content"]
        self.assertEqual(
            (block["type"], block["name"], block["input"]),
            ("tool_use", "mcp__helm__github_repository_get", {"repo": "a/b"}),
        )
        self.assertTrue(block["id"].startswith("toolu_"))

    def test_anthropic_stream_event_order_and_input_json(self) -> None:
        status, data = self.ask("/v1/messages", self.anthropic(stream=True))
        events = sse_events(data)
        self.assertEqual(status, 200)
        self.assertEqual(
            [n for n, _ in events],
            [
                "message_start",
                "ping",
                "content_block_start",
                "content_block_delta",
                "content_block_stop",
                "message_delta",
                "message_stop",
            ],
        )
        payloads = [json.loads(d) for _, d in events]
        self.assertEqual(json.loads(payloads[3]["delta"]["partial_json"]), {"repo": "a/b"})
        self.assertEqual(payloads[5]["delta"]["stop_reason"], "tool_use")
        self.assertTrue(all(p["type"] == n for (n, _), p in zip(events, payloads, strict=True)))

    def test_the_second_turn_answers_with_text(self) -> None:
        body = self.anthropic(
            messages=[
                {"role": "user", "content": "go"},
                {"role": "assistant", "content": []},
                {"role": "user", "content": []},
            ]
        )
        message = json.loads(self.ask("/v1/messages", body)[1])
        self.assertEqual(
            (message["stop_reason"], message["content"]),
            ("end_turn", [{"type": "text", "text": "All done."}]),
        )
        self.assertEqual(self.world.model_calls[-1].turn, 1)

    def test_records_what_the_worker_sent(self) -> None:
        self.ask(
            "/v1/messages",
            self.anthropic(
                tools=[{"name": "Bash"}, {"type": "web_search_20250305", "name": "web_search"}],
                mcp_servers=[{"name": "x"}],
            ),
        )
        call = self.world.model_calls[0]
        self.assertEqual(
            [(t["name"], t["type"]) for t in call.tools],
            [("Bash", "custom"), ("web_search", "web_search_20250305")],
        )
        self.assertTrue(call.has_mcp_servers)
        self.assertEqual(
            (call.model, call.max_tokens, call.dialect), ("claude-sonnet-5-5", 100, "anthropic")
        )
        self.assertIn('"go"', call.text)

    # -- chat completions

    def chat(self, **extra: Any) -> dict[str, Any]:
        return {
            "model": "gpt-6-sol",
            "max_completion_tokens": 50,
            "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "go"}],
            "tools": [
                {
                    "type": "function",
                    "function": {"name": "github_repository_get", "parameters": {"type": "object"}},
                }
            ],
            **extra,
        }

    def test_chat_json_and_stream(self) -> None:
        completion = json.loads(self.ask("/v1/chat/completions", self.chat())[1])
        choice = completion["choices"][0]
        self.assertEqual(
            (completion["object"], choice["finish_reason"]), ("chat.completion", "tool_calls")
        )
        call = choice["message"]["tool_calls"][0]
        self.assertEqual(
            (call["function"]["name"], json.loads(call["function"]["arguments"])),
            ("github_repository_get", {"repo": "a/b"}),
        )
        events = sse_events(self.ask("/v1/chat/completions", self.chat(stream=True))[1])
        self.assertEqual(events[-1], (None, "[DONE]"))
        chunks = [json.loads(d) for _, d in events[:-1]]
        self.assertEqual(
            [c["choices"][0]["finish_reason"] for c in chunks if c["choices"]][-1], "tool_calls"
        )
        arguments = "".join(
            tc["function"].get("arguments", "")
            for c in chunks
            if c["choices"]
            for tc in c["choices"][0]["delta"].get("tool_calls", [])
        )
        self.assertEqual(json.loads(arguments), {"repo": "a/b"})
        self.assertEqual(self.world.model_calls[0].max_tokens, 50)

    # -- responses

    def responses(self, **extra: Any) -> dict[str, Any]:
        return {
            "model": "gpt-6-sol",
            "max_output_tokens": 70,
            "instructions": "s",
            "input": [{"role": "user", "content": "go"}],
            "tools": [
                {
                    "type": "function",
                    "name": "github_repository_get",
                    "parameters": {"type": "object"},
                }
            ],
            **extra,
        }

    def test_responses_json_stream_and_turn_counting(self) -> None:
        response = json.loads(self.ask("/v1/responses", self.responses())[1])
        (item,) = response["output"]
        self.assertEqual(
            (response["object"], item["type"], item["name"]),
            ("response", "function_call", "github_repository_get"),
        )
        events = sse_events(self.ask("/v1/responses", self.responses(stream=True))[1])
        kinds = [n for n, _ in events]
        self.assertEqual(kinds[0], "response.created")
        self.assertEqual(kinds[-1], "response.completed")
        self.assertIn("response.function_call_arguments.done", kinds)
        sequence = [json.loads(d)["sequence_number"] for _, d in events]
        self.assertEqual(sequence, sorted(sequence))
        history = [
            {"role": "user", "content": "go"},
            item,
            {"type": "function_call_output", "call_id": item["call_id"], "output": "{}"},
        ]
        reply = json.loads(self.ask("/v1/responses", self.responses(input=history))[1])
        self.assertEqual(reply["output"][0]["content"][0]["text"], "All done.")
        self.assertEqual(self.world.model_calls[-1].turn, 1)

    def test_parallel_calls_in_one_turn_count_as_one_assistant_turn(self) -> None:
        items = [
            {"role": "user", "content": "go"},
            {"type": "function_call", "call_id": "1", "name": "a", "arguments": "{}"},
            {"type": "function_call", "call_id": "2", "name": "b", "arguments": "{}"},
            {"type": "function_call_output", "call_id": "1", "output": ""},
            {"type": "function_call_output", "call_id": "2", "output": ""},
        ]
        self.assertEqual(model_stub.assistant_turns("responses", {"input": items}), 1)
        self.assertEqual(model_stub.assistant_turns("responses", {"input": "text"}), 0)

    # -- shared

    def test_errors_use_each_dialects_shape(self) -> None:
        self.world.script = [{"http_error": 400, "message": "boom"}]
        status, data = self.ask("/v1/messages", self.anthropic())
        self.assertEqual(
            (status, json.loads(data)),
            (400, {"type": "error", "error": {"type": "invalid_request_error", "message": "boom"}}),
        )
        status, data = self.ask("/v1/chat/completions", self.chat())
        self.assertEqual((status, json.loads(data)["error"]["message"]), (400, "boom"))

    def test_wrong_token_is_refused_and_recorded(self) -> None:
        status, _, _ = post(self.port, "/v1/messages", self.anthropic(), token="nope")
        self.assertEqual(status, 401)
        self.assertEqual(
            self.world.violations, ["model /v1/messages: missing or wrong bearer token"]
        )

    def test_optional_endpoints_are_404_and_noted(self) -> None:
        self.assertEqual(self.ask("/v1/messages/count_tokens", self.anthropic())[0], 404)
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        self.addCleanup(conn.close)
        conn.request("HEAD", "/api/hello")
        self.assertEqual(conn.getresponse().status, 404)
        self.assertEqual([c.dialect for c in self.world.model_calls], ["other", "other"])

    def test_a_held_call_notices_a_vanished_client(self) -> None:
        self.world.script = [{"sleep": 30, "then": {"text": "late"}}]
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request(
            "POST",
            "/v1/messages",
            json.dumps(self.anthropic()),
            {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        )
        deadline = time.monotonic() + 5
        while not self.world.model_calls and time.monotonic() < deadline:
            time.sleep(0.02)
        conn.close()
        deadline = time.monotonic() + 5
        while self.world.model_calls[0].t_end is None and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(self.world.model_calls[0].aborted)


class SinkholeTests(unittest.TestCase):
    def test_dns_and_tcp_traps_leave_evidence(self) -> None:
        dns_port, tcp_port = free_port(socket.SOCK_DGRAM), free_port()
        sink = Sinkhole("10.9.8.7", bind="127.0.0.1", dns_port=dns_port, tcp_ports=(tcp_port,))
        sink.start()
        self.addCleanup(sink.stop)

        def query(name: str, qtype: int) -> bytes:
            packet = b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00"
            packet += (
                b"".join(bytes([len(p)]) + p.encode() for p in name.split("."))
                + b"\x00"
                + struct.pack(">HH", qtype, 1)
            )
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.settimeout(3)
                sock.sendto(packet, ("127.0.0.1", dns_port))
                return sock.recvfrom(512)[0]

        answer = query("exfil.example.test", 1)
        self.assertEqual(answer[-4:], socket.inet_aton("10.9.8.7"))
        self.assertEqual(struct.unpack(">H", answer[6:8])[0], 1)  # one answer
        self.assertEqual(
            struct.unpack(">H", query("exfil.example.test", 28)[6:8])[0], 0
        )  # AAAA: none
        query("7.8.9.10.in-addr.arpa", 12)
        with socket.create_connection(("127.0.0.1", tcp_port)) as conn:
            conn.sendall(b"GET / HTTP/1.1\r\nHost: api.example.test\r\n\r\n")
        deadline = time.monotonic() + 3
        while len(sink.events) < 4 and time.monotonic() < deadline:
            time.sleep(0.02)
        offending = [str(e) for e in sink.offending()]
        self.assertEqual(len(sink.events), 4)
        self.assertEqual(len(offending), 3)  # the reverse lookup is not an attempt
        self.assertTrue(any("exfil.example.test type=1" in e for e in offending))
        self.assertTrue(any("api.example.test" in e for e in offending))

    def test_parsers(self) -> None:
        self.assertEqual(
            http_host(b"GET / HTTP/1.1\r\nhost: h.example:8443\r\n\r\n"), "h.example:8443"
        )
        self.assertIsNone(http_host(b"\x16\x03\x01"))
        self.assertIsNone(tls_server_name(b"GET / HTTP/1.1\r\n\r\n"))
        hello = _client_hello("sni.example.test")
        self.assertEqual(tls_server_name(hello), "sni.example.test")


def _client_hello(name: str) -> bytes:
    host = name.encode()
    sni = struct.pack(">HBH", len(host) + 3, 0, len(host)) + host
    extensions = struct.pack(">HH", 0, len(sni)) + sni
    body = (
        b"\x03\x03"
        + bytes(32)
        + b"\x00"
        + struct.pack(">H", 2)
        + b"\x13\x01"
        + b"\x01\x00"
        + struct.pack(">H", len(extensions))
        + extensions
    )
    handshake = b"\x01" + struct.pack(">I", len(body))[1:] + body
    return b"\x16\x03\x01" + struct.pack(">H", len(handshake)) + handshake


class StreamParserTests(unittest.TestCase):
    def serve(self, handler: Any) -> str:
        server = serve(handler, "127.0.0.1", 0)
        self.addCleanup(stop, server)
        return f"http://127.0.0.1:{server.server_address[1]}/"

    def test_sse_events_and_the_stream_close(self) -> None:
        def handle(req: Request) -> None:
            req.start_sse()
            req.sse(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {
                        "task": {
                            "id": "t1",
                            "contextId": "c1",
                            "status": {"state": "TASK_STATE_SUBMITTED"},
                        }
                    },
                }
            )
            req.sse(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {
                        "statusUpdate": {
                            "taskId": "t1",
                            "contextId": "c1",
                            "status": {"state": "TASK_STATE_COMPLETED"},
                        }
                    },
                },
                event="message",
            )

        stream = Stream(self.serve(handle), {}, {"jsonrpc": "2.0", "id": 1, "method": "x"}, 10)
        self.assertTrue(stream.wait_closed(5))
        self.assertEqual([e.kind for e in stream.snapshot()], ["task", "statusUpdate"])
        self.assertEqual(
            (stream.states(), stream.final_state(), stream.task_id()),
            (["TASK_STATE_SUBMITTED", "TASK_STATE_COMPLETED"], "TASK_STATE_COMPLETED", "t1"),
        )

    def test_a_json_rpc_error_body_is_not_a_stream(self) -> None:
        def handle(req: Request) -> None:
            req.respond_json(
                200,
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "error": {"code": -32008, "message": "Extension support required"},
                },
            )

        stream = Stream(self.serve(handle), {}, {"jsonrpc": "2.0", "id": 1, "method": "x"}, 10)
        self.assertTrue(stream.wait(lambda s: s.rpc_error is not None, 5))
        self.assertEqual((stream.rpc_error or {})["code"], -32008)
        self.assertEqual(stream.events, [])

    def test_an_event_with_two_members_is_unknown(self) -> None:
        def handle(req: Request) -> None:
            req.start_sse()
            req.sse({"jsonrpc": "2.0", "id": 1, "result": {"task": {}, "message": {}}})

        stream = Stream(self.serve(handle), {}, {"jsonrpc": "2.0", "id": 1, "method": "x"}, 10)
        stream.wait_closed(5)
        self.assertEqual([e.kind for e in stream.snapshot()], ["unknown"])

    def test_close_drops_the_connection(self) -> None:
        gone = threading.Event()

        def handle(req: Request) -> None:
            req.start_sse()
            while not req.client_gone():
                time.sleep(0.02)
            gone.set()

        stream = Stream(self.serve(handle), {}, {"jsonrpc": "2.0", "id": 1, "method": "x"}, 10)
        time.sleep(0.3)
        stream.close()
        self.assertTrue(gone.wait(5))


if __name__ == "__main__":
    unittest.main()
