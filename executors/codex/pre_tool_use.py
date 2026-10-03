"""Synchronous local deny hook. Shared core owns separate observations."""

import json
import sys

from policy import tool_deny

MAX_INPUT_BYTES = 8 * 1024 * 1024


def parse_event(raw):
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError("Hook input exceeded the local limit.")
    def reject_constant(_value):
        raise ValueError("Hook input must be JSON.")

    event = json.loads(raw, parse_constant=reject_constant)
    if not isinstance(event, dict) or event.get("hook_event_name") != "PreToolUse":
        raise ValueError("Invalid PreToolUse event.")
    for key in ("session_id", "tool_name"):
        value = event.get(key)
        if not isinstance(value, str) or not value or len(value) > 256:
            raise ValueError("Hook event identity was missing or invalid.")
    return event


def response(reason):
    output = {"hookEventName": "PreToolUse"}
    if reason:
        output.update(permissionDecision="deny", permissionDecisionReason=reason)
    return {"hookSpecificOutput": output}


def main():
    try:
        event = parse_event(sys.stdin.buffer.read(MAX_INPUT_BYTES + 1))
        reason = tool_deny(event)
    except (ValueError, TypeError, UnicodeError, RecursionError):
        reason = "HELM local hook input could not be classified."
    print(json.dumps(response(reason)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
