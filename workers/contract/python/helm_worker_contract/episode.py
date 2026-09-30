"""The helm.episode.v1 payload: parsing, validation and the prompts derived from it."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .constants import EPISODE_MEDIA_TYPE
from .schemas import schema_issues


class EpisodeError(Exception):
    """The episode cannot be run. `code` is a helm.episode.status.v1 error code."""

    def __init__(self, code: str, message: str, issues: Sequence[str] = ()) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.issues = tuple(issues)


@dataclass(frozen=True, slots=True)
class Seat:
    id: str
    key: str
    principal_id: str
    instructions: str
    role: str = ""
    team: str = ""


@dataclass(frozen=True, slots=True)
class Tools:
    mcp_url: str
    allowed: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class Model:
    base_url: str
    api: str
    model: str
    max_output_tokens: int


@dataclass(frozen=True, slots=True)
class Episode:
    episode_id: str
    work_item_id: str
    seat: Seat
    goal: str
    tools: Tools
    model: Model
    credentials_env: str
    deadline: datetime
    continuation: int = 0
    organization_id: str = ""
    organization_version_id: str = ""
    context: Mapping[str, Any] = field(default_factory=dict)
    acceptance: Mapping[str, Any] = field(default_factory=dict)
    budget: Mapping[str, Any] = field(default_factory=dict)

    def seconds_left(self, now: datetime | None = None) -> float:
        return (self.deadline - (now or datetime.now(timezone.utc))).total_seconds()


_RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$")
_FRACTION = re.compile(r"\.(\d+)")


def parse_rfc3339(value: str) -> datetime:
    """Parse an RFC 3339 instant into an aware UTC datetime (ValueError when malformed)."""
    text = value.strip()
    if not _RFC3339.match(text):
        raise ValueError(f"not an RFC 3339 date-time with a UTC offset: {value!r}")
    text = text[:-1] + "+00:00" if text.endswith(("Z", "z")) else text
    # datetime.fromisoformat before 3.11 accepts only 3 or 6 fractional digits.
    text = _FRACTION.sub(lambda m: "." + m.group(1)[:6].ljust(6, "0"), text, count=1)
    return datetime.fromisoformat(text).astimezone(timezone.utc)


def parse_episode(value: object) -> Episode:
    """Validate `value` against helm.episode.v1 and return the typed episode.

    Raises EpisodeError(INVALID_EPISODE) when it does not conform.
    """
    issues = schema_issues("episode.v1", value)
    if issues:
        raise EpisodeError("INVALID_EPISODE", "episode does not match helm.episode.v1", issues)
    assert isinstance(value, dict)
    try:
        deadline = parse_rfc3339(value["deadline"])
    except ValueError as exc:
        raise EpisodeError(
            "INVALID_EPISODE", "episode deadline is not an RFC 3339 instant", [str(exc)]
        ) from exc
    seat = value["seat"]
    tools = value["tools"]
    model = value["model"]
    organization = value.get("organization", {})
    return Episode(
        episode_id=value["episode_id"],
        work_item_id=value["work_item_id"],
        continuation=value.get("continuation", 0),
        organization_id=organization.get("id", ""),
        organization_version_id=organization.get("version_id", ""),
        seat=Seat(
            id=seat["id"],
            key=seat["key"],
            principal_id=seat["principal_id"],
            instructions=seat["instructions"],
            role=seat.get("role", ""),
            team=seat.get("team", ""),
        ),
        goal=value["goal"],
        context=value.get("context", {}),
        acceptance=value.get("acceptance", {}),
        tools=Tools(mcp_url=tools["mcp_url"], allowed=tuple(tools["allowed"])),
        model=Model(
            base_url=model["base_url"].rstrip("/"),
            api=model["api"],
            model=model["model"],
            max_output_tokens=model["max_output_tokens"],
        ),
        budget=value.get("budget", {}),
        deadline=deadline,
        credentials_env=value["credentials"]["env"],
    )


def find_episode_part(parts: Sequence[Mapping[str, Any]]) -> Any:
    """Return the JSON of the episode data part of an A2A message, or None when absent."""
    for part in parts:
        if part.get("mediaType") == EPISODE_MEDIA_TYPE and "data" in part:
            return part["data"]
    return None


def episode_from_message(message: Mapping[str, Any]) -> Episode:
    """Extract and parse the episode from a wire-format A2A message (a dict with `parts`)."""
    raw = find_episode_part(message.get("parts", []))
    if raw is None:
        raise EpisodeError(
            "INVALID_EPISODE",
            f"message has no {EPISODE_MEDIA_TYPE} data part",
        )
    return parse_episode(raw)


def require_supported_api(episode: Episode, supported: Sequence[str]) -> None:
    """Raise EpisodeError(UNSUPPORTED_MODEL_API) unless the adapter can speak episode.model.api."""
    if episode.model.api not in supported:
        raise EpisodeError(
            "UNSUPPORTED_MODEL_API",
            f"this worker supports {', '.join(supported)}; the episode asks for {episode.model.api}",
        )


def build_prompts(episode: Episode) -> tuple[str, str]:
    """The system prompt and first user message every adapter gives its model."""
    who = f'seat "{episode.seat.key}"'
    if episode.seat.role:
        who += f" ({episode.seat.role}"
        who += f", team {episode.seat.team})" if episode.seat.team else ")"
    system = "\n".join(
        [
            f"You are the agent for {who} in a HELM organization.",
            "",
            episode.seat.instructions.strip(),
            "",
            "Rules:",
            "- You act only through the tools provided. They are the only way to read or change anything.",
            '- Every tool call is a proposal to the HELM gateway. When a tool returns status "escalated", '
            "a human must decide first: stop, and do not retry, work around it, or call other tools.",
            "- When your work is finished, or you cannot continue, call helm_work_report exactly once "
            "with status done, blocked or failed and a short summary. The episode is not complete until you do.",
            f"- Finish before {episode.deadline.strftime('%Y-%m-%dT%H:%M:%SZ')}.",
        ]
    ).strip()
    user_lines = ["Goal:", episode.goal.strip()]
    brief = str(episode.context.get("brief", "")).strip()
    if brief:
        user_lines += ["", "Brief:", brief]
    criteria = str(episode.acceptance.get("criteria", "")).strip()
    if criteria:
        user_lines += ["", "Acceptance criteria:", criteria]
    required = episode.acceptance.get("required_effects") or []
    if required:
        user_lines += ["", "Required effects: " + ", ".join(required)]
    for key, title in (
        ("prior_episodes", "Earlier episodes"),
        ("attempt_results", "Results of earlier attempts"),
        ("children", "Delegated work"),
    ):
        items = episode.context.get(key) or []
        if items:
            user_lines += [
                "",
                f"{title}:",
                json.dumps(items, sort_keys=True, separators=(",", ":"), ensure_ascii=False),
            ]
    return system, "\n".join(user_lines)


__all__ = [
    "Episode",
    "EpisodeError",
    "Model",
    "Seat",
    "Tools",
    "build_prompts",
    "episode_from_message",
    "find_episode_part",
    "parse_episode",
    "parse_rfc3339",
    "require_supported_api",
]
