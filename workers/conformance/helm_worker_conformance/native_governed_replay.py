"""Direct-native D8 driver; the outer fixture owns Kernel, CP and sandboxes.

Unlike the transport-relay test, this never replaces an episode URL, starts a
model stub, forwards MCP or creates a ledger. A trusted native fixture must
provide observations from the actual worker TLS listener and scoped ledger.
Without that producer this entry point fails, rather than claiming conformance.
"""

from __future__ import annotations

import argparse
import copy
import importlib
import json
import re
from collections.abc import Mapping, Sequence
from contextlib import AbstractContextManager
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any, Protocol, cast
from urllib.parse import urlsplit

from helm_worker_contract import EpisodeError, parse_episode

from .a2a import A2AClient
from .checks import (
    FAIL,
    PASS,
    CheckResult,
    Run,
    artifact_events,
    check_credentials,
    check_extension_declared,
    check_model_requests,
    check_prompt,
    check_token_not_leaked,
    check_tools_offered,
    stream_problems,
)
from .governed_replay import AcceptedCall, LedgerReadback, WorkerProbe, replay_checks
from .runner import card_model_apis
from .scenarios import SCENARIO_TIMEOUT, _finish, _open
from .world import World

MAX_PROBES = 8
_DNS_NAME = re.compile(r"^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$")
_FACTORY = re.compile(r"^[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*:[a-zA-Z_]\w*$")
_BINDING_FIELDS = (
    "tenant_id",
    "workspace_id",
    "work_item_id",
    "episode_id",
    "organization_version_id",
    "requester_principal_id",
)


@dataclass(frozen=True)
class NativeObservation:
    """Operator evidence, not a worker-supplied authority or completion receipt.

    binding is copied from the caller VERIFIED by the native TLS/JWT handler,
    never from decoded-but-unverified JWT claims or the episode message. calls
    includes every accepted tool reply, including the one lost after acceptance.
    Public references identify actual same-sandbox Policy.Readback/negative-egress
    and exact image signature readback performed by the fixture owner.
    """

    calls: tuple[AcceptedCall, ...]
    binding: Mapping[str, str] = field(repr=False)
    isolation_ref: str
    image_verification_ref: str


class NativeFixture(Protocol):
    def arm(
        self,
        probe: WorkerProbe,
        world: World,
        *,
        tool: str,
        arguments: Mapping[str, Any],
        drop_first: bool,
    ) -> None:
        """Arm instrumentation on the native gateway, preserving all probe URLs.

        Script the model BEHIND native modelgw. Authenticate every model/MCP
        request and record actual normalized traffic in world (no credentials in
        logs). Lose exactly the first accepted native MCP reply for drop_first,
        after admission/dispatch, without a forwarding server or adapter retry.
        Actual runtime/image/policy validation is required before A2A starts.
        Every operation has a fixture-owned finite deadline.
        """
        ...

    def observe(self, probe: WorkerProbe) -> NativeObservation:
        """Read complete native traffic/auth/runtime facts for this exact probe.

        Keep native model/tool timing in the host's monotonic clock domain used
        by World. Do not fabricate empty observations or inferred counters.
        """
        ...

    def readback(self, attempt_id: str) -> LedgerReadback:
        """Read operator-authorized original ledger/counters, not worker GetAttempt.

        Cross-episode generic reads remain N1 scoped. The fixture uses actual
        scoped SQL/adapter facts; it neither derives a key nor creates a ledger.
        """
        ...


@dataclass(frozen=True)
class NativeReplay:
    """Private fixture configuration; excluded from repr and public reports."""

    probes: Sequence[WorkerProbe] = field(repr=False)
    tool: str
    arguments: Mapping[str, Any] = field(repr=False)
    fixture: NativeFixture = field(repr=False)
    required_framework: str = "openclaw"


def _validate_probes(probes: Sequence[WorkerProbe], tool: str, required_framework: str) -> None:
    if not 2 <= len(probes) <= MAX_PROBES or not tool:
        raise ValueError("native replay needs bounded, distinct probes")
    episode_ids: set[str] = set()
    worker_urls: set[str] = set()
    frameworks: set[str] = set()
    origins: set[str] = set()
    work_ids: set[str] = set()
    for probe in probes:
        episode = parse_episode(probe.episode)
        model = urlsplit(probe.episode["model"]["base_url"])
        mcp = urlsplit(episode.tools.mcp_url)
        worker = urlsplit(probe.worker_url)
        if (
            not probe.framework
            or not probe.episode_token
            or not probe.ingress_token
            or probe.episode_token == probe.ingress_token
            or episode.model.api != probe.api
            or tuple(episode.tools.allowed) != (tool,)
            or model.scheme != "https"
            or not _DNS_NAME.fullmatch(model.hostname or "")
            or model.port != 8444
            or model.username is not None
            or model.password is not None
            or model.path
            or model.query
            or model.fragment
            or mcp.scheme != model.scheme
            or mcp.netloc != model.netloc
            or mcp.path != "/mcp"
            or mcp.query
            or mcp.fragment
            or worker.scheme != "http"
            or not worker.hostname
            or worker.port != 8080
            or worker.username is not None
            or worker.password is not None
            or worker.path
            or worker.query
            or worker.fragment
            or any(
                ord(c) < 33
                for url in (
                    probe.episode["model"]["base_url"],
                    episode.tools.mcp_url,
                    probe.worker_url,
                )
                for c in url
            )
            or episode.episode_id in episode_ids
            or probe.worker_url in worker_urls
        ):
            raise ValueError("native probe is not bound to the direct gateway profile")
        episode_ids.add(episode.episode_id)
        worker_urls.add(probe.worker_url)
        frameworks.add(probe.framework)
        origins.add(probe.episode["model"]["base_url"])
        work_ids.add(episode.work_item_id)
    if (
        len(frameworks) < 2
        or required_framework not in frameworks
        or len(origins) != 1
        or len(work_ids) != 1
    ):
        raise ValueError("native replay needs one gateway/work and distinct frameworks")


def _observed_binding(probe: WorkerProbe, observation: NativeObservation) -> bool:
    episode = parse_episode(probe.episode)
    binding = observation.binding
    return (
        all(isinstance(binding.get(k), str) and binding[k] for k in _BINDING_FIELDS)
        and binding["work_item_id"] == episode.work_item_id
        and binding["episode_id"] == episode.episode_id
        and binding["organization_version_id"] == episode.organization_version_id
        and binding["requester_principal_id"] == episode.seat.principal_id
        and bool(observation.calls)
        and all(
            c.episode_id == episode.episode_id and c.framework == probe.framework
            for c in observation.calls
        )
    )


def _report(
    checks: Sequence[CheckResult],
    probes: Sequence[WorkerProbe],
    calls: int,
    observations: Sequence[NativeObservation] = (),
) -> dict[str, Any]:
    # Common protocol diagnostics may quote worker data. Remove either private
    # bearer from every diagnostic before it reaches stdout or a persisted report.
    secrets = [s for p in probes for s in (p.episode_token, p.ingress_token) if s]

    def redact(text: str) -> str:
        for secret in secrets:
            text = text.replace(secret, "[redacted]")
        return text

    safe: list[dict[str, Any]] = []
    for check in checks:
        entry = asdict(check)
        entry["detail"] = redact(entry["detail"])
        safe.append(entry)
    return {
        "scenario": "lost_tool_response_native",
        "checks": safe,
        "probes": len(probes),
        "accepted_calls": calls,
        "proof_scope": "native gateway governed replay; not an applied work report or release",
        "runtime_evidence": [
            {
                "isolation": redact(o.isolation_ref),
                "image_verification": redact(o.image_verification_ref),
            }
            for o in observations
        ],
    }


def run_native_lost_tool_response(config: NativeReplay) -> dict[str, Any]:
    """Drive each privately provisioned fresh worker once; never re-launch/resend.

    Only the outer fixture creates/destroys resources and performs Kernel/CP
    reconciliation. A lost A2A response is a failed qualification, not permission
    to send another first message. No probe, URL, token or argument is returned.
    """
    probes = config.probes
    checks: list[CheckResult] = []
    calls: list[AcceptedCall] = []
    observations: list[NativeObservation] = []
    before: LedgerReadback | None = None
    try:
        _validate_probes(probes, config.tool, config.required_framework)
        arguments = copy.deepcopy(dict(config.arguments))
    except (EpisodeError, KeyError, TypeError, ValueError):
        return _report(
            [CheckResult("lost_tool_response.fixture", FAIL, "direct native probes unavailable")],
            probes,
            0,
        )

    for index, probe in enumerate(probes):
        original = copy.deepcopy(probe.episode)
        world = World(token=probe.episode_token)
        run: Run | None = None
        try:
            config.fixture.arm(
                probe,
                world,
                tool=config.tool,
                arguments=copy.deepcopy(arguments),
                drop_first=index == 0,
            )
            if probe.episode != original:
                raise ValueError("fixture changed the retained probe")
            client = A2AClient(probe.worker_url, probe.ingress_token)
            card = client.fetch_card()
            if card.status != 200 or probe.api not in card_model_apis(client.card):
                raise ValueError("actual worker card/API unavailable")
            run = Run(
                "lost_tool_response_native",
                probe.api,
                copy.deepcopy(original),
                world,
                client,
                probe.episode_token,
                probe.ingress_token,
            )
            check_extension_declared(run)
            _open(run)
            _finish(run, SCENARIO_TIMEOUT)
            observed = config.fixture.observe(probe)
            observation = replace(
                observed, calls=tuple(observed.calls), binding=dict(observed.binding)
            )
            if probe.episode != original:
                raise ValueError("fixture changed the retained probe")
            observations.append(observation)
            assert run.stream is not None
            problems = stream_problems(
                run, run.stream, {"TASK_STATE_FAILED", "TASK_STATE_INPUT_REQUIRED"}
            )
            run.check("streaming_events", not problems, "; ".join(problems[:6]))
            check_credentials(run)
            check_model_requests(run)
            check_tools_offered(run)
            check_prompt(run)
            check_token_not_leaked(run)
            run.check(
                "lost_tool_response.native_runtime_readback",
                bool(observation.isolation_ref) and bool(observation.image_verification_ref),
                "actual same-sandbox isolation/image verification evidence is missing",
            )
            run.check(
                "lost_tool_response.verified_probe_binding",
                _observed_binding(probe, observation),
                "actual gateway-authenticated probe binding is missing or different",
            )
            run.check(
                "lost_tool_response.no_completion",
                not artifact_events(run.stream, "helm.report")
                and not any(e.state == "TASK_STATE_COMPLETED" for e in run.stream.snapshot()),
                "response loss/replay is not a Kernel-applied work report",
            )
            run.check(
                "lost_tool_response.only_scripted_intent",
                bool(world.mcp_calls)
                and all(
                    c.tool == config.tool and c.arguments == arguments for c in world.mcp_calls
                ),
                "worker attempted an unscripted effect or changed its intent",
            )
            checks.extend(run.results)
            calls.extend(observation.calls)
            if any(check.status != PASS for check in run.results):
                # In particular, lost/invalid A2A task acceptance cannot authorize
                # another first message or the next fresh episode probe.
                break
            if index == 0 and calls:
                retained = config.fixture.readback(calls[0].attempt_id)
                before = replace(
                    retained,
                    attempt_ids=tuple(retained.attempt_ids),
                    binding=dict(retained.binding),
                )
        except Exception:
            checks.append(
                CheckResult(
                    "lost_tool_response.fixture",
                    FAIL,
                    "native fixture did not produce complete authenticated readback",
                )
            )
            break
        finally:
            world.stop.set()
            if run is not None and run.stream is not None:
                try:
                    run.stream.close()
                except (AttributeError, OSError):
                    checks.append(
                        CheckResult(
                            "lost_tool_response.stream_cleanup", FAIL, "stream close failed"
                        )
                    )

    if before is None or not calls:
        checks.append(
            CheckResult(
                "lost_tool_response.native_readback", FAIL, "native attempt evidence missing"
            )
        )
    else:
        try:
            checks.append(
                CheckResult(
                    "lost_tool_response.retained_scope_binding",
                    PASS
                    if len(observations) == len(probes)
                    and all(
                        all(
                            o.binding.get(k) == before.binding.get(k)
                            for k in ("tenant_id", "workspace_id", "work_item_id")
                        )
                        for o in observations
                    )
                    and all(
                        before.binding.get(k) == observations[0].binding.get(k)
                        for k in _BINDING_FIELDS
                    )
                    else FAIL,
                    "native probes/original attempt do not share the retained scope/work",
                )
            )
            checks.extend(
                replay_checks(calls, before, config.fixture.readback(calls[0].attempt_id))
            )
        except Exception:
            checks.append(
                CheckResult("lost_tool_response.native_readback", FAIL, "native ledger unavailable")
            )
    return _report(checks, probes, len(calls), observations)


def main(argv: list[str] | None = None) -> int:
    """Use an explicit operator fixture factory; there is no fake default fixture.

    MODULE:factory returns a context manager yielding NativeReplay. The caller
    owns private configuration/credentials and bounded cleanup. No credential
    is accepted as a command-line argument or serialized in the result.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", required=True, metavar="MODULE:factory")
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if not _FACTORY.fullmatch(args.fixture):
            raise ValueError("invalid fixture factory")
        module, name = args.fixture.split(":", 1)
        factory = getattr(importlib.import_module(module), name)
        context = cast(AbstractContextManager[NativeReplay], factory())
        with context as config:
            if not isinstance(config, NativeReplay):
                raise TypeError("native fixture contract unavailable")
            result = run_native_lost_tool_response(config)
    except Exception:
        result = {
            "scenario": "lost_tool_response_native",
            "checks": [
                asdict(
                    CheckResult("lost_tool_response.fixture", FAIL, "native fixture unavailable")
                )
            ],
        }
    args.report.write_text(json.dumps(result, indent=2) + "\n")
    passed = bool(result["checks"]) and all(c["status"] == PASS for c in result["checks"])
    print("lost_tool_response_native: " + ("PASS" if passed else "FAIL"))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
