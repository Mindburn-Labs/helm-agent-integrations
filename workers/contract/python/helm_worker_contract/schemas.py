"""Loader for the JSON Schemas shipped with this package.

`workers/contract/schema/` is canonical; `make workers-contract-check` fails when the copy in
this package drifts from it.
"""

from __future__ import annotations

import json
from functools import cache
from importlib import resources
from typing import Any

from jsonschema import Draft202012Validator


@cache
def load_schema(name: str) -> dict[str, Any]:
    """Return the parsed schema file `schema/<name>.schema.json`."""
    text = (
        resources.files("helm_worker_contract")
        .joinpath(f"schema/{name}.schema.json")
        .read_text(encoding="utf-8")
    )
    schema: dict[str, Any] = json.loads(text)
    return schema


@cache
def validator(name: str) -> Draft202012Validator:
    return Draft202012Validator(load_schema(name))


def schema_issues(name: str, value: object) -> list[str]:
    """Sorted, human-readable violations of the named schema (empty when valid)."""
    issues = []
    for error in validator(name).iter_errors(value):
        path = "/".join(str(part) for part in error.absolute_path) or "(root)"
        issues.append(f"{path}: {error.message}")
    return sorted(issues)
