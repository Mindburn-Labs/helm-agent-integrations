"""Exercise actual Node framing and Python observation admission, offline."""

import base64
import hashlib
import json
import subprocess
import unittest
from pathlib import Path
from uuid import uuid4

from helm_openclaw_worker.ipc import (
    IPCDecoder,
    MAX_EPISODE_BYTES,
    MAX_LINE_BYTES,
    MAX_TOOL_EVENT_BYTES,
)

WORKER = Path(__file__).resolve().parents[1]
NODE_EMITTER = """
import {boundedEmitter, MAX_TOOL_EVENT_BYTES, readBoundedJSON} from './boundary.mjs';
const input = await readBoundedJSON(process.stdin, MAX_TOOL_EVENT_BYTES);
boundedEmitter((line) => process.stdout.write(line))(input);
"""


def native_frames(event: dict) -> list[bytes]:
    result = subprocess.run(
        ["node", "--input-type=module", "-e", NODE_EMITTER],
        input=json.dumps(event, ensure_ascii=False).encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=WORKER,
        timeout=10,
        check=True,
    )
    return result.stdout.splitlines(keepends=True)


def replaced(line: bytes, **fields) -> bytes:
    event = json.loads(line)
    event.update(fields)
    return json.dumps(event, separators=(",", ":")).encode() + b"\n"


class IPCAdmissionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        structured = {"status": "applied", "artifact": {"payload": "🧭é" * 174600}}
        cls.event = {
            "type": "tool",
            "name": "helm_work_get",
            "arguments": {"work_id": str(uuid4())},
            "is_error": False,
            "structured": structured,
            "text": json.dumps(structured, ensure_ascii=False, indent=2),
        }
        cls.frames = native_frames(cls.event)

    def test_native_large_retained_result_is_observed_exactly_once_after_complete_readback(self):
        self.assertGreater(len(self.frames), 1)
        decoder = IPCDecoder()
        for frame in self.frames[:-1]:
            self.assertLessEqual(len(frame), MAX_LINE_BYTES)
            self.assertIsNone(decoder.decode(frame))
        self.assertEqual(decoder.decode(self.frames[-1]), self.event)
        decoder.finish()
        # Structured content and its original JSON text both survive; neither
        # status nor the opaque artifact shape is independently authoritative.
        self.assertEqual(json.loads(self.event["text"]), self.event["structured"])

    def test_small_native_event_preserves_existing_protocol(self):
        event = {"type": "progress", "name": "helm_work_get"}
        lines = native_frames(event)
        self.assertEqual(len(lines), 1)
        decoder = IPCDecoder()
        self.assertEqual(decoder.decode(lines[0]), event)
        decoder.finish()

    def test_incomplete_or_interleaved_result_never_becomes_a_tool_observation(self):
        decoder = IPCDecoder()
        self.assertIsNone(decoder.decode(self.frames[0]))
        with self.assertRaises(ValueError):
            decoder.finish()
        for interloper in (
            native_frames({"type": "text", "text": "apparent success"})[0],
            replaced(self.frames[1], id=str(uuid4())),
            self.frames[2],
            self.frames[0],
        ):
            with self.subTest(interloper_length=len(interloper)):
                decoder = IPCDecoder()
                self.assertIsNone(decoder.decode(self.frames[0]))
                with self.assertRaises(ValueError):
                    decoder.decode(interloper)
                with self.assertRaises(ValueError):
                    decoder.finish()

    def test_digest_corruption_and_replay_refuse_observation(self):
        decoder = IPCDecoder()
        first = json.loads(self.frames[0])
        digest = "0" * 64 if first["sha256"] != "0" * 64 else "1" * 64
        for frame in self.frames[:-1]:
            self.assertIsNone(decoder.decode(replaced(frame, sha256=digest)))
        with self.assertRaises(ValueError):
            decoder.decode(replaced(self.frames[-1], sha256=digest))
        decoder = IPCDecoder()
        for frame in self.frames:
            result = decoder.decode(frame)
        self.assertEqual(result, self.event)
        with self.assertRaises(ValueError):
            decoder.decode(self.frames[0])

    def test_untrusted_chunk_headers_data_and_raw_line_limits_fail_closed(self):
        invalid = [
            replaced(self.frames[0], size=MAX_TOOL_EVENT_BYTES + 1),
            replaced(self.frames[0], index=True),
            replaced(self.frames[0], count=10000),
            replaced(self.frames[0], id="foreign"),
            replaced(self.frames[0], data="not-base64!"),
            replaced(self.frames[0], data="eA=="),
            b" " * (MAX_LINE_BYTES + 1),
        ]
        for line in invalid:
            with self.subTest(line_length=len(line)):
                with self.assertRaises(ValueError):
                    IPCDecoder().decode(line)

    def test_declared_tool_frames_cannot_smuggle_a_different_event_type(self):
        # The emitter refuses chunking non-tool events. Alter a tool body to an
        # equal-length text type before the actual emitter hashes/frames it.
        event = {"type": "tool", "text": "x" * MAX_LINE_BYTES}
        frames = native_frames(event)
        raw = b"".join(base64.b64decode(json.loads(line)["data"]) for line in frames)
        raw = raw.replace(b'"type":"tool"', b'"type":"text"', 1)
        digest = hashlib.sha256(raw).hexdigest()
        offset = 0
        decoder = IPCDecoder()
        for frame in frames[:-1]:
            chunk = json.loads(frame)
            size = len(base64.b64decode(chunk["data"]))
            data = base64.b64encode(raw[offset : offset + size]).decode()
            offset += size
            self.assertIsNone(decoder.decode(replaced(frame, data=data, sha256=digest)))
        with self.assertRaises(ValueError):
            decoder.decode(
                replaced(frames[-1], data=base64.b64encode(raw[offset:]).decode(), sha256=digest)
            )

    def test_wire_episode_budget_is_enforced_even_for_small_events(self):
        event = {"type": "text", "text": "x" * (MAX_LINE_BYTES - 100)}
        line = native_frames(event)[0]
        decoder = IPCDecoder()
        for _ in range(MAX_EPISODE_BYTES // len(line)):
            self.assertEqual(decoder.decode(line), event)
        with self.assertRaises(ValueError):
            decoder.decode(line)


if __name__ == "__main__":
    unittest.main()
