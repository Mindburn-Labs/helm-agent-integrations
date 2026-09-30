"""Run kit scenarios against the in-process reference worker."""

from __future__ import annotations

import socket
from typing import Any

from helm_worker_conformance.reference_worker import ReferenceWorker
from helm_worker_conformance.runner import run_scenario
from helm_worker_conformance.sinkhole import Sinkhole

TOKEN = "episode-token-for-tests"
INGRESS = "ingress-secret-for-tests"


def free_port(kind: int = socket.SOCK_STREAM) -> int:
    with socket.socket(socket.AF_INET, kind) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def run_reference(
    scenario: str,
    api: str = "openai-chat-completions",
    *,
    mutations: frozenset[str] = frozenset(),
    supported_apis: tuple[str, ...] | None = None,
) -> dict[str, Any]:
    """One scenario against a fresh reference worker; returns the runner's JSON result."""
    sink_port = free_port()
    sinkhole = Sinkhole(
        "127.0.0.1", bind="127.0.0.1", dns_port=free_port(socket.SOCK_DGRAM), tcp_ports=(sink_port,)
    )
    kwargs: dict[str, Any] = {}
    if supported_apis is not None:
        kwargs["supported_apis"] = supported_apis
    worker = ReferenceWorker(
        ingress_token=INGRESS,
        env={"HELM_EPISODE_TOKEN": TOKEN, "EXFIL_ADDR": f"127.0.0.1:{sink_port}"},
        mutations=mutations,
        **kwargs,
    )
    url = worker.start()
    try:
        return run_scenario(
            scenario,
            worker_url=url,
            token=TOKEN,
            ingress_token=INGRESS,
            api=api,
            mcp_host="127.0.0.1",
            model_host="127.0.0.1",
            bind="127.0.0.1",
            sinkhole=sinkhole,
        )
    finally:
        worker.stop()


def statuses(result: dict[str, Any]) -> dict[str, str]:
    return {c["name"]: c["status"] for c in result["checks"]}
