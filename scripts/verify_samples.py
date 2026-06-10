#!/usr/bin/env python3
"""Verify generated sample receipt hashes and EvidencePack archives."""

from __future__ import annotations

import argparse
import hashlib
import json
import tarfile
import tomllib
from pathlib import Path
from typing import Any

CANONICAL_VERDICTS = {"ALLOW", "DENY", "ESCALATE"}
POLICY_REFERENCE_SCHEMA = "helm.integration.policy.reference.v1"


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def verify_receipts(root: Path) -> list[str]:
    errors: list[str] = []
    for path in sorted((root / "receipts" / "samples").glob("*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        recorded = doc.get("receipt_hash")
        clone = dict(doc)
        clone.pop("receipt_hash", None)
        expected = sha256(canonical_bytes(clone))
        if recorded != expected:
            errors.append(f"{path}: receipt_hash {recorded!r} != {expected!r}")
        if doc.get("effect_class") not in {"E0", "E1", "E2", "E3", "E4"}:
            errors.append(f"{path}: effect_class must be canonical E0-E4")
        if doc.get("sample_only") is not True:
            errors.append(f"{path}: sample receipt must be marked sample_only=true")
        if doc.get("dispatched") and doc.get("verdict") in {"DENY", "ESCALATE", "PENDING"}:
            errors.append(f"{path}: blocked verdict may not be dispatched")
        policy_ref = doc.get("policy")
        if policy_ref and not (root / policy_ref).is_file():
            errors.append(f"{path}: policy {policy_ref!r} does not resolve to a file")
    return errors


def verify_policies(root: Path) -> list[str]:
    errors: list[str] = []
    policies_dir = root / "policies"

    toml_paths = sorted(policies_dir.glob("*.toml"))
    if not toml_paths:
        return ["no sample policies found under policies/"]

    for path in toml_paths:
        try:
            doc = tomllib.loads(path.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError as exc:
            errors.append(f"{path}: TOML parse error: {exc}")
            continue
        for key in ("name", "profile", "reference_pack"):
            if not doc.get(key):
                errors.append(f"{path}: missing required key {key!r}")
        ref = doc.get("reference_pack")
        if not ref:
            continue
        ref_path = root / str(ref)
        if not ref_path.is_file():
            errors.append(f"{path}: reference_pack {ref!r} does not resolve to a file")
            continue
        reference = json.loads(ref_path.read_text(encoding="utf-8"))
        if reference.get("schema_version") != POLICY_REFERENCE_SCHEMA:
            errors.append(f"{ref_path}: schema_version must be {POLICY_REFERENCE_SCHEMA!r}")
        if reference.get("sample_only") is not True:
            errors.append(f"{ref_path}: reference pack must be marked sample_only=true")
        if reference.get("profile") != doc.get("profile"):
            errors.append(
                f"{ref_path}: profile {reference.get('profile')!r} does not match "
                f"{path.name} profile {doc.get('profile')!r}"
            )
        rules = reference.get("rules", [])
        if not rules:
            errors.append(f"{ref_path}: reference pack must declare rules")
        for idx, rule in enumerate(rules):
            if rule.get("verdict") not in CANONICAL_VERDICTS:
                errors.append(f"{ref_path}: rule {idx} verdict must be one of {sorted(CANONICAL_VERDICTS)}")
            if not rule.get("match"):
                errors.append(f"{ref_path}: rule {idx} missing match")
            if not rule.get("reason_code"):
                errors.append(f"{ref_path}: rule {idx} missing reason_code")

    sums_path = policies_dir / "SHA256SUMS.txt"
    if not sums_path.exists():
        errors.append("missing policies/SHA256SUMS.txt")
        return errors
    expected_sums = {}
    for line in sums_path.read_text(encoding="utf-8").splitlines():
        digest, name = line.split(maxsplit=1)
        expected_sums[name.strip()] = digest

    tracked = toml_paths + sorted((policies_dir / "reference").glob("*.json"))
    for path in tracked:
        rel = path.relative_to(policies_dir).as_posix()
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if rel not in expected_sums:
            errors.append(f"{path}: not listed in policies/SHA256SUMS.txt")
        elif expected_sums[rel] != digest:
            errors.append(f"{path}: policies/SHA256SUMS.txt digest mismatch")
    for name in expected_sums:
        if not (policies_dir / name).is_file():
            errors.append(f"policies/SHA256SUMS.txt lists missing file {name}")
    return errors


def verify_evidencepacks(root: Path) -> list[str]:
    errors: list[str] = []
    evidence_dir = root / "evidencepacks" / "samples"
    sums_path = evidence_dir / "SHA256SUMS.txt"
    if not sums_path.exists():
        return ["missing evidencepacks/samples/SHA256SUMS.txt"]
    expected_sums = {}
    for line in sums_path.read_text(encoding="utf-8").splitlines():
        digest, name = line.split(maxsplit=1)
        expected_sums[name.strip()] = digest

    for path in sorted(evidence_dir.glob("*.tar")):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if expected_sums.get(path.name) != digest:
            errors.append(f"{path}: SHA256SUMS mismatch")
        with tarfile.open(path) as tar:
            members = {member.name: member for member in tar.getmembers()}
            if "00_INDEX.json" not in members:
                errors.append(f"{path}: missing 00_INDEX.json")
                continue
            index_data = tar.extractfile(members["00_INDEX.json"])
            if index_data is None:
                errors.append(f"{path}: unreadable 00_INDEX.json")
                continue
            index = json.loads(index_data.read().decode("utf-8"))
            if index.get("sample_only") is not True:
                errors.append(f"{path}: 00_INDEX.json must be marked sample_only=true")
            for item in index.get("files", []):
                member = members.get(item["path"])
                if member is None:
                    errors.append(f"{path}: missing indexed file {item['path']}")
                    continue
                data_file = tar.extractfile(member)
                if data_file is None:
                    errors.append(f"{path}: unreadable indexed file {item['path']}")
                    continue
                file_bytes = data_file.read()
                if sha256(file_bytes) != item["sha256"]:
                    errors.append(f"{path}: indexed hash mismatch for {item['path']}")
                if item["path"] == "01_DECISIONS/decision.json":
                    decision = json.loads(file_bytes.decode("utf-8"))
                    if decision.get("sample_only") is not True:
                        errors.append(f"{path}: decision fixture must be marked sample_only=true")
                    if decision.get("dispatched") and decision.get("verdict") in {"DENY", "ESCALATE", "PENDING"}:
                        errors.append(f"{path}: blocked decision may not dispatch")
                if item["path"].endswith("connector_evidence.json"):
                    connector = json.loads(file_bytes.decode("utf-8"))
                    records = connector.get("records", [])
                    if not records:
                        errors.append(f"{path}: connector evidence must contain records")
                    for idx, record in enumerate(records):
                        if record.get("sample_only") is not True:
                            errors.append(f"{path}: connector evidence record {idx} must be sample_only=true")
                        if record.get("production") is True:
                            errors.append(f"{path}: connector evidence record {idx} must not be production")
    return errors


def verify_mcp_proof_transcripts(root: Path) -> list[str]:
    errors: list[str] = []
    for path in sorted((root / "demos" / "mcp-boundary").glob("*proof*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        if doc.get("schema_version") != "helm.mcp.proof.public-transcript/v1":
            continue
        if doc.get("no_dispatch") is not True:
            errors.append(f"{path}: proof transcript must declare no_dispatch=true")
        scenarios = doc.get("scenarios", [])
        if not scenarios:
            errors.append(f"{path}: proof transcript must include scenarios")
            continue
        for idx, scenario in enumerate(scenarios):
            verdict = scenario.get("verdict")
            if verdict in {"DENY", "ESCALATE", "PENDING"} and scenario.get("dispatched") is not False:
                errors.append(f"{path}: blocked scenario {idx} may not be dispatched")
            if not scenario.get("receipt_ref"):
                errors.append(f"{path}: scenario {idx} missing receipt_ref")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=Path(__file__).resolve().parents[1], type=Path)
    args = parser.parse_args()
    root = args.repo.resolve()
    errors = (
        verify_receipts(root)
        + verify_evidencepacks(root)
        + verify_mcp_proof_transcripts(root)
        + verify_policies(root)
    )
    if errors:
        for error in errors:
            print(error)
        return 1
    print("sample receipts, EvidencePacks, and policies verify")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
