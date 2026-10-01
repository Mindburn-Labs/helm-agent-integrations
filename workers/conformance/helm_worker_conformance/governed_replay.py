"""Lost-response conformance against an actual Kernel MCP gateway.

The relay forwards each incoming tool call once, consumes one accepted native reply, and
drops it before the worker receives it. Fresh probes use fresh JSON-RPC ids and initialized MCP
clients. Only the Kernel derives effect identity and owns admission/dispatch/observation.
The operator's readback port supplies actual scoped ledger and adapter facts. Without
that producer, this module cannot claim governed replay conformance.
"""

from __future__ import annotations

import copy
import http.client
import ipaddress
import json
import ssl
import threading
import time
import uuid
from collections.abc import Mapping, Sequence
from contextlib import ExitStack
from dataclasses import asdict, dataclass, field
from typing import Any, Protocol
from urllib.parse import urlsplit

from helm_worker_contract import EpisodeError, parse_episode

from . import model_stub
from .a2a import A2AClient
from .checks import FAIL, PASS, CheckResult, Run, artifact_events, check_extension_declared
from .http_util import Request, serve, stop
from .runner import card_model_apis
from .scenarios import SCENARIO_TIMEOUT, Scenario, _finish, _open, _standard
from .sinkhole import Sinkhole
from .world import McpCall, World

MAX_MCP_BYTES = 4 * 1024 * 1024
FORWARD_TIMEOUT = 30.0
_REQUEST_HEADERS = (
    "Authorization",
    "Content-Type",
    "Accept",
    "MCP-Protocol-Version",
    "MCP-Session-Id",
    "Last-Event-ID",
)
_REPLY_HEADERS = {"mcp-session-id", "mcp-protocol-version", "www-authenticate", "location"}
_BINDING_FIELDS = {
    "tenant_id",
    "workspace_id",
    "work_item_id",
    "episode_id",
    "organization_version_id",
    "requester_principal_id",
}


@dataclass(frozen=True)
class AcceptedCall:
    framework: str
    episode_id: str
    session_ref: str
    request_ref: str
    attempt_id: str
    effect_type: str
    target: str = field(repr=False)
    state: str
    dropped: bool


@dataclass(frozen=True)
class LedgerReadback:
    """Test evidence supplied by the native fixture, never a worker authority DTO.

    All counters are scoped to the actual work/effect/target/intent, not the whole tenant.
    Binding comes from the retained original attempt. The intent digest is produced by
    the Kernel. No key, decision, credential or permit is generated here.
    """

    attempt_ids: tuple[str, ...]
    dispatch_count: int
    observe_count: int
    intent_digest: str
    binding: Mapping[str, str]


class Readback(Protocol):
    def __call__(self, attempt_id: str) -> LedgerReadback:
        """Read actual operator-authorized ledger and adapter facts."""
        ...


def _tool_result(reply: Mapping[str, Any]) -> Mapping[str, Any] | None:
    result = reply.get("result")
    if not isinstance(result, dict):
        return None
    structured = result.get("structuredContent")
    if structured is not None and not isinstance(structured, dict):
        raise ValueError("native structured tool result is not an object")
    candidates = [structured] if isinstance(structured, dict) else []
    content = result.get("content", [])
    if not isinstance(content, list):
        raise ValueError("native tool content is not an array")
    for part in content:
        if not isinstance(part, dict) or part.get("type") != "text":
            continue
        try:
            mirror = json.loads(part.get("text", ""))
        except (TypeError, ValueError):
            continue
        if isinstance(mirror, dict):
            candidates.append(mirror)
    if not candidates or not any(c.get("attempt_id") for c in candidates):
        return None
    if any(c != candidates[0] for c in candidates[1:]):
        raise ValueError("native tool result and text mirror disagree")
    if not all(
        isinstance(candidates[0].get(k), str) and candidates[0][k]
        for k in ("attempt_id", "effect_type", "target", "state")
    ):
        raise ValueError("native tool result has no complete attempt reference")
    return candidates[0]


def _replace_rpc_id(data: bytes, ident: Any) -> bytes:
    """Replace only the top-level wire id, preserving every argument/result byte.

    Parsing and re-encoding the whole envelope could round a JSON number or change a
    retained payload. The native Kernel is the sole canonicalizer of effect intent.
    """
    text = data.decode("utf-8")
    decoder = json.JSONDecoder()
    index = 0
    while text[index].isspace():
        index += 1
    if text[index] != "{":
        raise ValueError("invalid JSON-RPC object")
    index += 1
    while index < len(text):
        while text[index].isspace():
            index += 1
        key, index = decoder.raw_decode(text, index)
        while text[index].isspace():
            index += 1
        if text[index] != ":":
            raise ValueError("invalid JSON-RPC object")
        index += 1
        while text[index].isspace():
            index += 1
        start = index
        _, index = decoder.raw_decode(text, index)
        if key == "id":
            return (text[:start] + json.dumps(ident) + text[index:]).encode("utf-8")
        while text[index].isspace():
            index += 1
        if text[index] == "}":
            break
        if text[index] != ",":
            raise ValueError("invalid JSON-RPC object")
        index += 1
    raise ValueError("JSON-RPC request id is missing")


def _rpc_object(data: bytes) -> dict[str, Any]:
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON member")
            result[key] = value
        return result

    def reject_constant(_: str) -> None:
        raise ValueError("non-finite JSON number")

    message = json.loads(
        data.decode("utf-8"), object_pairs_hook=unique, parse_constant=reject_constant
    )
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        raise ValueError("fixture requires one JSON-RPC 2.0 object")
    return message


class ResponseLossRelay:
    """A bounded transport fault; no admission cache, key derivation or retries."""

    def __init__(
        self,
        gateway_url: str,
        *,
        framework: str,
        episode_id: str,
        tool: str,
        drop_first: bool,
        world: World,
        tls: ssl.SSLContext | None = None,
        allow_loopback_http: bool = False,
    ) -> None:
        url = urlsplit(gateway_url)
        if (
            not url.hostname
            or url.username is not None
            or url.password is not None
            or url.path != "/mcp"
            or url.query
            or url.fragment
            or any(ord(c) < 33 for c in gateway_url)
        ):
            raise ValueError("fixture requires one exact gateway MCP endpoint")
        # Validate a malformed/zero port before any test server or request is started.
        if url.port == 0:
            raise ValueError("fixture gateway port is invalid")
        if url.scheme == "http":
            try:
                loopback = ipaddress.ip_address(url.hostname).is_loopback
            except ValueError:
                loopback = False
            if not allow_loopback_http or not loopback:
                raise ValueError("plaintext fixture transport requires explicit loopback")
        elif url.scheme != "https":
            raise ValueError("fixture gateway requires HTTPS")
        self.tls = tls or ssl.create_default_context()
        if url.scheme == "https" and (
            self.tls.verify_mode != ssl.CERT_REQUIRED or not self.tls.check_hostname
        ):
            raise ValueError("fixture TLS must verify the actual gateway certificate and hostname")
        self.url = url
        self.framework, self.episode_id, self.tool = framework, episode_id, tool
        self.world = world
        self.calls: list[AcceptedCall] = []
        self._lock = threading.Lock()
        self._drop_unused = drop_first
        self._session = str(uuid.uuid4())
        self._initialized = False

    def _forward(
        self, method: str, body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        host = self.url.hostname
        assert host is not None
        conn: http.client.HTTPConnection
        if self.url.scheme == "https":
            conn = http.client.HTTPSConnection(
                host, self.url.port, timeout=FORWARD_TIMEOUT, context=self.tls
            )
        else:
            conn = http.client.HTTPConnection(host, self.url.port, timeout=FORWARD_TIMEOUT)
        try:
            # http.client does not follow a redirect or retry a failed request.
            conn.request(method, "/mcp", body=body, headers=headers)
            response = conn.getresponse()
            data = response.read(MAX_MCP_BYTES + 1)
            if len(data) > MAX_MCP_BYTES:
                raise ValueError("native MCP response exceeds transport bound")
            return response.status, {k.lower(): v for k, v in response.getheaders()}, data
        finally:
            conn.close()

    def handle(self, req: Request) -> None:
        if req._handler.path != "/mcp":
            req.respond_json(404, {"error": "fixture route not found"})
            return
        if req.method not in {"POST", "GET", "DELETE"}:
            req.respond(405, Allow="POST, GET, DELETE")
            return
        if len(req.body) > MAX_MCP_BYTES:
            req.respond_json(413, {"error": "fixture request exceeds transport bound"})
            return
        if req.bearer() != self.world.token:
            self.world.violation("lost-response fixture received a wrong episode bearer")
            req.respond_json(401, {"error": "unauthorized"}, WWW_Authenticate="Bearer")
            return
        message: dict[str, Any] | None = None
        if req.method == "POST":
            try:
                parsed = _rpc_object(req.body)
            except (ValueError, UnicodeError):
                req.respond_json(400, {"error": "fixture requires UTF-8 JSON-RPC"})
                return
            if not isinstance(parsed.get("method"), str) or not parsed["method"]:
                req.respond_json(400, {"error": "fixture requires a JSON-RPC method"})
                return
            message = parsed
            with self.world.lock:
                self.world.mcp_methods.append((time.monotonic(), parsed["method"]))
        is_tool = message is not None and message.get("method") == "tools/call"
        original_id = message.get("id") if message is not None else None
        request_ref = str(uuid.uuid4())
        call: McpCall | None = None
        if is_tool:
            assert message is not None
            params = message.get("params")
            if not isinstance(params, dict) or params.get("name") != self.tool:
                self.world.violation("lost-response fixture received an unscripted tool")
                req.respond_json(400, {"error": "unscripted fixture tool"})
                return
            if not isinstance(original_id, (str, int, float)) or isinstance(original_id, bool):
                req.respond_json(400, {"error": "fixture tool requires a request id"})
                return
            # A new wire id makes the old per-request identity bug observable. Tool
            # name, arguments, authorization and native session headers are untouched.
            args = params.get("arguments")
            if not isinstance(args, dict):
                req.respond_json(400, {"error": "fixture tool arguments must be an object"})
                return
            call = McpCall(time.monotonic(), self.tool, args)
            self.world.record_mcp(call)
        body = _replace_rpc_id(req.body, request_ref) if is_tool else req.body
        headers = {k: req.header(k) for k in _REQUEST_HEADERS if req.header(k)}
        try:
            status, response_headers, data = self._forward(req.method, body, headers)
            if message is not None and message.get("method") == "initialize" and status == 200:
                initialized = _rpc_object(data)
                negotiated = initialized.get("result")
                self._initialized = (
                    isinstance(negotiated, dict)
                    and bool(negotiated.get("protocolVersion"))
                    and isinstance(negotiated.get("capabilities"), dict)
                    and isinstance(negotiated.get("serverInfo"), dict)
                    and initialized.get("id") == original_id
                )
            if call is not None and status == 200:
                reply = _rpc_object(data)
                if reply.get("id") != request_ref:
                    raise ValueError("native fixture reply does not match the request")
                result = _tool_result(reply)
                call.result = reply.get("result")
                call.t_end = time.monotonic()
                if result is not None:
                    with self._lock:
                        dropped = self._drop_unused
                        self._drop_unused = False
                        session = self._session if self._initialized else ""
                        self.calls.append(
                            AcceptedCall(
                                self.framework,
                                self.episode_id,
                                session,
                                request_ref,
                                result["attempt_id"],
                                result["effect_type"],
                                result["target"],
                                result["state"],
                                dropped,
                            )
                        )
                    if dropped:
                        req.drop_response()
                        return
                data = _replace_rpc_id(data, original_id)
                if len(data) > MAX_MCP_BYTES:
                    raise ValueError("rewritten fixture reply exceeds transport bound")
        except (OSError, ValueError, http.client.HTTPException):
            self.world.violation("native fixture response unavailable or invalid")
            req.respond_json(502, {"error": "native fixture response unavailable or invalid"})
            return
        reply_headers = {k: v for k, v in response_headers.items() if k in _REPLY_HEADERS}
        req.respond(status, data, response_headers.get("content-type"), **reply_headers)


def replay_checks(
    calls: Sequence[AcceptedCall], before: LedgerReadback, after: LedgerReadback
) -> list[CheckResult]:
    """Compare native evidence. Missing producer data and partial proofs fail closed."""
    checks: list[CheckResult] = []

    def check(name: str, ok: bool, detail: str) -> None:
        checks.append(
            CheckResult(f"lost_tool_response.{name}", PASS if ok else FAIL, "" if ok else detail)
        )

    first = calls[0] if calls else None
    check(
        "accepted_response_dropped",
        first is not None and first.dropped and sum(c.dropped for c in calls) == 1,
        "one accepted native response must be lost",
    )
    check(
        "fresh_framework_episode",
        len({c.framework for c in calls}) >= 2 and len({c.episode_id for c in calls}) >= 2,
        "need distinct actual framework and episode probes",
    )
    check(
        "fresh_request_session",
        len({c.request_ref for c in calls}) == len(calls)
        and len({c.session_ref for c in calls if c.session_ref}) >= 2,
        "need fresh wire ids and initialized MCP clients",
    )
    check(
        "same_attempt",
        first is not None
        and len(calls) >= 2
        and all(c.attempt_id == first.attempt_id for c in calls),
        "replay must return the retained attempt",
    )
    check(
        "same_canonical_effect",
        first is not None
        and all((c.effect_type, c.target) == (first.effect_type, first.target) for c in calls),
        "native canonical effect/target changed",
    )
    expected_dispatch = 0 if first is not None and first.state in {"ESCALATED", "ADMITTED"} else 1
    check(
        "one_admission_dispatch",
        first is not None
        and before.attempt_ids == after.attempt_ids == (first.attempt_id,)
        and before.dispatch_count == after.dispatch_count == expected_dispatch,
        "native ledger or adapter shows a duplicate admission/dispatch",
    )
    check(
        "no_worker_reobservation",
        before.observe_count >= 0 and before.observe_count == after.observe_count,
        "cross-episode continuation reconciled outside the CP owner",
    )
    check(
        "original_binding_immutable",
        _BINDING_FIELDS <= set(before.binding)
        and all(before.binding[k] for k in _BINDING_FIELDS)
        and dict(before.binding) == dict(after.binding),
        "retained native episode/actor binding changed or is missing",
    )
    check(
        "kernel_intent_digest",
        bool(before.intent_digest) and before.intent_digest == after.intent_digest,
        "native intent digest is missing or changed",
    )
    return checks


@dataclass(frozen=True)
class WorkerProbe:
    """One fresh real worker/episode provisioned by the outer fixture owner."""

    framework: str
    worker_url: str
    episode: dict[str, Any] = field(repr=False)
    episode_token: str = field(repr=False)
    ingress_token: str = field(repr=False)
    api: str = "openai-responses"


def run_lost_tool_response(
    probes: Sequence[WorkerProbe],
    *,
    gateway_url: str,
    tool: str,
    arguments: Mapping[str, Any],
    readback: Readback,
    tls: ssl.SSLContext | None = None,
    mcp_host: str = "127.0.0.1",
    model_host: str = "127.0.0.1",
    bind: str = "127.0.0.1",
    allow_loopback_http: bool = False,
    sinkhole: Sinkhole | None = None,
) -> dict[str, Any]:
    """Drive native SDK workers with a real gateway and private caller-owned probes.

    This owns only model/relay test servers. The outer existing Docker fixture owns all
    worker/Kernel lifecycles, optional running sinkhole and private credentials. Readback
    is required; a stub with a fixed attempt id is not governed replay qualification.
    """
    calls: list[AcceptedCall] = []
    results: list[CheckResult] = []
    before: LedgerReadback | None = None
    if len(probes) < 2:
        return {
            "scenario": "lost_tool_response",
            "checks": [
                asdict(
                    CheckResult(
                        "lost_tool_response.fixture",
                        FAIL,
                        "native fixture requires two fresh worker probes",
                    )
                )
            ],
        }
    try:
        for probe in probes:
            parsed = parse_episode(probe.episode)
            if (
                parsed.model.api != probe.api
                or not probe.framework
                or not probe.episode_token
                or not probe.ingress_token
            ):
                raise ValueError("incomplete actual worker probe")
    except (EpisodeError, TypeError, ValueError):
        return {
            "scenario": "lost_tool_response",
            "checks": [
                asdict(
                    CheckResult(
                        "lost_tool_response.fixture",
                        FAIL,
                        "native fixture requires valid bound episode probes",
                    )
                )
            ],
        }
    for index, probe in enumerate(probes):
        scenario = Scenario(
            "lost_tool_response",
            "Recover the original governed attempt after response loss",
            [
                {"tools": [{"name": tool, "arguments": dict(arguments)}]},
                {"text": "Await control-plane reconciliation."},
            ],
            _open,
            allowed=[tool],
        )
        world = World(token=probe.episode_token, script=scenario.script)
        episode = copy.deepcopy(probe.episode)
        try:
            relay = ResponseLossRelay(
                gateway_url,
                framework=probe.framework,
                episode_id=episode["episode_id"],
                tool=tool,
                drop_first=index == 0,
                world=world,
                tls=tls,
                allow_loopback_http=allow_loopback_http,
            )
            with ExitStack() as cleanup:
                mcp = serve(relay.handle, bind, 0)
                cleanup.callback(stop, mcp)
                model = serve(model_stub.make_handler(world), bind, 0)
                cleanup.callback(stop, model)
                mcp_name = f"[{mcp_host}]" if ":" in mcp_host else mcp_host
                model_name = f"[{model_host}]" if ":" in model_host else model_host
                episode["tools"] = {
                    "allowed": [tool],
                    "mcp_url": f"http://{mcp_name}:{mcp.server_address[1]}/mcp",
                }
                episode["model"]["base_url"] = f"http://{model_name}:{model.server_address[1]}"
                client = A2AClient(probe.worker_url, probe.ingress_token)
                card = client.fetch_card()
                if card.status != 200 or probe.api not in card_model_apis(client.card):
                    raise ValueError("actual worker card/API not available")
                run = Run(
                    scenario.id,
                    probe.api,
                    episode,
                    world,
                    client,
                    probe.episode_token,
                    probe.ingress_token,
                    sinkhole,
                )
                check_extension_declared(run)
                _open(run)
                _finish(run, SCENARIO_TIMEOUT)
                _standard(run, {"TASK_STATE_FAILED", "TASK_STATE_INPUT_REQUIRED"})
                assert run.stream is not None
                run.check(
                    "lost_tool_response.no_completion",
                    not artifact_events(run.stream, "helm.report")
                    and not any(e.state == "TASK_STATE_COMPLETED" for e in run.stream.snapshot()),
                    "a transport loss or recovered effect is not an applied work report",
                )
                run.check(
                    "lost_tool_response.only_scripted_intent",
                    bool(world.mcp_calls)
                    and all(c.tool == tool and c.arguments == arguments for c in world.mcp_calls),
                    "worker attempted an unscripted effect or changed its intent",
                )
                results.extend(run.results)
                calls.extend(relay.calls)
                if index == 0 and calls:
                    before = readback(calls[0].attempt_id)
        except Exception:
            results.append(
                CheckResult(
                    "lost_tool_response.fixture",
                    FAIL,
                    "native worker/gateway fixture did not produce complete readback",
                )
            )
            break
        finally:
            world.stop.set()
    if before is None or not calls:
        results.append(
            CheckResult(
                "lost_tool_response.native_readback",
                FAIL,
                "no accepted native attempt/readback; cannot claim replay conformance",
            )
        )
    else:
        try:
            results.append(
                CheckResult(
                    "lost_tool_response.retained_work_binding",
                    PASS
                    if all(
                        p.episode.get("work_item_id") == before.binding.get("work_item_id")
                        for p in probes
                    )
                    and before.binding.get("episode_id") == probes[0].episode.get("episode_id")
                    and before.binding.get("organization_version_id")
                    == probes[0].episode.get("organization", {}).get("version_id")
                    and before.binding.get("requester_principal_id")
                    == probes[0].episode.get("seat", {}).get("principal_id")
                    else FAIL,
                    "fixture probes must bind the actual original work, episode and requester",
                )
            )
            results.extend(replay_checks(calls, before, readback(calls[0].attempt_id)))
        except Exception:
            results.append(
                CheckResult(
                    "lost_tool_response.native_readback",
                    FAIL,
                    "operator-authorized native readback unavailable",
                )
            )
    return {
        "scenario": "lost_tool_response",
        "checks": [asdict(r) for r in results],
        "probes": len(probes),
        "accepted_calls": len(calls),
    }
