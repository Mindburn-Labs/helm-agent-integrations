"""Run one scenario against a worker from inside the network the worker can reach.

    python -m helm_worker_conformance.runner scenario --id report_completes ...

It hosts the stubs (MCP server, model endpoints, egress sinkhole), plays the control plane's
A2A client, and prints one JSON result on its last line. `helm_worker_conformance` (the
orchestrator) starts it with `docker exec`; tests call `run_scenario` directly.
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import time
import traceback
from dataclasses import asdict
from typing import Any

from helm_worker_contract import EXTENSION_URI, MODEL_APIS

from . import mcp_stub, model_stub
from .a2a import A2AClient, http_request
from .checks import FAIL, PASS, SKIP, CheckResult, Run
from .http_util import serve, stop
from .scenarios import SCENARIOS, build_episode, catalog
from .sinkhole import Sinkhole
from .world import World

READY_TIMEOUT = 90.0


def card_model_apis(card: dict[str, Any]) -> list[str]:
    for extension in (card.get("capabilities") or {}).get("extensions") or []:
        if extension.get("uri") == EXTENSION_URI:
            apis = (extension.get("params") or {}).get("model_apis")
            return [str(a) for a in apis] if isinstance(apis, list) else []
    return []


def wait_ready(worker_url: str, timeout: float = READY_TIMEOUT) -> str | None:
    """Wait for the AgentCard; None when ready, else why it never was."""
    deadline = time.monotonic() + timeout
    last = "no answer"
    while time.monotonic() < deadline:
        try:
            result = http_request(
                "GET", worker_url.rstrip("/") + "/.well-known/agent-card.json", timeout=3
            )
            if result.status == 200:
                return None
            last = f"HTTP {result.status}"
        except OSError as exc:
            last = f"{type(exc).__name__}: {exc}"
        time.sleep(0.25)
    return f"the worker never served its AgentCard ({last})"


def run_scenario(
    scenario_id: str,
    *,
    worker_url: str,
    token: str,
    ingress_token: str,
    api: str,
    mcp_host: str,
    model_host: str,
    bind: str = "0.0.0.0",  # noqa: S104 - the worker must reach the stubs
    mcp_port: int = 0,
    model_port: int = 0,
    sinkhole: Sinkhole | None = None,
) -> dict[str, Any]:
    scenario = SCENARIOS[scenario_id]
    started = time.monotonic()
    world = World(token=token, script=scenario.script, mcp_structured=scenario.mcp_structured)
    mcp_server = serve(mcp_stub.make_handler(world), bind, mcp_port)
    model_server = serve(model_stub.make_handler(world), bind, model_port)
    mcp_url = f"http://{mcp_host}:{mcp_server.server_address[1]}/mcp"
    model_url = f"http://{model_host}:{model_server.server_address[1]}"
    result: dict[str, Any] = {"scenario": scenario_id, "api": api, "checks": [], "error": None}
    try:
        if sinkhole is not None:
            sinkhole.start()
        not_ready = wait_ready(worker_url)
        client = A2AClient(worker_url, ingress_token)
        card = client.fetch_card() if not_ready is None else None
        result["card"] = client.card
        if not_ready:
            result["checks"] = [asdict(CheckResult("worker_ready", FAIL, not_ready))]
            return result
        assert card is not None
        if scenario.only_unsupported_api:
            unsupported = [a for a in MODEL_APIS if a not in card_model_apis(client.card)]
            if not unsupported:
                result["checks"] = [
                    asdict(
                        CheckResult(
                            "rejects_unsupported_model_api",
                            SKIP,
                            "the worker supports every model API",
                        )
                    )
                ]
                return result
            api = result["api"] = unsupported[0]
        episode = build_episode(scenario, api, mcp_url, model_url)
        run = Run(scenario_id, api, episode, world, client, token, ingress_token, sinkhole)
        try:
            scenario.drive(run)
        except Exception:  # a harness bug must not read as a pass
            run.results.append(CheckResult("harness", FAIL, traceback.format_exc(limit=6)))
        result["checks"] = [asdict(c) for c in run.results]
        result["model_calls"] = [
            {
                "path": c.path,
                "turn": c.turn,
                "step": c.step,
                "tools": [t.get("name") for t in c.tools],
                "aborted": c.aborted,
            }
            for c in world.model_calls
        ]
        result["mcp_calls"] = [{"tool": c.tool, "aborted": c.aborted} for c in world.mcp_calls]
        return result
    except Exception:
        result["error"] = traceback.format_exc(limit=8)
        return result
    finally:
        world.stop.set()
        stop(mcp_server)
        stop(model_server)
        if sinkhole is not None:
            sinkhole.stop()
        result["seconds"] = round(time.monotonic() - started, 1)


def isolation_probe(targets: list[str]) -> dict[str, Any]:
    """From inside the network: confirm nothing outside it can be reached."""
    reached = []
    for target in targets:
        host, _, port = target.partition(":")
        try:
            socket.create_connection((host, int(port or 443)), timeout=3).close()
            reached.append(target)
        except OSError:
            pass
    return {
        "checks": [
            asdict(
                CheckResult(
                    "network_isolated",
                    FAIL if reached else PASS,
                    f"reached {reached}" if reached else "",
                )
            )
        ]
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m helm_worker_conformance.runner")
    sub = parser.add_subparsers(dest="command", required=True)
    one = sub.add_parser("scenario")
    one.add_argument("--id", required=True, choices=sorted(SCENARIOS))
    one.add_argument("--api", required=True, choices=MODEL_APIS)
    one.add_argument("--worker-url", required=True)
    one.add_argument("--token", required=True)
    one.add_argument("--ingress-token", required=True)
    one.add_argument("--mcp-host", required=True)
    one.add_argument("--model-host", required=True)
    one.add_argument("--mcp-port", type=int, default=8931)
    one.add_argument("--model-port", type=int, default=8932)
    one.add_argument("--answer-ip", help="address the sinkhole answers every DNS question with")
    sub.add_parser("list")
    iso = sub.add_parser("isolation")
    iso.add_argument("targets", nargs="*", default=["1.1.1.1:443", "8.8.8.8:53", "9.9.9.9:443"])
    args = parser.parse_args(argv)
    if args.command == "list":
        outcome = {"scenarios": catalog()}
    elif args.command == "isolation":
        outcome = isolation_probe(args.targets)
    else:
        outcome = run_scenario(
            args.id,
            worker_url=args.worker_url,
            token=args.token,
            ingress_token=args.ingress_token,
            api=args.api,
            mcp_host=args.mcp_host,
            model_host=args.model_host,
            mcp_port=args.mcp_port,
            model_port=args.model_port,
            sinkhole=Sinkhole(args.answer_ip) if args.answer_ip else None,
        )
    print(json.dumps(outcome))
    return 0


if __name__ == "__main__":
    sys.exit(main())
