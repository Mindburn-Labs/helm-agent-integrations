"""Translate shared core token stdout to Codex's HTTP header helper shape."""

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

BEARER = re.compile(r"[A-Za-z0-9._~+/-]+=*", re.ASCII)
MAX_TOKEN_BYTES = 16384


class TokenUnavailable(Exception):
    pass


def authorization_headers(executor):
    if not Path(executor).is_absolute():
        raise TokenUnavailable()
    try:
        result = subprocess.run([executor, "token"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise TokenUnavailable() from None
    if result.returncode != 0 or len(result.stdout) > MAX_TOKEN_BYTES:
        raise TokenUnavailable()
    try:
        token = result.stdout.decode("ascii").rstrip("\r\n")
    except UnicodeError:
        raise TokenUnavailable() from None
    if not token or not BEARER.fullmatch(token):
        raise TokenUnavailable()
    return {"Authorization": "Bearer " + token}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--executor", required=True, help="Absolute installed path to executors/core helm-executor")
    args = parser.parse_args()
    try:
        headers = authorization_headers(args.executor)
    except TokenUnavailable:
        print("HELM episode token unavailable.", file=sys.stderr)
        return 1
    print(json.dumps(headers))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
