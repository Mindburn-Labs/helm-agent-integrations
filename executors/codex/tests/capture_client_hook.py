"""QA-only second hook: retain its original stdin in the probe's private directory."""

import argparse
import hashlib
import json
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    directory = parser.parse_args().directory.resolve(strict=True)
    raw = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        return 1
    event = json.loads(raw)
    if event.get("hook_event_name") not in ("PreToolUse", "PostToolUse"):
        return 1
    path = directory / (hashlib.sha256(raw).hexdigest() + ".json")
    try:
        with path.open("xb") as output:
            output.write(raw)
        path.chmod(0o600)
    except FileExistsError:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
