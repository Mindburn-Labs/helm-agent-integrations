"""Codex command hook; sends metadata to an explicitly configured core sink."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

from policy import tool_deny

MAX_INPUT_BYTES = 1024 * 1024


def parse_event(raw):
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError("Hook input exceeded the local limit.")
    def reject_constant(_value):
        raise ValueError("Hook input must be JSON.")

    event = json.loads(raw, parse_constant=reject_constant)
    if not isinstance(event, dict) or event.get("hook_event_name") != "PreToolUse":
        raise ValueError("Invalid PreToolUse event.")
    for key in ("session_id", "turn_id", "tool_use_id", "tool_name"):
        value = event.get(key)
        if not isinstance(value, str) or not value or len(value) > 512:
            raise ValueError("Hook event identity was missing or invalid.")
    if "tool_input" not in event:
        raise ValueError("Hook tool input was missing.")
    return event


def observation(event, reason):
    # Core resolves the bound work item and episode. Hook ids are correlation
    # only and never become the D8 effect identity or an authority claim.
    encoded = json.dumps(event["tool_input"], sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return {
        "schema": "helm.executor.codex.observation.v1",
        "client": "codex",
        "coverage": "observed-only",
        "hook_event_name": "PreToolUse",
        "session_id": event["session_id"],
        "turn_id": event["turn_id"],
        "tool_use_id": event["tool_use_id"],
        "tool_name": event["tool_name"],
        "tool_input_sha256": hashlib.sha256(encoded).hexdigest(),
        "local_policy": "deny" if reason else "observe",
        "reason": reason,
    }


def send_observation(argv, payload):
    if not argv:
        return "not-configured"
    if not isinstance(argv, list) or not argv or any(not isinstance(x, str) or not x for x in argv) or not Path(argv[0]).is_absolute():
        return "failed"
    try:
        result = subprocess.run(argv, input=json.dumps(payload).encode(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return "failed"
    return "submitted" if result.returncode == 0 else "failed"


def response(reason, delivery):
    output = {"hookEventName": "PreToolUse"}
    if reason:
        output.update(permissionDecision="deny", permissionDecisionReason=reason)
    if delivery != "submitted":
        output["additionalContext"] = "HELM hook observation was not submitted. This local hook provides observed-only coverage."
    return {"hookSpecificOutput": output}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--observer-argv", help="Approved core observer argv as JSON; receives metadata JSON on stdin")
    args = parser.parse_args()
    try:
        argv = json.loads(args.observer_argv) if args.observer_argv else None
        event = parse_event(sys.stdin.buffer.read(MAX_INPUT_BYTES + 1))
        reason = tool_deny(event)
        delivery = send_observation(argv, observation(event, reason))
    except (ValueError, TypeError, UnicodeError, RecursionError):
        reason, delivery = "HELM local hook input could not be classified.", "failed"
    print(json.dumps(response(reason, delivery)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
