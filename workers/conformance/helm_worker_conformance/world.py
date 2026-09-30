"""State shared by the stubs and the checks for one scenario."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class McpCall:
    t_start: float
    tool: str
    arguments: dict[str, Any]
    t_end: float | None = None
    result: dict[str, Any] | None = None
    aborted: bool = False  # the worker closed the connection before the tool answered


@dataclass
class ModelCall:
    t: float
    path: str
    dialect: str  # anthropic | responses | chat | other
    model: str | None = None
    tools: list[dict[str, Any]] = field(default_factory=list)  # [{"name": ..., "type": ...}]
    max_tokens: int | None = None
    stream: bool = False
    turn: int = 0  # assistant turns already in the conversation the worker sent
    step: str = ""  # what the script answered: text | tools | sleep | error | default
    aborted: bool = False  # the worker closed the connection before the answer was sent
    t_end: float | None = None
    has_mcp_servers: bool = False
    text: str = ""  # the request body, for the first request only


@dataclass
class World:
    """Everything one scenario's stubs script and record.

    All times are `time.monotonic()` seconds, comparable across the stubs and the A2A client.
    """

    token: str
    script: list[dict[str, Any]] = field(default_factory=list)
    mcp_structured: bool = True
    mcp_calls: list[McpCall] = field(default_factory=list)
    mcp_methods: list[tuple[float, str]] = field(default_factory=list)
    model_calls: list[ModelCall] = field(default_factory=list)
    violations: list[str] = field(default_factory=list)
    stop: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)
    _counters: dict[str, int] = field(default_factory=dict)

    def violation(self, text: str) -> None:
        with self.lock:
            self.violations.append(text)

    def next_id(self, prefix: str) -> int:
        with self.lock:
            self._counters[prefix] = self._counters.get(prefix, 0) + 1
            return self._counters[prefix]

    def record_mcp(self, call: McpCall) -> None:
        with self.lock:
            self.mcp_calls.append(call)

    def record_model(self, call: ModelCall) -> None:
        with self.lock:
            self.model_calls.append(call)

    def sleep(self, seconds: float, is_gone: Any = None) -> bool:
        """Sleep up to `seconds`; False when cut short by scenario end or a vanished client."""
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self.stop.is_set() or (is_gone is not None and is_gone()):
                return False
            time.sleep(0.05)
        return True
