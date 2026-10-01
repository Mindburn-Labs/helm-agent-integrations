"""Private IPC to the native OpenClaw Agent; shared runtime owns A2A and outcomes."""

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
    source = Path(os.environ.get("HELM_OPENCLAW_ENGINE", "/worker/openclaw/engine.mjs"))
    system, user = build_prompts(episode)
    with tempfile.TemporaryDirectory(prefix="helm-openclaw-") as home:
        env = {"PATH": os.environ.get("PATH", ""), "HOME": home, "TMPDIR": home}
        for key in ("SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"):
            if value := os.environ.get(key):
                env[key] = value
        process = await asyncio.create_subprocess_exec(
            "node",
            str(source),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True,
            env=env,
            limit=1024 * 1024,
        )
        try:
            assert process.stdin and process.stdout
            process.stdin.write(
                json.dumps(
                    {
                        "api": episode.model.api,
                        "model": episode.model.model,
                        "base_url": episode.model.base_url,
                        "max_output_tokens": episode.model.max_output_tokens,
                        "mcp_url": episode.tools.mcp_url,
                        "allowed": list(episode.tools.allowed),
                        "token": session.token,
                        "system": system,
                        "user": user,
                        "deadline_ms": episode.deadline.timestamp() * 1000,
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
                    session.observe(
                        event["name"],
                        event["arguments"],
                        ToolResult(
                            event.get("is_error", False),
                            event.get("structured"),
                            event.get("text"),
                        ),
                    )
                elif event["type"] == "progress":
                    session.progress(f"Calling {event['name']}.")
                elif event["type"] == "text":
                    session.last_text = str(event.get("text") or "")
                else:
                    raise RuntimeError("OpenClaw episode failed")
            if await process.wait() != 0:
                raise RuntimeError("OpenClaw episode failed")
        finally:
            # Cancellation/deadline belongs to this episode's entire process
            # group. No ambient provider keys or OpenClaw home are inherited.
            if process.returncode is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    await asyncio.wait_for(process.wait(), 1)
                except asyncio.TimeoutError:
                    os.killpg(process.pid, signal.SIGKILL)
                    await process.wait()
