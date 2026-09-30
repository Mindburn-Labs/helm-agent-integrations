"""helm.episode.status.v1 payloads and the A2A message parts that carry them."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from .constants import STATUS_MEDIA_TYPE, STATUS_SCHEMA


def status_payload(
    *,
    waiting_on: Mapping[str, Any] | None = None,
    error: tuple[str, str] | None = None,
    report: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a helm.episode.status.v1 document; `error` is (code, message)."""
    payload: dict[str, Any] = {"schema": STATUS_SCHEMA}
    if waiting_on:
        payload["waiting_on"] = dict(waiting_on)
    if error:
        payload["error"] = {"code": error[0], "message": error[1]}
    if report:
        payload["report"] = dict(report)
    return payload


def status_parts(text: str, payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The wire-format parts of a status message: a text summary and the data part."""
    return [
        {"text": text, "mediaType": "text/plain"},
        {"data": dict(payload), "mediaType": STATUS_MEDIA_TYPE},
    ]


def status_metadata(payload: Mapping[str, Any]) -> dict[str, Any]:
    """The event-metadata mirror of a status payload: every member except `schema`."""
    return {key: value for key, value in payload.items() if key != "schema"}


def find_status_payload(parts: Sequence[Mapping[str, Any]]) -> Any:
    """Return the status data part of a status message, or None."""
    for part in parts:
        if part.get("mediaType") == STATUS_MEDIA_TYPE and "data" in part:
            return part["data"]
    return None
