"""A private pipe to the actual TS SDK; cancellation terminates its process group."""

import asyncio
import json
import os
import signal
import tempfile
from pathlib import Path

from helm_worker_contract import ToolResult, build_prompts
from helm_worker_runtime import Session


async def run(session: Session) -> None:
    episode = session.episode
    source = Path(
        os.environ.get("HELM_CLAUDE_ENGINE", "/worker/claude-agent-sdk/engine.mjs")
    )
    system, user = build_prompts(episode)
    with tempfile.TemporaryDirectory(prefix="helm-claude-") as home:
        process = await asyncio.create_subprocess_exec(
            "node",
            str(source),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True,
            env={"PATH": os.environ.get("PATH", ""), "HOME": home, "TMPDIR": home},
        )
        try:
            assert process.stdin and process.stdout
            process.stdin.write(
                json.dumps(
                    {
                        "model": episode.model.model,
                        "base_url": episode.model.base_url,
                        "max_output_tokens": episode.model.max_output_tokens,
                        "mcp_url": episode.tools.mcp_url,
                        "allowed": list(episode.tools.allowed),
                        "token": session.token,
                        "system": system,
                        "user": user,
                        "home": home,
                    }
                ).encode()
                + b"\n"
            )
            await process.stdin.drain()
            process.stdin.close()
            while line := await process.stdout.readline():
                session.guard()
                event = json.loads(line)
                if event["type"] == "tool":
                    session.progress(f"Calling {event['name']}.")
                    session.observe(
                        event["name"],
                        event["arguments"],
                        ToolResult(
                            event.get("is_error", False),
                            event.get("structured"),
                            event.get("text"),
                        ),
                    )
                elif event["type"] == "text":
                    session.last_text = str(event.get("text") or "")
                elif event["type"] == "error":
                    raise RuntimeError("Claude Agent SDK failed")
            if await process.wait() != 0:
                raise RuntimeError("Claude Agent SDK failed")
        finally:
            # The SDK runs Claude in a child process. Terminating only node leaves that model
            # or tool call alive; the whole task process group belongs to this episode.
            if process.returncode is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    await asyncio.wait_for(process.wait(), 1)
                except asyncio.TimeoutError:
                    os.killpg(process.pid, signal.SIGKILL)
                    await process.wait()
