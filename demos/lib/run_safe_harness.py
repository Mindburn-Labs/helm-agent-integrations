#!/usr/bin/env python3
"""Run a safe fixture-bound smoke check for a HELM demo scenario."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any


def validate_repo_root(path: Path) -> Path:
    root = path.resolve()
    if (root / "scripts" / "verify_samples.py").is_file() and (root / "receipts").is_dir():
        return root
    raise SystemExit(f"invalid --repo: {path}")


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--scenario", required=True, type=Path)
    parser.add_argument("--safe", action="store_true")
    args = parser.parse_args()

    if not args.safe:
        raise SystemExit("only --safe mode is supported by these demos")

    scenario_path = args.scenario.resolve()
    scenario = load_json(scenario_path)
    root = validate_repo_root(args.repo)

    for requirement in scenario.get("safe_harness", {}).get("requires", []):
        command = requirement["command"]
        if shutil.which(command) is None:
            print(f"SKIP {scenario['demo_id']}: missing optional dependency {command}")
            print(requirement.get("skip_message", "Install the dependency to run the live upstream smoke."))
            return 0

    receipt_path = root / scenario["sample_receipt"]
    evidencepack_path = root / scenario["sample_evidencepack"]
    if not receipt_path.is_file():
        raise SystemExit(f"missing sample receipt: {receipt_path}")
    if not evidencepack_path.is_file():
        raise SystemExit(f"missing sample EvidencePack: {evidencepack_path}")

    receipt = load_json(receipt_path)
    expected = scenario["expected"]
    mismatches = []
    for key in ("verdict", "reason_code", "dispatched", "policy"):
        if receipt.get(key) != expected.get(key):
            mismatches.append(f"{key}: receipt={receipt.get(key)!r} expected={expected.get(key)!r}")
    if receipt.get("sample_only") is not True:
        mismatches.append("receipt must be sample_only=true")
    if mismatches:
        print(f"FAIL {scenario['demo_id']}")
        for mismatch in mismatches:
            print(f"- {mismatch}")
        return 1

    print(f"PASS {scenario['demo_id']}: {scenario['title']}")
    print(f"upstream: {scenario['upstream']['name']} @ {scenario['upstream']['ref']}")
    for action in scenario.get("safe_harness", {}).get("actions", []):
        print(
            "action: "
            f"{action['name']} -> {action['expected_verdict']} "
            f"({action['reason_code']}, dispatched={action['dispatched']})"
        )
    print(f"receipt: {scenario['sample_receipt']}")
    print(f"evidencepack: {scenario['sample_evidencepack']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
