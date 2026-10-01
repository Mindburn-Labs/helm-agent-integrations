"""Actual retained-task control capabilities of the current worker adapters.

This declaration cannot grant authority or stand in for a control implementation.
The current adapters have no steering/checkpoint channel; Cancel remains terminal.
"""

from __future__ import annotations

import json
from importlib import resources
from typing import Any

CONTROL_EXTENSION_URI = "urn:helm:a2a:episode-control:v1"
STEER = "helm/episode.steer"
PAUSE = "helm/episode.pause"
RESUME = "helm/episode.resume"


def control_capabilities(framework: str) -> dict[str, Any]:
    """A fresh copy of the source-owned capability declaration, never model input."""
    profile = json.loads(
        resources.files("helm_worker_contract")
        .joinpath("schema/episode-control.profile.json")
        .read_text(encoding="utf-8")
    )
    reason = profile["unsupported"].get(framework, profile["default_reason"])
    return {
        "schema": profile["schema"],
        "verbs": {verb: {"supported": False, "reason": reason} for verb in profile["verbs"]},
    }
