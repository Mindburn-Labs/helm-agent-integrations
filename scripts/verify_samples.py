#!/usr/bin/env python3
"""Verify generated sample receipt hashes and EvidencePack archives."""

from __future__ import annotations

import argparse
import hashlib
import json
import tarfile
from pathlib import Path
from typing import Any


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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=Path(__file__).resolve().parents[1], type=Path)
    args = parser.parse_args()
    root = args.repo.resolve()
    errors = verify_receipts(root) + verify_evidencepacks(root)
    if errors:
        for error in errors:
            print(error)
        return 1
    print("sample receipts and EvidencePacks verify")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
