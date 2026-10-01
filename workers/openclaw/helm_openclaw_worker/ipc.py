"""Bounded private framing; only complete exact tool results become observations."""

import base64
import binascii
import hashlib
import json
import re
from uuid import UUID

MAX_LINE_BYTES = 512 * 1024
MAX_EPISODE_BYTES = 8 * 1024 * 1024
MAX_TOOL_EVENT_BYTES = 5 * 1024 * 1024
TOOL_CHUNK_BYTES = 360 * 1024
_FIELDS = {"type", "id", "index", "count", "size", "sha256", "data"}
_DIGEST = re.compile(r"[0-9a-f]{64}\Z")


class IPCDecoder:
    def __init__(self) -> None:
        self._total = 0
        self._header: tuple[str, int, int, str] | None = None
        self._next = 0
        self._data = bytearray()
        self._seen: set[str] = set()
        self._failed = False

    def decode(self, line: bytes) -> dict | None:
        if self._failed:
            raise ValueError("OpenClaw IPC already failed")
        try:
            return self._decode(line)
        except (ValueError, TypeError, UnicodeError, binascii.Error):
            self._failed = True
            self._data.clear()
            raise ValueError("Invalid bounded OpenClaw IPC") from None

    def _decode(self, line: bytes) -> dict | None:
        self._total += len(line)
        if len(line) > MAX_LINE_BYTES or self._total > MAX_EPISODE_BYTES:
            raise ValueError("IPC bound")
        event = json.loads(line)
        if not isinstance(event, dict):
            raise ValueError("IPC event")
        if event.get("type") != "tool_chunk":
            if self._header is not None:
                raise ValueError("Interleaved IPC event")
            return event
        if set(event) != _FIELDS:
            raise ValueError("Chunk fields")
        for key in ("index", "count", "size"):
            if type(event[key]) is not int:
                raise ValueError("Chunk integer")
        ident, digest = event["id"], event["sha256"]
        if not isinstance(ident, str) or str(UUID(ident)) != ident:
            raise ValueError("Chunk identity")
        if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
            raise ValueError("Chunk digest")
        size, count, index = event["size"], event["count"], event["index"]
        if not MAX_LINE_BYTES <= size <= MAX_TOOL_EVENT_BYTES:
            raise ValueError("Tool event bound")
        if count != (size + TOOL_CHUNK_BYTES - 1) // TOOL_CHUNK_BYTES:
            raise ValueError("Chunk count")
        if index < 0 or index >= count or not isinstance(event["data"], str):
            raise ValueError("Chunk index")
        header = (ident, count, size, digest)
        if self._header is None:
            if index != 0 or ident in self._seen:
                raise ValueError("Chunk replay")
            self._header = header
            self._seen.add(ident)
            self._next = 0
        if header != self._header or index != self._next:
            raise ValueError("Chunk order")
        chunk = base64.b64decode(event["data"], validate=True)
        expected = min(TOOL_CHUNK_BYTES, size - index * TOOL_CHUNK_BYTES)
        if len(chunk) != expected or len(self._data) + len(chunk) > size:
            raise ValueError("Chunk size")
        self._data.extend(chunk)
        self._next += 1
        if self._next < count:
            return None
        if len(self._data) != size or hashlib.sha256(self._data).hexdigest() != digest:
            raise ValueError("Chunk readback")
        result = json.loads(self._data.decode("utf-8"))
        if not isinstance(result, dict) or result.get("type") != "tool":
            raise ValueError("Reassembled event type")
        self._header = None
        self._data.clear()
        return result

    def finish(self) -> None:
        if self._failed or self._header is not None:
            self._failed = True
            self._data.clear()
            raise ValueError("Incomplete OpenClaw tool observation")
