"""Exercise actual vendor SDKs against the committed kit; no provider or paid model calls.

Run with the SDK dependencies installed and all adapter/runtime packages on PYTHONPATH.
Docker conformance remains the proof of network isolation and published image behavior.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from helm_worker_runtime import Worker

from helm_worker_conformance.runner import run_scenario
from helm_worker_conformance.scenarios import SCENARIOS
from helm_worker_conformance.sinkhole import Sinkhole


def run_one(framework: str, scenario: str, api: str) -> dict[str, Any]:
    if framework == "openai-agents":
        from helm_openai_worker.engine import run

        apis = ("openai-responses",)
    elif framework == "langgraph":
        from helm_langgraph_worker.engine import run

        apis = ("openai-chat-completions", "anthropic-messages")
    else:
        from helm_claude_worker.engine import run

        apis = ("anthropic-messages",)
    worker = Worker(
        framework,
        apis,
        run,
        ingress_token="ingress-test-secret",
        env={"HELM_EPISODE_TOKEN": "episode-test-secret"},
    )
    diagnostics = []
    original = worker.bounded

    async def diagnostic(session: Any) -> None:
        try:
            await original(session)
        except BaseException as exc:
            if not isinstance(exc, asyncio.CancelledError):
                diagnostics.append(str(worker.safe(f"{type(exc).__name__}: {exc}")))
            raise

    worker.bounded = diagnostic  # type: ignore[method-assign]
    url = worker.start()
    sinkhole = Sinkhole("127.0.0.1", bind="127.0.0.1", dns_port=0, tcp_ports=(0,))
    try:
        result = run_scenario(
            scenario,
            worker_url=url,
            token="episode-test-secret",
            ingress_token="ingress-test-secret",
            api=api,
            mcp_host="127.0.0.1",
            model_host="127.0.0.1",
            bind="127.0.0.1",
            sinkhole=sinkhole,
        )
        result["framework"] = framework
        result["diagnostics"] = diagnostics
        return result
    finally:
        worker.stop()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--framework", action="append", choices=["claude-agent-sdk", "openai-agents", "langgraph"]
    )
    parser.add_argument("--scenario", action="append", choices=list(SCENARIOS))
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    os.environ.setdefault(
        "HELM_CLAUDE_ENGINE", str(Path(__file__).parents[2] / "claude-agent-sdk/engine.mjs")
    )
    jobs = []
    for framework in args.framework or ["claude-agent-sdk", "openai-agents", "langgraph"]:
        apis = {
            "claude-agent-sdk": ("anthropic-messages",),
            "openai-agents": ("openai-responses",),
            "langgraph": ("openai-chat-completions", "anthropic-messages"),
        }[framework]
        for sid in args.scenario or SCENARIOS:
            for api in apis[:1] if SCENARIOS[sid].api_independent else apis:
                jobs.append((framework, sid, api))
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda job: run_one(*job), jobs))
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(results, indent=2) + "\n")
    failures = 0
    for result in results:
        failed = [c for c in result["checks"] if c["status"] == "fail"]
        failures += bool(failed or result.get("error"))
        print(
            f"{result['framework']}/{result['scenario']}/{result['api']}: "
            + (
                "FAIL "
                + json.dumps(
                    {
                        "checks": failed,
                        "error": result.get("error"),
                        "diagnostics": result.get("diagnostics"),
                    }
                )
                if failed or result.get("error")
                else "PASS"
            ),
            flush=True,
        )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
