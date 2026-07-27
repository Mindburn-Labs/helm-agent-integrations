#!/usr/bin/env python3
"""Governed Daytona sandbox demo: normalize -> HELM preflight -> dispatch on ALLOW.

Offline by default: a stub transport answers the evaluate calls with the
reference demo rules, nothing dispatches, and the run self-checks its expected
verdicts. Live mode (--live) preflights against a running HELM AI Kernel and,
on ALLOW, provisions a real Daytona sandbox with the compiled constraints.

Sample-only demo. Verdict, receipt, and EvidencePack semantics remain owned by
helm-ai-kernel; the JSONL written to ./out is demo output, not an EvidencePack.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Mapping

REPO_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO_ROOT / "packages" / "python" / "helm_tool_wrapper"))

from helm_tool_wrapper import (  # noqa: E402
    BoundaryIntent,
    from_daytona_sandbox_create,
    from_daytona_ssh_grant,
    preflight_action,
)

SESSION_ID = "daytona-governed-demo"

ALLOWLISTED_CREATE = {
    "snapshot": "daytonaio/sandbox:latest",
    "sandbox_class": "container",
    "cpu": 1,
    "memory": 1,
    "disk": 3,
    "domain_allow_list": ["pypi.org", "files.pythonhosted.org"],
    "auto_stop_interval": 15,
    "auto_delete_interval": 0,
}

PROPOSALS: list[tuple[str, BoundaryIntent, str, Mapping[str, Any]]] = [
    (
        "unbounded-create",
        from_daytona_sandbox_create({"snapshot": "daytonaio/sandbox:latest"}),
        "DENY",
        {},
    ),
    (
        "allowlisted-create",
        from_daytona_sandbox_create(ALLOWLISTED_CREATE),
        "ALLOW",
        ALLOWLISTED_CREATE,
    ),
    (
        "ssh-grant",
        from_daytona_ssh_grant({"sandbox_id": "sbx-governed-demo", "expires_in_minutes": 60}),
        "ESCALATE",
        {},
    ),
]


def stub_transport(
    _url: str,
    payload: Mapping[str, Any],
    _timeout: float,
    _headers: Mapping[str, str],
) -> tuple[int, Mapping[str, Any], Mapping[str, str]]:
    """Answer evaluate calls with the reference demo rules. Sample only."""
    context = payload.get("context") or {}
    action_urn = str(context.get("action_urn"))
    metadata = context.get("metadata") or {}
    name = str(metadata.get("demo_name", action_urn))
    if action_urn == "tool.daytona.sandbox.create" and metadata.get("network") == "external":
        verdict, reason = "DENY", "SANDBOX_UNBOUNDED_EGRESS_DENY"
    elif action_urn == "tool.daytona.sandbox.ssh_grant":
        verdict, reason = "ESCALATE", "SANDBOX_HUMAN_ACCESS_ESCALATE"
    else:
        verdict, reason = "ALLOW", None
    decision = {
        "verdict": verdict,
        "decision_id": f"decision:demo:{name}",
        "receipt_id": f"receipt:demo:{name}",
        "reason_code": reason,
        "sample_only": True,
    }
    return 200, {"decision": decision}, {"x-helm-verdict": verdict}


def compile_create_params(call: Mapping[str, Any], decision_id: str | None) -> dict[str, Any]:
    """Compile ALLOW constraints into Daytona sandbox create parameters.

    Field names pinned against the Apache-2.0 `daytona` Python SDK as of
    2026-07; verify on first live run and adjust here if the SDK renames them.
    """
    return {
        "snapshot": call["snapshot"],
        "cpu": call.get("cpu"),
        "memory": call.get("memory"),
        "disk": call.get("disk"),
        "network_block_all": False,
        "domain_allow_list": list(call.get("domain_allow_list", [])),
        "auto_stop_interval": call.get("auto_stop_interval"),
        "auto_delete_interval": call.get("auto_delete_interval"),
        "labels": {
            "helm.session_id": SESSION_ID,
            "helm.decision_id": decision_id or "unknown",
        },
    }


def dispatch_live(params: dict[str, Any]) -> dict[str, Any]:
    try:
        from daytona import Daytona  # type: ignore[import-not-found]
    except ImportError:
        return {"dispatch_error": "daytona SDK not installed; pip install daytona"}
    client = Daytona()  # reads DAYTONA_API_KEY from the environment
    sandbox = client.create(**{k: v for k, v in params.items() if v is not None})
    try:
        response = sandbox.process.exec("echo governed-by-helm")
        output = getattr(response, "result", str(response))
    finally:
        sandbox.delete()
    return {"sandbox_output": output}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="evaluate against a running kernel and dispatch on ALLOW")
    args = parser.parse_args()

    if args.live:
        missing = [k for k in ("HELM_URL", "HELM_API_KEY", "HELM_TENANT_ID", "DAYTONA_API_KEY") if not os.environ.get(k)]
        if missing:
            print(f"live mode needs env vars: {', '.join(missing)}")
            return 2

    out_dir = Path(__file__).resolve().parent / "out"
    out_dir.mkdir(exist_ok=True)
    log_path = out_dir / f"governed-daytona-demo-{int(time.time())}.jsonl"

    chain = "sha256:" + hashlib.sha256(b"governed-daytona-demo").hexdigest()
    mismatches: list[str] = []
    with log_path.open("w", encoding="utf-8") as log:
        for name, intent, expected, dispatch_call in PROPOSALS:
            result = preflight_action(
                action_urn=intent.action_urn,
                input=intent.input,
                session_id=SESSION_ID,
                tenant_id=os.environ.get("HELM_TENANT_ID", "tenant-demo"),
                principal="daytona-demo-agent",
                api_key=os.environ.get("HELM_API_KEY", "demo-key"),
                helm_url=os.environ.get("HELM_URL"),
                risk_class=intent.risk_class,
                effect_class=intent.effect_class,
                metadata={**intent.metadata, "demo_name": name},
                transport=None if args.live else stub_transport,
            )
            record: dict[str, Any] = {
                "sample_only": True,
                "demo_output_not_evidencepack": True,
                "name": name,
                "action_urn": intent.action_urn,
                "verdict": result.verdict,
                "reason_code": result.decision.reason_code,
                "decision_id": result.decision.decision_id or result.decision.id,
                "receipt_ref": result.receipt.receipt_id if result.receipt else None,
                "dispatched": False,
            }
            if result.allowed and dispatch_call:
                params = compile_create_params(dispatch_call, record["decision_id"])
                record["compiled_create_params"] = params
                if args.live:
                    record.update(dispatch_live(params))
                    record["dispatched"] = "dispatch_error" not in record
            body = json.dumps(record, sort_keys=True, separators=(",", ":"))
            chain = "sha256:" + hashlib.sha256((chain + body).encode("utf-8")).hexdigest()
            record["chain"] = chain
            log.write(json.dumps(record, sort_keys=True) + "\n")
            print(f"{name}: {result.verdict}" + (f" ({record['reason_code']})" if record["reason_code"] else ""))
            if not args.live and result.verdict != expected:
                mismatches.append(f"{name}: expected {expected}, got {result.verdict}")

    print(f"log: {log_path}")
    if mismatches:
        # Offline verdicts are asserted; live verdicts are owned by the active policy.
        print("self-check failed:\n  " + "\n  ".join(mismatches))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
