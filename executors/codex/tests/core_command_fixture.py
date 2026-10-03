"""Command-boundary fixture: no credentials, auth, CP, gateway or network."""

import json
import os
from pathlib import Path
import sys


def main():
    args = sys.argv[1:]
    if args == ["headers"]:
        print(json.dumps({"Authorization": "Bearer fixture", "Future-Header": "fixture-value"}))
        return 0
    if args in (
        ["observe", "--client", "codex", "--event", "PreToolUse"],
        ["observe", "--client", "codex", "--event", "PostToolUse"],
    ):
        Path(os.environ["CODEX_CORE_FIXTURE_CAPTURE"]).write_bytes(sys.stdin.buffer.read())
        if os.environ.get("CODEX_CORE_FIXTURE_FAILURE"):
            print("helm-executor: unavailable: fixture failure", file=sys.stderr)
        return 0
    print("Unsupported command-boundary fixture invocation", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
