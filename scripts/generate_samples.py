#!/usr/bin/env python3
"""Generate deterministic sample receipts and EvidencePack archives."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import tarfile
import tempfile
from pathlib import Path
from typing import Any, Optional

if __package__:
    from .sample_scenarios import SCENARIOS, Scenario
else:
    from sample_scenarios import SCENARIOS, Scenario

FIXED_TIME = "2026-06-05T00:00:00Z"
REPO_ROOT = Path(__file__).resolve().parents[1]
LOOP_REQUIRED_FIELDS = {
    "agent_run_receipt_version",
    "loop_class",
    "goal",
    "stop_condition",
    "max_iterations",
    "iteration_count",
    "progress_state",
    "budget_exhausted",
    "verifier_refs",
    "evidence_refs",
    "approval_refs",
    "memory_effects",
    "denied_effects",
    "recurring_effects",
}


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def pretty_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode("utf-8")


def sha256(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def validate_scenario(scenario: Scenario) -> None:
    if scenario.effect_class not in {"E0", "E1", "E2", "E3", "E4"}:
        raise ValueError(f"{scenario.scenario_id}: effect_class must be canonical E0-E4")
    if scenario.dispatched and scenario.verdict in {"DENY", "ESCALATE", "PENDING"}:
        raise ValueError(f"{scenario.scenario_id}: blocked verdicts must not dispatch")
    if scenario.loop is None:
        return
    missing = sorted(LOOP_REQUIRED_FIELDS - set(scenario.loop))
    if missing:
        raise ValueError(f"{scenario.scenario_id}: loop metadata missing {', '.join(missing)}")
    if scenario.loop["agent_run_receipt_version"] != "agent_run_receipt.v2":
        raise ValueError(f"{scenario.scenario_id}: loop receipt metadata must use agent_run_receipt.v2")
    if scenario.loop["loop_class"] == "operate" and not scenario.loop["approval_refs"] and scenario.verdict != "DENY":
        raise ValueError(f"{scenario.scenario_id}: operate without approval evidence must be denied")
    if scenario.loop["memory_effects"].get("accepted_without_review") is True:
        raise ValueError(f"{scenario.scenario_id}: memory effects must not be accepted without review")


def _fact_satisfied(key: str, expected: Any, facts: dict[str, Any]) -> bool:
    if key == "contains":
        return any(isinstance(value, str) and expected in value for value in facts.values())
    if expected is None:
        return facts.get(key) is None
    if expected == "*":
        return facts.get(key) is not None
    return facts.get(key) == expected


def assert_reason_code_backed(scenario: Scenario) -> dict[str, Any]:
    """Assert the scenario's reason code is backed by a reference-policy rule.

    Returns the matched rule's facts so receipts can record the concrete
    policy facts that produced the verdict. Fails generation if the reason
    code has no backing rule, the verdict differs, or any policy fact is not
    proven by the scenario's facts.
    """
    reference_path = REPO_ROOT / "policies" / "reference" / f"{Path(scenario.policy).stem}.json"
    if not reference_path.exists():
        raise ValueError(f"{scenario.scenario_id}: missing reference policy {reference_path.name}")
    reference = json.loads(reference_path.read_text(encoding="utf-8"))
    rules = [rule for rule in reference.get("rules", []) if rule.get("reason_code") == scenario.reason_code]
    if not rules:
        raise ValueError(
            f"{scenario.scenario_id}: reason_code {scenario.reason_code} has no backing rule "
            f"in {reference_path.name}"
        )
    rule = rules[0]
    if rule.get("verdict") != scenario.verdict:
        raise ValueError(
            f"{scenario.scenario_id}: verdict {scenario.verdict} does not match reference rule "
            f"verdict {rule.get('verdict')} for {scenario.reason_code}"
        )
    facts = {
        "action_urn": scenario.action_urn,
        "risk_class": scenario.risk_class,
        **scenario.arguments,
        **scenario.policy_facts,
    }
    for key, expected in rule.get("match", {}).items():
        if not _fact_satisfied(key, expected, facts):
            raise ValueError(
                f"{scenario.scenario_id}: policy fact {key}={expected!r} required by "
                f"{scenario.reason_code} is not proven by the scenario"
            )
    return dict(rule.get("match", {}))


def receipt_for(scenario: Scenario) -> dict[str, Any]:
    validate_scenario(scenario)
    policy_facts = assert_reason_code_backed(scenario)
    receipt = {
        "schema_version": "helm.integration.receipt.sample.v1",
        "scenario_id": scenario.scenario_id,
        "framework": scenario.framework,
        "title": scenario.title,
        "decision_id": f"decision:{scenario.scenario_id}",
        "receipt_id": f"receipt:{scenario.scenario_id}",
        "issued_at": FIXED_TIME,
        "action_urn": scenario.action_urn,
        "risk_class": scenario.risk_class,
        "effect_class": scenario.effect_class,
        "verdict": scenario.verdict,
        "reason_code": scenario.reason_code,
        "dispatched": scenario.dispatched,
        "policy": scenario.policy,
        "policy_facts": policy_facts,
        "arguments_hash": sha256(canonical_bytes(scenario.arguments)),
        "source": "generated by scripts/generate_samples.py",
        "kernel_source_truth": "helm-ai-kernel",
        "sample_only": True,
    }
    if scenario.loop is not None:
        receipt["loop"] = scenario.loop
    receipt["receipt_hash"] = sha256(canonical_bytes(receipt))
    return receipt


def connector_evidence_for(scenario: Scenario, receipt: dict[str, Any]) -> Optional[dict[str, Any]]:
    if scenario.framework == "mcp-playwright":
        selector = str(scenario.arguments.get("selector", ""))
        proof = {
            "connector_id": "playwright-mcp-admin-demo",
            "connector_contract_hash": sha256(canonical_bytes({"connector_id": "playwright-mcp-admin-demo"})),
            "policy_hash": sha256(canonical_bytes({"policy": scenario.policy})),
            "request_hash": sha256(canonical_bytes(scenario.arguments)),
            "source_url_hashes": [sha256(url.encode("utf-8")) for url in scenario.source_urls],
            "action_name": scenario.arguments.get("action_name"),
            "action_intent": scenario.arguments.get("action_intent"),
            "selector_hash": sha256(selector.encode("utf-8")),
            "receipt_ref": receipt["receipt_id"],
            "evidence_pack_ref": f"evidencepack:{scenario.scenario_id}",
            "fixture_id": scenario.scenario_id,
            "sample_only": True,
            "production": False,
        }
        proof["response_hash"] = sha256(
            canonical_bytes({"verdict": scenario.verdict, "reason_code": scenario.reason_code})
        )
        return proof

    if scenario.framework != "tinyfish" or not scenario.source_urls:
        return None

    proof = {
        "connector_id": "tinyfish-web-v1",
        "connector_contract_hash": sha256(canonical_bytes({"connector_id": "tinyfish-web-v1"})),
        "policy_hash": sha256(canonical_bytes({"policy": scenario.policy})),
        "request_hash": sha256(canonical_bytes(scenario.arguments)),
        "source_url_hashes": [sha256(url.encode("utf-8")) for url in scenario.source_urls],
        "receipt_ref": receipt["receipt_id"],
        "evidence_pack_ref": f"evidencepack:{scenario.scenario_id}",
        "fixture_id": scenario.scenario_id,
        "sample_only": True,
        "production": False,
    }
    if scenario.verdict == "DENY":
        proof["error_hash"] = sha256(canonical_bytes({"reason_code": scenario.reason_code}))
    else:
        proof["response_hash"] = sha256(canonical_bytes({"verdict": scenario.verdict, "reason_code": scenario.reason_code}))
    return proof


def formal_proof_files_for(scenario: Scenario, receipt: dict[str, Any]) -> dict[str, bytes]:
    if scenario.formal_proof is None:
        return {}

    obligation_id = str(scenario.formal_proof["obligation_id"])
    status = str(scenario.formal_proof["status"])
    if status not in {"PROVED", "REFUTED", "UNKNOWN", "BUDGET_EXHAUSTED", "TOOLCHAIN_ERROR"}:
        raise ValueError(f"{scenario.scenario_id}: invalid formal proof status {status}")

    verification_scope_ref = f"verification-scope:{scenario.scenario_id}:formal-proof"
    proof_result_ref = f"proof-result:{scenario.scenario_id}:formal-proof"
    verification_scope = {
        "schema_version": "helm.integration.formal_proof.verification_scope.sample.v1",
        "verification_scope_ref": verification_scope_ref,
        "scenario_id": scenario.scenario_id,
        "coverage": scenario.formal_proof["coverage"],
        "residual_risk": scenario.formal_proof["residual_risk"],
        "sample_only": True,
    }
    result = {
        "schema_version": "helm.integration.formal_proof.proof_result.sample.v1",
        "result_ref": proof_result_ref,
        "obligation_id": obligation_id,
        "status": status,
        "cpi_behavior": "ALLOW_CONTINUE" if status == "PROVED" else "ESCALATE_NO_DISPATCH",
        "receipt_ref": receipt["receipt_id"],
        "evidence_pack_ref": f"evidencepack:{scenario.scenario_id}",
        "verification_scope_ref": verification_scope_ref,
        "side_effect_dispatched": scenario.dispatched,
        "source": "generated by scripts/generate_samples.py",
        "kernel_source_truth": "helm-ai-kernel",
        "sample_only": True,
    }
    result["result_hash"] = sha256(canonical_bytes(result))
    return {
        "99_EXT/helm-formal-proof/proof_result.json": pretty_bytes(result),
        "99_EXT/helm-formal-proof/verification_scope.json": pretty_bytes(verification_scope),
    }


def scenario_doc(scenario: Scenario) -> dict[str, Any]:
    doc = {
        "scenario_id": scenario.scenario_id,
        "framework": scenario.framework,
        "title": scenario.title,
        "action_urn": scenario.action_urn,
        "arguments": scenario.arguments,
        "expected_verdict": scenario.verdict,
        "must_not_dispatch": not scenario.dispatched,
        "policy": scenario.policy,
        "sample_only": True,
    }
    if scenario.formal_proof is not None:
        doc["formal_proof_extension"] = scenario.formal_proof
    if scenario.loop is not None:
        doc["loop"] = scenario.loop
    return doc


def add_tar_file(tar: tarfile.TarFile, name: str, data: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mtime = 0
    info.mode = 0o644
    tar.addfile(info, io.BytesIO(data))


def evidence_pack_bytes(scenario: Scenario, receipt: dict[str, Any]) -> bytes:
    connector_evidence = connector_evidence_for(scenario, receipt)
    decision = {
        "decision_id": receipt["decision_id"],
        "verdict": scenario.verdict,
        "reason_code": scenario.reason_code,
        "action_urn": scenario.action_urn,
        "policy": scenario.policy,
        "issued_at": FIXED_TIME,
        "sample_only": True,
    }
    files = {
        "01_DECISIONS/decision.json": pretty_bytes(decision),
        f"02_PROOFGRAPH/receipts/{scenario.scenario_id}.json": pretty_bytes(receipt),
        "03_SCENARIO/scenario.json": pretty_bytes(scenario_doc(scenario)),
        "07_ATTESTATIONS/README.md": (
            b"# Sample EvidencePack\n\n"
            b"This deterministic archive is generated for integration demos. "
            b"It is not a customer trust anchor.\n"
        ),
    }
    if connector_evidence is not None:
        files["07_ATTESTATIONS/connector_evidence.json"] = pretty_bytes({"records": [connector_evidence]})
    files.update(formal_proof_files_for(scenario, receipt))
    index = {
        "schema_version": "helm.integration.evidencepack.sample.v1",
        "scenario_id": scenario.scenario_id,
        "generated_at": FIXED_TIME,
        "sample_only": True,
        "files": [
            {"path": path, "sha256": sha256(data)}
            for path, data in sorted(files.items())
        ],
    }
    files = {"00_INDEX.json": pretty_bytes(index), **files}

    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as tar:
        for path, data in sorted(files.items()):
            add_tar_file(tar, path, data)
    return stream.getvalue()


def write_outputs(root: Path) -> None:
    receipts_dir = root / "receipts" / "samples"
    evidence_dir = root / "evidencepacks" / "samples"
    receipts_dir.mkdir(parents=True, exist_ok=True)
    evidence_dir.mkdir(parents=True, exist_ok=True)

    for old in receipts_dir.glob("*.json"):
        old.unlink()
    for old in evidence_dir.glob("*.tar"):
        old.unlink()

    sums: list[str] = []
    for scenario in SCENARIOS:
        receipt = receipt_for(scenario)
        receipt_path = receipts_dir / f"{scenario.scenario_id}.json"
        receipt_path.write_bytes(pretty_bytes(receipt))

        pack_data = evidence_pack_bytes(scenario, receipt)
        pack_name = f"{scenario.scenario_id}.tar"
        (evidence_dir / pack_name).write_bytes(pack_data)
        sums.append(f"{hashlib.sha256(pack_data).hexdigest()}  {pack_name}\n")

    (evidence_dir / "SHA256SUMS.txt").write_text("".join(sorted(sums)), encoding="utf-8")


def compare_trees(expected: Path, actual: Path) -> list[str]:
    diffs: list[str] = []
    for path in sorted(expected.rglob("*")):
        if path.is_dir():
            continue
        rel = path.relative_to(expected)
        other = actual / rel
        if not other.exists():
            diffs.append(f"missing generated file: {rel}")
        elif path.read_bytes() != other.read_bytes():
            diffs.append(f"generated file drift: {rel}")
    for path in sorted(actual.rglob("*")):
        if path.is_dir():
            continue
        rel = path.relative_to(actual)
        if not (expected / rel).exists():
            diffs.append(f"unexpected tracked sample file: {rel}")
    return diffs


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail if generated samples differ from tracked files")
    parser.add_argument("--root", default=Path(__file__).resolve().parents[1], type=Path)
    args = parser.parse_args()

    root = args.root.resolve()
    if not args.check:
        write_outputs(root)
        return 0

    with tempfile.TemporaryDirectory() as tmp:
        tmp_root = Path(tmp) / "repo"
        (tmp_root / "receipts" / "samples").mkdir(parents=True)
        (tmp_root / "evidencepacks" / "samples").mkdir(parents=True)
        write_outputs(tmp_root)

        tracked = Path(tmp) / "tracked"
        shutil.copytree(root / "receipts", tracked / "receipts")
        shutil.copytree(root / "evidencepacks", tracked / "evidencepacks")
        diffs = compare_trees(tmp_root, tracked)
        if diffs:
            for diff in diffs:
                print(diff)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
