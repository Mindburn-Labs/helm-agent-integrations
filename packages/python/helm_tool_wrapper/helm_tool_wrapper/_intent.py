"""Proposed tool actions and metadata shared by adapters and preflight."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional

TRUSTED_AGENT_RISK_CLASS = "T2"
TRUSTED_AGENT_EFFECT_CLASS = "E4"
UNTRUSTED_AUTHORITY_METADATA = frozenset(
    {
        "principal",
        "agent_id",
        "tenant_id",
        "risk_class",
        "riskClass",
        "effect_class",
        "effectClass",
    }
)


@dataclass(frozen=True)
class BoundaryIntent:
    action_urn: str
    input: Any
    session_id: Optional[str] = None
    principal: Optional[str] = None
    risk_class: Optional[str] = None
    effect_class: Optional[str] = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


def _record(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _without_authority_metadata(value: Any) -> Mapping[str, Any]:
    return {
        key: item for key, item in _record(value).items() if key not in UNTRUSTED_AUTHORITY_METADATA
    }
