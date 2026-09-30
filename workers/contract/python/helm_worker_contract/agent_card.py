"""Render the worker AgentCard (with the required episode extension) from the shared template."""

from __future__ import annotations

import copy
import json
from collections.abc import Mapping, Sequence
from importlib import resources
from typing import Any


def _template() -> dict[str, Any]:
    text = (
        resources.files("helm_worker_contract")
        .joinpath("schema/agent-card.template.json")
        .read_text(encoding="utf-8")
    )
    template: dict[str, Any] = json.loads(text)
    return template


def _fill(node: Any, values: Mapping[str, Any]) -> Any:
    if isinstance(node, dict):
        return {key: _fill(value, values) for key, value in node.items()}
    if isinstance(node, list):
        return [_fill(item, values) for item in node]
    if isinstance(node, str) and "{{" in node:
        for key, value in values.items():
            token = "{{" + key + "}}"
            if node == token:
                return copy.deepcopy(value)
            node = node.replace(token, str(value))
        if "{{" in node:
            raise ValueError(f"unfilled placeholder in AgentCard template: {node!r}")
    return node


def render_agent_card(
    *, framework: str, url: str, version: str, model_apis: Sequence[str]
) -> dict[str, Any]:
    """The AgentCard JSON (A2A v1.0 wire form) for a worker of `framework` served at `url`."""
    values: dict[str, Any] = {
        "name": f"HELM worker ({framework})",
        "description": f"Runs HELM episodes with {framework}. Model APIs: {', '.join(model_apis)}.",
        "version": version,
        "url": url,
        "model_apis": list(model_apis),
    }
    card: dict[str, Any] = _fill(_template(), values)
    return card
