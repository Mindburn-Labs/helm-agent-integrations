#!/usr/bin/env python3
"""kubectl-guard — HELM-governed kubectl shim (sample-only demo).

Place this executable earlier in PATH than the real kubectl (under the name
`kubectl`) and every kubectl invocation — including the ones `kubectl-ai`
executes through its shell-based `kubectl` tool — is evaluated against a local
HELM AI Kernel boundary before dispatch:

    READ_ONLY   -> ALLOW (dispatched, receipt recorded)
    MUTATING    -> policy decides (demo policy: ESCALATE, approval required)
    EXEC_CHANNEL-> policy decides (demo policy: ESCALATE, approval required)
    DESTRUCTIVE -> policy decides (demo policy: DENY)
    unknown     -> treated as MUTATING (fail-safe)

The shim is fail-closed: in the default `enforce` mode any evaluation failure
(kernel unreachable, HTTP error, timeout, malformed response) blocks the
command. `observe` mode logs the would-be verdict and dispatches anyway, for
shadow rollouts.

This is a sample integration demo. It is not HELM conformance, not a certified
connector, and not a production trust anchor. See README.md.

Configuration (environment):
    HELM_URL                       default http://127.0.0.1:7714
    HELM_API_KEY                   tenant-scoped evaluate API key (required)
    HELM_RUNTIME_TENANT_ID         default "local-demo"
    HELM_RUNTIME_PRINCIPAL_ID      default "kubectl-ai-agent"
    HELM_SESSION_ID                default "kubectl-ai-session"
    HELM_APPROVAL_REF              optional approval reference, forwarded on
                                   re-evaluation after an ESCALATE
    HELM_KUBECTL_REAL              explicit path to the real kubectl binary
    HELM_KUBECTL_GUARD_MODE        "enforce" (default) | "observe"
    HELM_KUBECTL_GUARD_RECEIPTS    receipt JSONL path
                                   (default ~/.helm/kubectl-guard/receipts.jsonl)
    HELM_KUBECTL_GUARD_TIMEOUT     evaluate timeout seconds (default 10)
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence, Tuple

ACTION_URN = "tool.kubectl_ai.execute"
DEFAULT_HELM_URL = "http://127.0.0.1:7714"

CLASS_READ_ONLY = "read_only"
CLASS_MUTATING = "mutating"
CLASS_DESTRUCTIVE = "destructive"
CLASS_EXEC_CHANNEL = "exec_channel"

# verb -> risk/effect classification -------------------------------------------

READ_ONLY_VERBS = frozenset(
    {
        "get",
        "describe",
        "logs",
        "log",
        "top",
        "api-resources",
        "api-versions",
        "version",
        "explain",
        "diff",
        "wait",
        "cluster-info",
    }
)

MUTATING_VERBS = frozenset(
    {
        "apply",
        "create",
        "patch",
        "replace",
        "scale",
        "annotate",
        "label",
        "set",
        "edit",
        "expose",
        "autoscale",
        "run",
        "taint",
        "cordon",
        "uncordon",
    }
)

DESTRUCTIVE_VERBS = frozenset({"delete", "drain"})

EXEC_CHANNEL_VERBS = frozenset({"exec", "cp", "attach", "port-forward", "proxy", "debug"})

# Global flags that consume a separate value token before the verb.
_VALUE_FLAGS = frozenset(
    {
        "-n",
        "--namespace",
        "--context",
        "--kubeconfig",
        "--cluster",
        "--user",
        "-s",
        "--server",
        "--as",
        "--as-group",
        "--token",
        "--certificate-authority",
        "--request-timeout",
        "--cache-dir",
        "-o",
        "--output",
        "--v",
        "--vmodule",
        "--log-dir",
        "--context-name",
    }
)

# Flags that never consume a separate value token (boolean global flags).
_BOOL_FLAGS = frozenset(
    {
        "-A",
        "--all-namespaces",
        "--insecure-skip-tls-verify",
        "-h",
        "--help",
        "--as-uid",
    }
)


@dataclass(frozen=True)
class KubectlIntent:
    """Normalized kubectl invocation."""

    verb: str
    subverb: str
    command_class: str
    resource: str
    namespace: str
    context: str
    all_namespaces: bool
    dry_run: bool
    summary: str
    facts: Mapping[str, Any] = field(default_factory=dict)


class GuardError(RuntimeError):
    """Fatal guard error; caller decides enforce/observe behavior."""


def _split_flag(token: str) -> Tuple[str, Optional[str]]:
    """Split --flag=value into (flag, value); otherwise (token, None)."""
    if token.startswith("--") and "=" in token:
        flag, value = token.split("=", 1)
        return flag, value
    return token, None


def parse_argv(argv: Sequence[str]) -> KubectlIntent:
    """Parse kubectl argv (without the leading `kubectl`) into an intent."""
    tokens = list(argv)
    verb = ""
    subverb = ""
    resource = ""
    namespace = "default"
    context = ""
    all_namespaces = False
    dry_run = False
    idx = 0
    positional: list[str] = []

    while idx < len(tokens):
        token = tokens[idx]
        flag, inline_value = _split_flag(token)
        if flag in _VALUE_FLAGS:
            value = inline_value if inline_value is not None else (tokens[idx + 1] if idx + 1 < len(tokens) else "")
            if inline_value is None:
                idx += 1
            if flag in ("-n", "--namespace"):
                namespace = value or namespace
            elif flag == "--context":
                context = value
        elif flag in _BOOL_FLAGS:
            if flag in ("-A", "--all-namespaces"):
                all_namespaces = True
        elif token.startswith("-"):
            # Verb-local flags are collected once the verb is known; before the
            # verb we conservatively skip unknown flags without consuming a
            # value token (kubectl global boolean flags).
            if token.startswith("--dry-run"):
                dry_run_value = inline_value if inline_value is not None else "client"
                dry_run = dry_run_value != "none"
        else:
            verb = token
            positional = tokens[idx + 1 :]
            break
        idx += 1

    if not verb:
        raise GuardError("no kubectl verb found in invocation")

    # Scan remaining positionals for resource name and verb-local flags.
    cleaned: list[str] = []
    jdx = 0
    while jdx < len(positional):
        token = positional[jdx]
        flag, inline_value = _split_flag(token)
        if flag in ("-n", "--namespace"):
            value = inline_value if inline_value is not None else (positional[jdx + 1] if jdx + 1 < len(positional) else "")
            if inline_value is None:
                jdx += 1
            namespace = value or namespace
        elif flag in ("-A", "--all-namespaces"):
            all_namespaces = True
        elif flag == "--dry-run" or token.startswith("--dry-run"):
            if inline_value is None and token == "--dry-run" and jdx + 1 < len(positional) and not positional[jdx + 1].startswith("-"):
                dry_run = positional[jdx + 1] != "none"
                jdx += 1
            else:
                dry_run = (inline_value or "client") != "none"
        elif flag in ("-f", "--filename", "-l", "--selector", "--field-selector", "-o", "--output", "--for", "--timeout", "--container", "-c"):
            if inline_value is None:
                jdx += 1
        elif token.startswith("-"):
            pass
        else:
            cleaned.append(token)
        jdx += 1

    # Two-word verbs.
    targets: list[str] = []
    if verb in ("rollout", "config", "auth", "certificate") and cleaned:
        subverb = cleaned[0]
        resource = cleaned[1] if len(cleaned) > 1 else ""
        targets = cleaned[1:]
    elif cleaned:
        resource = cleaned[0]
        targets = cleaned

    command_class = classify(verb, subverb)
    if dry_run and command_class in (CLASS_MUTATING, CLASS_DESTRUCTIVE):
        command_class = CLASS_READ_ONLY

    summary_parts = [verb]
    if subverb:
        summary_parts.append(subverb)
    summary_parts.extend(targets)
    if all_namespaces:
        summary_parts.append("--all-namespaces")
    elif namespace != "default":
        summary_parts.append(f"-n {namespace}")

    return KubectlIntent(
        verb=verb,
        subverb=subverb,
        command_class=command_class,
        resource=resource,
        namespace=namespace,
        context=context,
        all_namespaces=all_namespaces,
        dry_run=dry_run,
        summary=" ".join(summary_parts),
        facts={
            "verb": verb,
            "subverb": subverb,
            "command_class": command_class,
            "resource": resource,
            "namespace": namespace,
            "context": context,
            "all_namespaces": all_namespaces,
            "dry_run": dry_run,
        },
    )


def classify(verb: str, subverb: str) -> str:
    """Map a kubectl verb to a command class. Unknown verbs fail safe."""
    if verb in READ_ONLY_VERBS:
        return CLASS_READ_ONLY
    if verb in DESTRUCTIVE_VERBS:
        return CLASS_DESTRUCTIVE
    if verb in EXEC_CHANNEL_VERBS:
        return CLASS_EXEC_CHANNEL
    if verb in MUTATING_VERBS:
        return CLASS_MUTATING
    if verb == "rollout":
        return CLASS_READ_ONLY if subverb in ("status", "history") else CLASS_MUTATING
    if verb == "config":
        return CLASS_READ_ONLY if subverb in ("view", "current-context", "get-contexts", "get-clusters", "get-users") else CLASS_MUTATING
    if verb == "auth":
        return CLASS_READ_ONLY if subverb == "can-i" else CLASS_MUTATING
    if verb == "certificate":
        return CLASS_MUTATING
    return CLASS_MUTATING


def risk_and_effect(command_class: str) -> Tuple[str, str]:
    if command_class == CLASS_READ_ONLY:
        return "T1", "E2"
    if command_class == CLASS_MUTATING:
        return "T2", "E3"
    return "T3", "E4"  # destructive, exec_channel


@dataclass(frozen=True)
class GuardConfig:
    helm_url: str
    api_key: str
    tenant_id: str
    principal_id: str
    session_id: str
    approval_ref: str
    mode: str
    receipts_path: Path
    timeout: float
    real_kubectl: str


def load_config(env: Mapping[str, str], argv0_dir: str) -> GuardConfig:
    mode = (env.get("HELM_KUBECTL_GUARD_MODE") or "enforce").strip().lower()
    if mode not in ("enforce", "observe"):
        raise GuardError(f"unsupported HELM_KUBECTL_GUARD_MODE {mode!r}")
    receipts = env.get("HELM_KUBECTL_GUARD_RECEIPTS") or str(
        Path.home() / ".helm" / "kubectl-guard" / "receipts.jsonl"
    )
    try:
        timeout = float(env.get("HELM_KUBECTL_GUARD_TIMEOUT") or "10")
    except ValueError as exc:
        raise GuardError("HELM_KUBECTL_GUARD_TIMEOUT must be a number") from exc
    return GuardConfig(
        helm_url=(env.get("HELM_URL") or DEFAULT_HELM_URL).rstrip("/"),
        api_key=(env.get("HELM_API_KEY") or env.get("HELM_ADMIN_API_KEY") or "").strip(),
        tenant_id=(env.get("HELM_RUNTIME_TENANT_ID") or "local-demo").strip(),
        principal_id=(env.get("HELM_RUNTIME_PRINCIPAL_ID") or "kubectl-ai-agent").strip(),
        session_id=(env.get("HELM_SESSION_ID") or "kubectl-ai-session").strip(),
        approval_ref=(env.get("HELM_APPROVAL_REF") or "").strip(),
        mode=mode,
        receipts_path=Path(receipts),
        timeout=timeout,
        real_kubectl=resolve_real_kubectl(env, argv0_dir),
    )


def resolve_real_kubectl(env: Mapping[str, str], argv0_dir: str) -> str:
    """Find the real kubectl: explicit override, else first PATH hit that is
    not the shim's own directory."""
    override = (env.get("HELM_KUBECTL_REAL") or "").strip()
    if override:
        return override
    own_dir = os.path.realpath(argv0_dir) if argv0_dir else ""
    for entry in (env.get("PATH") or "").split(os.pathsep):
        if not entry:
            continue
        if own_dir and os.path.realpath(entry) == own_dir:
            continue
        candidate = os.path.join(entry, "kubectl")
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    raise GuardError(
        "real kubectl not found in PATH; set HELM_KUBECTL_REAL to its absolute path"
    )


@dataclass(frozen=True)
class Verdict:
    verdict: str
    reason_code: str
    receipt_id: str
    decision_id: str
    raw: Mapping[str, Any]


def evaluate(config: GuardConfig, intent: KubectlIntent) -> Verdict:
    """Submit the intent to POST /api/v1/evaluate and parse the verdict."""
    if not config.api_key:
        raise GuardError("HELM_API_KEY (or HELM_ADMIN_API_KEY) is required for evaluation")
    risk_class, effect_class = risk_and_effect(intent.command_class)
    args: dict[str, Any] = dict(intent.facts)
    args["command"] = intent.summary
    if config.approval_ref:
        args["approval_refs"] = [config.approval_ref]
    payload = {
        "principal": config.principal_id,
        "action": "EXECUTE_TOOL",
        "resource": ACTION_URN,
        "context": {
            "tool": ACTION_URN,
            "args": args,
            "arguments": args,
            "agent_id": config.principal_id,
            "effect_level": effect_class,
            "session_id": config.session_id,
            "action_urn": ACTION_URN,
            "risk_class": risk_class,
            "effect_class": effect_class,
            "metadata": {"shim": "kubectl-guard", "shim_version": "0.1.0"},
        },
    }
    request = urllib.request.Request(
        f"{config.helm_url}/api/v1/evaluate",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {config.api_key}",
            "Content-Type": "application/json",
            "X-Helm-Tenant-ID": config.tenant_id,
            "X-Helm-Principal-ID": config.principal_id,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=config.timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
            headers = {key.lower(): value for key, value in response.headers.items()}
    except urllib.error.HTTPError as exc:
        raise GuardError(f"HELM evaluate failed with HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise GuardError(f"HELM evaluate transport failed: {exc}") from exc

    candidate = body
    for key in ("decision", "record", "result"):
        if isinstance(body, Mapping) and isinstance(body.get(key), Mapping):
            candidate = body[key]
            break
    verdict = str(
        candidate.get("verdict")
        or candidate.get("status")
        or body.get("verdict")
        or "DENY"
    ).upper()
    if verdict not in ("ALLOW", "DENY", "ESCALATE"):
        raise GuardError(f"HELM evaluate returned unexpected verdict {verdict!r}")
    return Verdict(
        verdict=verdict,
        reason_code=str(
            headers.get("x-helm-reason-code")
            or candidate.get("reason_code")
            or body.get("reason_code")
            or ""
        ),
        receipt_id=str(
            headers.get("x-helm-receipt-id") or candidate.get("receipt_id") or body.get("receipt_id") or ""
        ),
        decision_id=str(
            headers.get("x-helm-decision-id")
            or candidate.get("decision_id")
            or body.get("decision_id")
            or candidate.get("id")
            or ""
        ),
        raw=candidate if isinstance(candidate, Mapping) else {},
    )


def record_receipt(config: GuardConfig, intent: KubectlIntent, verdict: Verdict, dispatched: bool) -> None:
    """Append a local JSONL receipt mirror. Never blocks the verdict path."""
    try:
        config.receipts_path.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "action_urn": ACTION_URN,
            "command": intent.summary,
            "command_class": intent.command_class,
            "namespace": intent.namespace,
            "context": intent.context,
            "verdict": verdict.verdict,
            "reason_code": verdict.reason_code,
            "receipt_id": verdict.receipt_id,
            "decision_id": verdict.decision_id,
            "approval_ref": config.approval_ref or None,
            "mode": config.mode,
            "dispatched": dispatched,
        }
        with config.receipts_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, sort_keys=True) + "\n")
    except OSError as exc:
        print(f"kubectl-guard: receipt mirror failed: {exc}", file=sys.stderr)


def announce(intent: KubectlIntent, verdict: Verdict, note: str = "") -> None:
    bits = [
        f"kubectl-guard: {verdict.verdict}",
        f"class={intent.command_class}",
        f"cmd='{intent.summary}'",
    ]
    if verdict.reason_code:
        bits.append(f"reason={verdict.reason_code}")
    if verdict.receipt_id:
        bits.append(f"receipt={verdict.receipt_id}")
    if note:
        bits.append(note)
    print(" ".join(bits), file=sys.stderr)


def dispatch(config: GuardConfig, argv: Sequence[str]) -> int:
    """Replace this process with the real kubectl."""
    os.execv(config.real_kubectl, [config.real_kubectl, *argv])
    return 127  # unreachable; execv either replaces or raises


def main(argv: Sequence[str], env: Optional[Mapping[str, str]] = None) -> int:
    env = dict(os.environ if env is None else env)
    argv0_dir = os.path.dirname(os.path.abspath(sys.argv[0]))
    try:
        config = load_config(env, argv0_dir)
        intent = parse_argv(argv)
    except GuardError as exc:
        mode = (env.get("HELM_KUBECTL_GUARD_MODE") or "enforce").strip().lower()
        print(f"kubectl-guard: blocked before evaluation: {exc}", file=sys.stderr)
        if mode == "observe":
            print("kubectl-guard: observe mode — dispatching unevaluated", file=sys.stderr)
            real = (env.get("HELM_KUBECTL_REAL") or "").strip()
            if real:
                os.execv(real, [real, *argv])
        return 1

    try:
        verdict = evaluate(config, intent)
    except GuardError as exc:
        print(f"kubectl-guard: evaluation failed: {exc}", file=sys.stderr)
        if config.mode == "observe":
            print(
                f"kubectl-guard: observe mode — dispatching '{intent.summary}' without verdict",
                file=sys.stderr,
            )
            return dispatch(config, argv)
        print("kubectl-guard: enforce mode is fail-closed; command blocked", file=sys.stderr)
        return 1

    if verdict.verdict == "ALLOW":
        announce(intent, verdict)
        record_receipt(config, intent, verdict, dispatched=True)
        return dispatch(config, argv)

    if verdict.verdict == "ESCALATE":
        announce(intent, verdict, note="approval required")
        record_receipt(config, intent, verdict, dispatched=False)
        print(
            "kubectl-guard: mutation held for approval. Complete the approval "
            "ceremony for decision "
            f"{verdict.decision_id or '(no decision id)'} with your HELM operator, "
            "then re-run with HELM_APPROVAL_REF=<approval-id>.",
            file=sys.stderr,
        )
        return 2

    # DENY
    announce(intent, verdict, note="command denied")
    record_receipt(config, intent, verdict, dispatched=False)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
