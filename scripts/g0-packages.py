#!/usr/bin/env python3
"""Bind G0 npm tarball bytes to the independently verified qualification."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile

PATHS = {"executors/core", "executors/claude-code", "executors/codex", "plugins/openclaw"}
REPO = "Mindburn-Labs/helm-agent-integrations"
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


def validate(receipt, expected, revision, dry_run, sandbox):
    if (receipt.get("target") != "public-package-publish" or receipt.get("result") != "PASS"
            or receipt.get("dry_run") is not dry_run or not DIGEST.fullmatch(receipt.get("report_digest", ""))):
        raise ValueError("an independently verified publication receipt is required")
    if dry_run:
        if sandbox != "Mindburn-Labs/g0-publication-sandbox":
            raise ValueError("dry-run must name the controller's publication sandbox")
        return
    if receipt.get("qualification_kind") != "release":
        raise ValueError("canary evidence cannot publish")
    if expected.get("repositories", {}).get(REPO, {}).get("source_revision") != revision:
        raise ValueError("package source differs from the qualified source revision")
    digests = expected.get("npm_tarball_digests", {})
    if (not digests or receipt.get("npm_tarball_digests") != digests
            or any(not name.startswith("@mindburn/") or not DIGEST.fullmatch(value)
                   for name, value in digests.items())):
        raise ValueError("qualified adapter npm tarball digests are required")


def package_identity(path):
    with tarfile.open(path, "r:gz") as archive:
        members = [member for member in archive.getmembers() if member.name == "package/package.json"]
        if len(members) != 1 or not members[0].isfile() or members[0].size > 1048576:
            raise ValueError("npm tarball must contain one bounded regular package/package.json")
        stream = archive.extractfile(members[0])
        data = json.load(stream)
    if (data.get("private") is True or not isinstance(data.get("name"), str)
            or not data["name"].startswith("@mindburn/")
            or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", data.get("version", ""))):
        raise ValueError("a released public Mindburn package identity is required")
    return data["name"], data["version"]


def inspect_tarballs(directory, expected):
    files = sorted(directory.glob("*.tgz"))
    if not files or len(files) > 4:
        raise ValueError("one to four qualified tarballs are required")
    found = {}
    records = []
    for path in files:
        if path.is_symlink() or path.stat().st_size > 104857600:
            raise ValueError("symlink or oversized tarball refused")
        name, version = package_identity(path)
        digest = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
        if name in found or expected.get(name) != digest:
            raise ValueError("duplicate, unqualified or changed tarball refused")
        found[name] = digest
        records.append({"file": path.name, "name": name, "version": version, "digest": digest})
    if found != expected:
        raise ValueError("tarball set differs from the full qualified package set")
    return records


def prepare(root, paths, output, digests):
    if (not isinstance(paths, list) or not paths or len(paths) > 4 or len(set(paths)) != len(paths)
            or any(not isinstance(path, str) or path not in PATHS for path in paths)):
        raise ValueError("explicit G0 package source paths are required")
    for relative in paths:
        source = root / relative
        meta = json.loads((source / "package.json").read_text())
        if meta.get("private") is True or meta.get("name") not in digests:
            raise ValueError("private or unqualified package cannot enter publication")
        if not (source / "package-lock.json").is_file():
            raise ValueError("committed npm lockfile is required")
    output.mkdir(mode=0o700, exist_ok=False)
    for relative in paths:
        source = root / relative
        subprocess.run(["npm", "ci", "--ignore-scripts"], cwd=source, check=True)
        meta = json.loads((source / "package.json").read_text())
        if "build" in meta.get("scripts", {}):
            subprocess.run(["npm", "run", "build"], cwd=source, check=True)
        subprocess.run(["npm", "pack", "--ignore-scripts", "--pack-destination", str(output.resolve())],
                       cwd=source, check=True)
    return inspect_tarballs(output, digests)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["validate", "prepare", "inspect", "publish"])
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--expected-inputs", type=Path, required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--sandbox-repository", default="")
    parser.add_argument("--paths-json", default="[]")
    parser.add_argument("--directory", type=Path)
    args = parser.parse_args()
    receipt = json.loads(args.receipt.read_text())
    expected = json.loads(args.expected_inputs.read_text())
    validate(receipt, expected, args.source_revision, args.dry_run, args.sandbox_repository)
    if args.operation == "validate":
        print(json.dumps({"result": "PASS", "scope": "publication-barrier", "dry_run": args.dry_run}))
        return
    if args.dry_run or args.directory is None:
        raise ValueError("canaries never build or publish packages; a release tarball directory is required")
    digests = receipt["npm_tarball_digests"]
    records = (prepare(Path.cwd(), json.loads(args.paths_json), args.directory, digests)
               if args.operation == "prepare" else inspect_tarballs(args.directory, digests))
    if args.operation == "publish":
        if os.environ.get("GITHUB_REPOSITORY") != REPO or os.environ.get("GITHUB_REF") != "refs/heads/main":
            raise ValueError("public package publishing is restricted to the canonical main workflow")
        version = subprocess.check_output(["npm", "--version"], text=True).strip()
        parts = tuple(int(part) for part in version.split("."))
        if parts < (11, 5, 1):
            raise ValueError("npm trusted publishing requires CLI >=11.5.1")
        for record in records:
            subprocess.run(["npm", "publish", str(args.directory / record["file"]), "--ignore-scripts",
                            "--access", "public", "--provenance", "--registry=https://registry.npmjs.org"], check=True)
    print(json.dumps({"result": "PASS", "operation": args.operation, "packages": records}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.SubprocessError, tarfile.TarError) as error:
        print(json.dumps({"REFUSED": str(error)}))
        raise SystemExit(2)
