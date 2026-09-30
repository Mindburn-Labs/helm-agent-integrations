"""Run the conformance kit.

    python -m helm_worker_conformance --image ghcr.io/mindburn-labs/helm-worker-langgraph@sha256:...
    python -m helm_worker_conformance --image helm-worker-claude-agent-sdk:dev --scenario report_completes

The worker image runs on an isolated Docker network (see docker_mode). Exit status 0 means every
check passed; skipped checks are reported and never count as passes of their own.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from . import docker_mode


def _print_result(result: dict[str, Any]) -> None:
    checks = result.get("checks", [])
    failed = [c for c in checks if c["status"] == "fail"]
    skipped = [c for c in checks if c["status"] == "skip"]
    status = "FAIL" if failed or result.get("error") else "ok  "
    print(
        f"{status} {result['scenario']:32} {result.get('api', ''):26} {len(checks) - len(skipped) - len(failed)}/{len(checks)} checks  {result.get('seconds', '?')}s",
        flush=True,
    )
    if result.get("error"):
        print(f"       harness error: {str(result['error']).strip().splitlines()[-1]}")
    for check in failed:
        print(f"       FAIL {check['name']}: {check['detail']}")
    for check in skipped:
        print(f"       skip {check['name']}: {check['detail']}")
    if failed or result.get("error"):
        for line in result.get("worker_log_tail", [])[-12:]:
            print(f"       | {line}")


def _run_url(args: argparse.Namespace) -> list[dict[str, Any]]:
    from .runner import card_model_apis, run_scenario
    from .scenarios import SCENARIOS

    results = []
    apis: list[str] = list(args.api or [])
    for scenario in SCENARIOS.values():
        if args.scenario and scenario.id not in args.scenario:
            continue
        if scenario.id != "agent_card" and not apis:
            probe = run_scenario(
                "agent_card",
                worker_url=args.worker_url,
                token=args.episode_token,
                ingress_token=args.ingress_token,
                api="anthropic-messages",
                mcp_host=args.stub_host,
                model_host=args.stub_host,
            )
            apis = card_model_apis(probe.get("card") or {})
        for api in (
            [apis[0] if apis else "anthropic-messages"]
            if scenario.api_independent
            else apis or ["anthropic-messages"]
        ):
            result = run_scenario(
                scenario.id,
                worker_url=args.worker_url,
                token=args.episode_token,
                ingress_token=args.ingress_token,
                api=api,
                mcp_host=args.stub_host,
                model_host=args.stub_host,
            )
            results.append(result)
            _print_result(result)
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m helm_worker_conformance",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument(
        "--image", help="worker image to test (a tag, or repo@sha256:digest of a published image)"
    )
    target.add_argument(
        "--worker-url",
        help="an already running worker (no network isolation: egress checks are skipped)",
    )
    parser.add_argument("--scenario", action="append", help="run only this scenario (repeatable)")
    parser.add_argument(
        "--api", action="append", help="model API to sweep (default: every API the card advertises)"
    )
    parser.add_argument("--report", type=Path, help="write the full JSON report here")
    parser.add_argument("--logs", type=Path, help="write each worker container's log here")
    parser.add_argument(
        "-e",
        "--env",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="extra environment for the worker container (repeatable)",
    )
    parser.add_argument(
        "--episode-token", default="episode-token", help="url mode: the worker's HELM_EPISODE_TOKEN"
    )
    parser.add_argument(
        "--ingress-token",
        default="ingress-token",
        help="url mode: the worker's HELM_A2A_BEARER_TOKEN",
    )
    parser.add_argument(
        "--stub-host",
        default="127.0.0.1",
        help="url mode: address the worker reaches this machine at",
    )
    parser.add_argument("command", nargs="*", help="after --: override the image's command")
    args = parser.parse_args(argv)

    started = time.monotonic()
    try:
        if args.image:
            results = docker_mode.run_image(
                args.image,
                only=args.scenario,
                apis=args.api,
                command=args.command,
                extra_env=dict(item.split("=", 1) for item in args.env),
                logs_dir=args.logs,
                progress=_print_result,
            )
        else:
            results = _run_url(args)
    except docker_mode.DockerError as exc:
        print(f"conformance kit could not run: {exc}", file=sys.stderr)
        return 2

    failed = [
        r for r in results if r.get("error") or any(c["status"] == "fail" for c in r["checks"])
    ]
    passed = sum(1 for r in results for c in r["checks"] if c["status"] == "pass")
    skipped = sum(1 for r in results for c in r["checks"] if c["status"] == "skip")
    print(
        f"\n{len(results)} scenario runs, {passed} checks passed, {sum(1 for r in results for c in r['checks'] if c['status'] == 'fail')} failed, {skipped} skipped, {time.monotonic() - started:.0f}s"
    )
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps({"image": args.image, "results": results}, indent=2))
    if not results:
        print("no scenario ran", file=sys.stderr)
        return 2
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
