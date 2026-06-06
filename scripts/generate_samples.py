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
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

FIXED_TIME = "2026-06-05T00:00:00Z"


@dataclass(frozen=True)
class Scenario:
    scenario_id: str
    framework: str
    title: str
    action_urn: str
    risk_class: str
    effect_class: str
    verdict: str
    reason_code: str
    dispatched: bool
    policy: str
    arguments: dict[str, Any]
    source_urls: tuple[str, ...] = ()


SCENARIOS = [
    Scenario(
        scenario_id="mcp-unknown-tool-quarantine",
        framework="mcp",
        title="Unknown MCP tool is quarantined before dispatch",
        action_urn="tool.mcp.gmail.send_email",
        risk_class="T2",
        effect_class="E4",
        verdict="ESCALATE",
        reason_code="MCP_UNKNOWN_TOOL_QUARANTINE",
        dispatched=False,
        policy="policies/mcp.quarantine.strict.toml",
        arguments={"server_id": "gmail-local", "tool": "gmail.send_email"},
    ),
    Scenario(
        scenario_id="openai-proxy-side-effect-deny",
        framework="openai-compatible-proxy",
        title="OpenAI-compatible proxy blocks direct side-effect request",
        action_urn="tool.proxy.shell.execute",
        risk_class="T2",
        effect_class="E4",
        verdict="DENY",
        reason_code="PROXY_SIDE_EFFECT_DENY",
        dispatched=False,
        policy="policies/agent.devtools.high_risk.toml",
        arguments={"command": "rm -rf ./secrets"},
    ),
    Scenario(
        scenario_id="wrapper-email-escalate",
        framework="generic-wrapper",
        title="Wrapped email send requires human approval",
        action_urn="tool.gmail.send_email",
        risk_class="T2",
        effect_class="E4",
        verdict="ESCALATE",
        reason_code="EXTERNAL_SEND_REQUIRES_APPROVAL",
        dispatched=False,
        policy="policies/agent.email.high_risk.toml",
        arguments={"to": "investor@example.com", "subject": "Follow-up"},
    ),
    Scenario(
        scenario_id="hermes-dangerous-shell-deny",
        framework="hermes",
        title="Hermes destructive shell command is denied",
        action_urn="tool.hermes.terminal",
        risk_class="T2",
        effect_class="E4",
        verdict="DENY",
        reason_code="FORBIDDEN_PATH_DENY",
        dispatched=False,
        policy="policies/agent.devtools.high_risk.toml",
        arguments={"command": "rm -rf ./dist ./node_modules ./secrets"},
    ),
    Scenario(
        scenario_id="openclaw-email-escalate",
        framework="openclaw",
        title="OpenClaw email send escalates before external delivery",
        action_urn="tool.openclaw.gmail-send",
        risk_class="T2",
        effect_class="E4",
        verdict="ESCALATE",
        reason_code="OPENCLAW_EXTERNAL_SEND_ESCALATE",
        dispatched=False,
        policy="policies/agent.email.high_risk.toml",
        arguments={"to": "investor@example.com", "draft_id": "draft_123"},
    ),
    Scenario(
        scenario_id="langgraph-drop-table-deny",
        framework="langgraph",
        title="LangGraph SQL mutation is denied",
        action_urn="tool.sql.execute",
        risk_class="T2",
        effect_class="E4",
        verdict="DENY",
        reason_code="SQL_DESTRUCTIVE_MUTATION_DENY",
        dispatched=False,
        policy="policies/agent.devtools.high_risk.toml",
        arguments={"query": "DROP TABLE customers"},
    ),
    Scenario(
        scenario_id="browser-submit-escalate",
        framework="browser-use",
        title="Browser checkout submit escalates before form submission",
        action_urn="tool.browser_use.submit",
        risk_class="T2",
        effect_class="E4",
        verdict="ESCALATE",
        reason_code="BROWSER_SUBMIT_ESCALATE",
        dispatched=False,
        policy="policies/agent.browser.high_risk.toml",
        arguments={"url": "https://shop.example/checkout", "button": "Place order"},
    ),
    Scenario(
        scenario_id="e2b-network-egress-deny",
        framework="e2b",
        title="E2B sandbox network egress is denied",
        action_urn="tool.e2b.execute",
        risk_class="T2",
        effect_class="E3",
        verdict="DENY",
        reason_code="SANDBOX_NETWORK_EGRESS_DENY",
        dispatched=False,
        policy="policies/agent.devtools.high_risk.toml",
        arguments={"language": "python", "code": "import requests; requests.get('https://exfil.example')"},
    ),
    Scenario(
        scenario_id="composio-salesforce-export-deny",
        framework="composio",
        title="Composio Salesforce export is denied",
        action_urn="tool.composio.salesforce.export_records",
        risk_class="T2",
        effect_class="E4",
        verdict="DENY",
        reason_code="BULK_EXPORT_DENY",
        dispatched=False,
        policy="policies/agent.email.high_risk.toml",
        arguments={"object": "Lead", "limit": 50000},
    ),
    Scenario(
        scenario_id="tinyfish-search-missing-api-key-deny",
        framework="tinyfish",
        title="TinyFish Search denies before dispatch when the API key is missing",
        action_urn="tool.tinyfish.search.query",
        risk_class="T2",
        effect_class="E2",
        verdict="DENY",
        reason_code="TINYFISH_MISSING_API_KEY_DENY",
        dispatched=False,
        policy="policies/tinyfish.web_capability.toml",
        arguments={"query": "HELM governed web capability"},
    ),
    Scenario(
        scenario_id="tinyfish-fetch-partial-source-deny",
        framework="tinyfish",
        title="TinyFish Fetch partial source errors cannot be promoted as complete evidence",
        action_urn="tool.tinyfish.fetch.extract",
        risk_class="T2",
        effect_class="E2",
        verdict="DENY",
        reason_code="TINYFISH_FETCH_PARTIAL_SOURCE_DENY",
        dispatched=False,
        policy="policies/tinyfish.web_capability.toml",
        arguments={
            "urls": ["https://example.com/source-ok", "https://example.com/source-error"],
            "format": "markdown",
            "ttl": 3600,
        },
        source_urls=("https://example.com/source-ok", "https://example.com/source-error"),
    ),
    Scenario(
        scenario_id="tinyfish-browser-credential-grant-escalate",
        framework="tinyfish",
        title="TinyFish Browser credential session escalates until grant and TTL are approved",
        action_urn="tool.tinyfish.browser.session",
        risk_class="T2",
        effect_class="E3",
        verdict="ESCALATE",
        reason_code="TINYFISH_BROWSER_CREDENTIAL_GRANT_ESCALATE",
        dispatched=False,
        policy="policies/tinyfish.web_capability.toml",
        arguments={
            "url": "https://portal.example/login",
            "credential_grant_ref": "grant:demo",
            "ttl_seconds": 900,
        },
        source_urls=("https://portal.example/login",),
    ),
    Scenario(
        scenario_id="tinyfish-agent-external-action-escalate",
        framework="tinyfish",
        title="TinyFish Agent external action escalates before submit or publish",
        action_urn="tool.tinyfish.agent.external_action",
        risk_class="T2",
        effect_class="E4",
        verdict="ESCALATE",
        reason_code="TINYFISH_AGENT_EXTERNAL_ACTION_ESCALATE",
        dispatched=False,
        policy="policies/tinyfish.web_capability.toml",
        arguments={
            "url": "https://shop.example/checkout",
            "goal": "Submit the saved cart",
            "action_intent": "submit",
        },
        source_urls=("https://shop.example/checkout",),
    ),
]


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


def receipt_for(scenario: Scenario) -> dict[str, Any]:
    validate_scenario(scenario)
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
        "arguments_hash": sha256(canonical_bytes(scenario.arguments)),
        "source": "generated by scripts/generate_samples.py",
        "kernel_source_truth": "helm-ai-kernel",
        "sample_only": True,
    }
    receipt["receipt_hash"] = sha256(canonical_bytes(receipt))
    return receipt


def connector_evidence_for(scenario: Scenario, receipt: dict[str, Any]) -> Optional[dict[str, Any]]:
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


def scenario_doc(scenario: Scenario) -> dict[str, Any]:
    return {
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
