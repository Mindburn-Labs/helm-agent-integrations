"""Transport faults and refusal of partial replay proof; native ledger proof is external."""

from __future__ import annotations

import dataclasses
import http.client
import json
import ssl
import unittest
import uuid
from typing import Any

from helm_worker_conformance.checks import FAIL, PASS
from helm_worker_conformance.governed_replay import (
    MAX_MCP_BYTES,
    AcceptedCall,
    LedgerReadback,
    ResponseLossRelay,
    WorkerProbe,
    replay_checks,
    run_lost_tool_response,
)
from helm_worker_conformance.http_util import Request, serve, stop
from helm_worker_conformance.world import World


def tool_reply(ident: Any, attempt: str, *, mirror_attempt: str | None = None) -> dict[str, Any]:
    native = {
        "attempt_id": attempt,
        "effect_type": "github.repository.get.v1",
        "target": "https://api.github.com/repos/conformance/sandbox",
        "state": "UNKNOWN",
        "status": "reconciling",
    }
    mirror = {**native, "attempt_id": mirror_attempt or attempt}
    return {
        "jsonrpc": "2.0",
        "id": ident,
        "result": {
            "isError": False,
            "structuredContent": native,
            "content": [{"type": "text", "text": json.dumps(mirror)}],
        },
    }


class RelayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.token = str(uuid.uuid4())
        self.attempt = str(uuid.uuid4())
        self.received: list[tuple[dict[str, Any], str]] = []
        self.received_bytes: list[bytes] = []
        self.mode = "normal"

        def native(req: Request) -> None:
            message = req.json()
            self.received_bytes.append(req.body)
            self.received.append((message, req.header("Authorization")))
            if message.get("method") == "initialize":
                req.respond_json(
                    200,
                    {
                        "jsonrpc": "2.0",
                        "id": message["id"],
                        "result": {
                            "protocolVersion": "2025-11-25",
                            "capabilities": {"tools": {}},
                            "serverInfo": {"name": "transport-test", "version": "1"},
                        },
                    },
                )
            elif self.mode == "redirect":
                req.respond(302, Location="https://forbidden.invalid/mcp")
            elif self.mode == "oversized":
                req.respond(200, b"x" * (MAX_MCP_BYTES + 1), "application/json")
            elif self.mode == "malformed_content":
                reply = tool_reply(message["id"], self.attempt)
                reply["result"]["content"] = None
                req.respond_json(200, reply)
            else:
                req.respond_json(
                    200,
                    tool_reply(
                        message["id"],
                        self.attempt,
                        mirror_attempt=str(uuid.uuid4()) if self.mode == "mismatch" else None,
                    ),
                )

        self.native = serve(native, "127.0.0.1", 0)
        self.addCleanup(stop, self.native)
        self.world = World(token=self.token)
        self.relay = ResponseLossRelay(
            f"http://127.0.0.1:{self.native.server_address[1]}/mcp",
            framework="transport-test",
            episode_id=str(uuid.uuid4()),
            tool="github_repository_get",
            drop_first=True,
            world=self.world,
            allow_loopback_http=True,
        )
        self.server = serve(self.relay.handle, "127.0.0.1", 0)
        self.addCleanup(stop, self.server)

    def rpc(self, message: dict[str, Any]) -> tuple[int, bytes]:
        return self.raw_rpc(json.dumps(message).encode())

    def raw_rpc(
        self, body: bytes, *, authenticated: bool = True, path: str = "/mcp"
    ) -> tuple[int, bytes]:
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=5)
        try:
            headers = {"Content-Type": "application/json"}
            if authenticated:
                headers["Authorization"] = f"Bearer {self.token}"
            conn.request("POST", path, body, headers)
            response = conn.getresponse()
            return response.status, response.read()
        finally:
            conn.close()

    def initialize(self) -> None:
        status, _ = self.rpc({"jsonrpc": "2.0", "id": 0, "method": "initialize"})
        self.assertEqual(status, 200)

    def call(self) -> tuple[int, bytes]:
        return self.rpc(
            {
                "jsonrpc": "2.0",
                "id": 7,
                "method": "tools/call",
                "params": {
                    "name": "github_repository_get",
                    "arguments": {"target": "repo-fixture", "arguments": {"schema": "fixture"}},
                },
            }
        )

    def test_accepted_response_is_lost_then_fresh_wire_id_recovers_the_reply(self) -> None:
        self.initialize()
        with self.assertRaises(http.client.RemoteDisconnected):
            self.call()
        self.assertEqual(len(self.received), 2)
        self.assertEqual(len(self.relay.calls), 1)
        self.assertTrue(self.relay.calls[0].dropped)
        self.assertEqual(self.relay.calls[0].attempt_id, self.attempt)
        status, data = self.call()
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["id"], 7)
        self.assertEqual(self.relay.calls[1].attempt_id, self.attempt)
        self.assertFalse(self.relay.calls[1].dropped)
        first, second = self.received[1:]
        self.assertNotEqual(first[0]["id"], second[0]["id"])
        self.assertEqual(first[0]["params"], second[0]["params"])
        self.assertEqual(first[1], f"Bearer {self.token}")
        self.assertEqual(second[1], first[1])
        self.assertEqual(len(self.world.mcp_methods), 3)
        self.assertFalse(self.world.violations)

    def test_rewriting_only_the_wire_id_preserves_exact_native_argument_bytes(self) -> None:
        self.initialize()
        body = (
            '  { "jsonrpc": "2.0", "params": {"name":"github_repository_get", '
            '"arguments":{"id":"nested", "ratio":1.234567890123456789, "note":"é🧭"}}, '
            '"id" : 7, "method" : "tools/call" }\n'
        ).encode()
        with self.assertRaises(http.client.RemoteDisconnected):
            self.raw_rpc(body)
        expected = body.replace(
            b'"id" : 7', b'"id" : ' + json.dumps(self.relay.calls[0].request_ref).encode()
        )
        self.assertEqual(self.received_bytes[-1], expected)

    def test_bad_bearer_route_or_ambiguous_rpc_cannot_reach_the_native_gateway(self) -> None:
        body = b'{"jsonrpc":"2.0","id":7,"method":"tools/list"}'
        self.assertEqual(self.raw_rpc(body, authenticated=False)[0], 401)
        self.assertEqual(self.raw_rpc(body, path="/mcp?target=other")[0], 404)
        duplicate = b'{"jsonrpc":"2.0","id":7,"id":8,"method":"tools/list"}'
        self.assertEqual(self.raw_rpc(duplicate)[0], 400)
        self.assertEqual(self.raw_rpc(b'[{"jsonrpc":"2.0","id":7}]')[0], 400)
        self.assertEqual(self.received, [])
        self.assertEqual(self.relay.calls, [])

    def test_redirect_is_not_followed_or_counted_as_an_accepted_tool(self) -> None:
        self.mode = "redirect"
        status, _ = self.call()
        self.assertEqual(status, 302)
        self.assertEqual(len(self.received), 1)
        self.assertEqual(self.relay.calls, [])

    def test_oversize_and_mirror_mismatch_fail_without_claiming_response_loss(self) -> None:
        for mode in ["oversized", "mismatch", "malformed_content"]:
            self.mode = mode
            with self.subTest(mode=mode):
                status, _ = self.call()
                self.assertEqual(status, 502)
                self.assertEqual(self.relay.calls, [])
                self.assertTrue(self.world.violations)

    def test_endpoint_and_tls_verification_cannot_be_relaxed(self) -> None:
        kwargs: dict[str, Any] = {
            "framework": "transport-test",
            "episode_id": str(uuid.uuid4()),
            "tool": "github_repository_get",
            "drop_first": True,
            "world": self.world,
        }
        for endpoint in [
            "http://127.0.0.1/mcp",
            "http://192.0.2.1/mcp",
            f"https://{uuid.uuid4()}:{uuid.uuid4()}@gateway.invalid/mcp",
            "https://gateway.invalid/mcp?target=other",
        ]:
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                ResponseLossRelay(endpoint, **kwargs)
        unverified = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        unverified.check_hostname = False
        unverified.verify_mode = ssl.CERT_NONE
        with self.assertRaises(ValueError):
            ResponseLossRelay("https://gateway.invalid/mcp", tls=unverified, **kwargs)


class ReplayProofTests(unittest.TestCase):
    def setUp(self) -> None:
        self.attempt = str(uuid.uuid4())
        self.before = LedgerReadback(
            (self.attempt,),
            1,
            1,
            str(uuid.uuid4()),
            {
                "tenant_id": str(uuid.uuid4()),
                "workspace_id": str(uuid.uuid4()),
                "work_item_id": str(uuid.uuid4()),
                "episode_id": str(uuid.uuid4()),
                "organization_version_id": str(uuid.uuid4()),
                "requester_principal_id": "agt:fixture",
            },
        )
        self.calls = [
            AcceptedCall(
                framework,
                str(uuid.uuid4()),
                str(uuid.uuid4()),
                str(uuid.uuid4()),
                self.attempt,
                "github.repository.get.v1",
                "canonical-fixture-target",
                "UNKNOWN",
                index == 0,
            )
            for index, framework in enumerate(["openclaw", "langgraph"])
        ]

    def failed(self, calls: list[AcceptedCall], after: LedgerReadback) -> set[str]:
        return {c.name for c in replay_checks(calls, self.before, after) if c.status == FAIL}

    def test_complete_evidence_and_a_retained_escalation_have_distinct_dispatch_counts(
        self,
    ) -> None:
        self.assertEqual(self.failed(self.calls, self.before), set())
        zero = dataclasses.replace(self.before, dispatch_count=0, observe_count=0)
        escalated = [dataclasses.replace(c, state="ESCALATED") for c in self.calls]
        self.assertTrue(all(c.status == PASS for c in replay_checks(escalated, zero, zero)))
        self.assertIn("lost_tool_response.one_admission_dispatch", self.failed(self.calls, zero))

    def test_duplicate_admission_dispatch_observe_or_original_binding_is_rejected(self) -> None:
        cases = [
            (
                dataclasses.replace(self.before, attempt_ids=(self.attempt, str(uuid.uuid4()))),
                "one_admission_dispatch",
            ),
            (dataclasses.replace(self.before, dispatch_count=2), "one_admission_dispatch"),
            (dataclasses.replace(self.before, observe_count=2), "no_worker_reobservation"),
            (
                dataclasses.replace(
                    self.before, binding={**self.before.binding, "episode_id": str(uuid.uuid4())}
                ),
                "original_binding_immutable",
            ),
            (dataclasses.replace(self.before, intent_digest=""), "kernel_intent_digest"),
        ]
        for after, expected in cases:
            with self.subTest(expected=expected):
                self.assertIn(f"lost_tool_response.{expected}", self.failed(self.calls, after))

    def test_same_episode_transport_retry_is_not_a_new_admission_or_cross_episode_observe(
        self,
    ) -> None:
        retry = dataclasses.replace(self.calls[0], request_ref=str(uuid.uuid4()), dropped=False)
        calls = [self.calls[0], retry, self.calls[1]]
        original = dataclasses.replace(self.before, observe_count=2)
        self.assertTrue(all(c.status == PASS for c in replay_checks(calls, original, original)))
        changed = dataclasses.replace(original, observe_count=3)
        failed = {c.name for c in replay_checks(calls, original, changed) if c.status == FAIL}
        self.assertIn("lost_tool_response.no_worker_reobservation", failed)

    def test_no_native_fixture_or_only_one_framework_never_claims_replay_pass(self) -> None:
        incomplete = [
            dataclasses.replace(c, framework="openclaw", session_ref="") for c in self.calls
        ]
        failed = self.failed(incomplete, self.before)
        self.assertIn("lost_tool_response.fresh_framework_episode", failed)
        self.assertIn("lost_tool_response.fresh_request_session", failed)
        result = run_lost_tool_response(
            [],
            gateway_url="https://gateway.invalid/mcp",
            tool="github_repository_get",
            arguments={},
            readback=lambda _: self.before,
        )
        self.assertTrue(all(c["status"] == FAIL for c in result["checks"]))

    def test_invalid_private_probes_fail_before_starting_any_transport(self) -> None:
        probes = [
            WorkerProbe(
                framework, "http://worker.invalid", {}, str(uuid.uuid4()), str(uuid.uuid4())
            )
            for framework in ["openclaw", "langgraph"]
        ]
        result = run_lost_tool_response(
            probes,
            gateway_url="https://gateway.invalid/mcp",
            tool="github_repository_get",
            arguments={},
            readback=lambda _: self.before,
        )
        self.assertEqual(len(result["checks"]), 1)
        self.assertEqual(result["checks"][0]["status"], FAIL)

    def test_private_probe_credentials_are_not_in_diagnostic_repr(self) -> None:
        token, ingress = str(uuid.uuid4()), str(uuid.uuid4())
        probe = WorkerProbe("openclaw", "http://worker.invalid", {}, token, ingress)
        self.assertNotIn(token, repr(probe))
        self.assertNotIn(ingress, repr(probe))
