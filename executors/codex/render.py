"""Render reviewable files in a new directory; never install client policy."""

import argparse
import json
from pathlib import Path
import re
import shlex
import sys
import tomllib
from urllib.parse import urlsplit

TEMPLATES = Path(__file__).parent / "templates"


def absolute_path(value):
    path = Path(value)
    if not path.is_absolute() or any(char in value for char in ("\x00", "\n", "\r")):
        raise ValueError("Managed paths must be absolute without control characters.")
    return str(path)


def substitutions(edge, adapter, executor, python, observer_argv=None):
    parsed = urlsplit(edge)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ValueError("Executor edge must be a credential-free HTTPS origin.")
    if parsed.hostname.endswith(".invalid") or not re.fullmatch(r"[A-Za-z0-9.-]+", parsed.hostname):
        raise ValueError("Provide the controller-approved executor edge hostname.")
    if parsed.port not in (None, 443):
        raise ValueError("The public executor edge must use TLS port 443.")
    adapter, executor, python = map(absolute_path, (adapter, executor, python))
    hook = [python, str(Path(adapter) / "pre_tool_use.py")]
    if observer_argv is not None:
        if not isinstance(observer_argv, list) or not observer_argv or any(not isinstance(x, str) or not x for x in observer_argv):
            raise ValueError("Observer argv must be a nonempty JSON string array.")
        absolute_path(observer_argv[0])
        hook.extend(("--observer-argv", json.dumps(observer_argv)))
    edge = edge.rstrip("/")
    values = {
        "RESPONSES_URL": edge + "/v1",
        "MCP_URL": edge + "/mcp",
        "EXECUTOR": executor,
        "ADAPTER": adapter,
        "EDGE_HOST": parsed.hostname,
        "HEADERS_COMMAND": shlex.join([python, str(Path(adapter) / "mcp_headers.py"), "--executor", executor]),
        "HOOK_COMMAND": shlex.join(hook),
    }
    return {"@@" + key + "@@": json.dumps(value) for key, value in values.items()}


def rendered_files(values):
    result = {}
    for name in ("config.toml", "requirements.toml"):
        content = (TEMPLATES / name).read_text()
        for marker, value in values.items():
            content = content.replace(marker, value)
        if re.search(r"@@[A-Z_]+@@", content):
            raise ValueError("Unresolved template marker.")
        tomllib.loads(content)
        result[name] = content
    result["helm.rules"] = (TEMPLATES / "helm.rules").read_text()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--edge", required=True)
    parser.add_argument("--adapter", required=True, help="Absolute admin-managed installed Codex adapter directory")
    parser.add_argument("--executor", required=True, help="Absolute installed executors/core helm-executor")
    parser.add_argument("--python", default=sys.executable, help="Absolute Python 3.11+ interpreter path")
    parser.add_argument("--observer-argv", help="Controller-approved core observer argv as JSON")
    parser.add_argument("--output", type=Path, required=True, help="New review directory; must not be a live Codex config path")
    args = parser.parse_args()
    try:
        argv = json.loads(args.observer_argv) if args.observer_argv else None
        content = rendered_files(substitutions(args.edge, args.adapter, args.executor, args.python, argv))
        destination = args.output.resolve()
        if ".codex" in destination.parts or destination == Path("/etc/codex") or Path("/etc/codex") in destination.parents:
            raise ValueError("Rendering to a live Codex config directory is disabled.")
        destination.mkdir(parents=True, exist_ok=False)
        for name, data in content.items():
            (destination / name).write_text(data)
    except (ValueError, OSError) as error:
        parser.exit(1, str(error) + "\n")
    print("Rendered review files only. No settings were installed.")
    if argv is None:
        print("Core observation sink is not configured; QA observation conformance remains pending.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
