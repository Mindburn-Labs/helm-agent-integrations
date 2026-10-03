#!/usr/bin/env python3
"""Parent-run negative challenges of the existing outer confinement only."""
import errno
import json
import socket
import sys
from pathlib import Path
from urllib.parse import urlparse

private, outside, canary, loopback = sys.argv[1:]
result = {}


def denied(name, action):
    try:
        action()
    except OSError as error:
        result[name] = error.errno in (errno.EPERM, errno.EACCES)
        result[name + "_errno"] = error.errno
    else:
        result[name] = False


# All files are QA-owned canaries; no actual owner credential is opened.
Path(private, "confinement-write-canary").write_text("helm-private-write-canary")
result["private_write_allowed"] = True
denied("outside_write_denied", lambda: Path(outside, "must-not-exist").write_text("helm-negative-write"))
denied("canary_read_denied", lambda: Path(canary).read_bytes())
target = urlparse(loopback)
if target.hostname != "127.0.0.1" or target.scheme != "http" or target.port is None:
    raise ValueError("The positive connection must be the private loopback fake")
with socket.create_connection((target.hostname, target.port), timeout=0.5):
    result["loopback_allowed"] = True
# RFC 5737 documentation address: no provider or real effect endpoint.
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
    connection.settimeout(0.5)
    denied("non_loopback_denied", lambda: connection.connect(("192.0.2.1", 9)))
print(json.dumps(result))
sys.exit(0 if all(result.get(name) is True for name in ("private_write_allowed", "outside_write_denied", "canary_read_denied", "loopback_allowed", "non_loopback_denied")) else 1)
