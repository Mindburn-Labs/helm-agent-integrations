"""The vendor Runner owns the loop; HELM MCP results decide when it stops."""

import asyncio
from typing import Any

from agents import Agent, ModelSettings, RunConfig, Runner, set_tracing_disabled
from agents.agent import ToolsToFinalOutputResult
from agents.mcp import MCPServerStreamableHttp, create_static_tool_filter
from agents.models.openai_responses import OpenAIResponsesModel
from helm_worker_contract import ToolResult, build_prompts
from helm_worker_runtime import Session
from mcp.types import CallToolResult, TextContent
from openai import AsyncOpenAI


async def run(session: Session) -> None:
    episode = session.episode
    set_tracing_disabled(True)
    tool_lock = asyncio.Lock()

    class GatewayMCP(MCPServerStreamableHttp):
        async def call_tool(
            self,
            tool_name: str,
            arguments: dict[str, Any] | None,
            meta: dict[str, Any] | None = None,
        ) -> Any:
            # A model can return a tool batch despite parallel_tool_calls=False. The SDK
            # schedules those calls concurrently, so serialize at the actual MCP boundary.
            async with tool_lock:
                session.guard()
                if tool_name not in episode.tools.allowed:
                    raise ValueError("Tool is not allowed")
                if session.tracker.stopped:
                    return CallToolResult(
                        isError=True,
                        content=[
                            TextContent(type="text", text="HELM episode has stopped.")
                        ],
                    )
                session.progress(f"Calling {tool_name}.")
                result = await super().call_tool(tool_name, arguments, meta)
                text = "\n".join(c.text for c in result.content if c.type == "text")
                session.observe(
                    tool_name,
                    arguments or {},
                    ToolResult(result.isError or False, result.structuredContent, text),
                )
                return result

    async def finish(_context: Any, _results: Any) -> ToolsToFinalOutputResult:
        return ToolsToFinalOutputResult(
            session.tracker.stopped, "HELM episode parked or reported."
        )

    async with (
        AsyncOpenAI(
            api_key=session.token,
            base_url=episode.model.base_url + "/v1",
            max_retries=0,
            timeout=60,
        ) as client,
        GatewayMCP(
            name="helm",
            params={
                "url": episode.tools.mcp_url,
                "headers": {"Authorization": f"Bearer {session.token}"},
                "timeout": 60,
                "sse_read_timeout": 60,
            },
            cache_tools_list=True,
            client_session_timeout_seconds=60,
            tool_filter=create_static_tool_filter(
                allowed_tool_names=list(episode.tools.allowed)
            ),
            max_retry_attempts=0,
        ) as mcp,
    ):
        system, user = build_prompts(episode)
        agent = Agent(
            name=episode.seat.key,
            instructions=system,
            tools=[],
            mcp_servers=[mcp],
            model=OpenAIResponsesModel(episode.model.model, client),
            model_settings=ModelSettings(
                max_tokens=episode.model.max_output_tokens,
                parallel_tool_calls=False,
                store=False,
            ),
            tool_use_behavior=finish,
        )
        result = Runner.run_streamed(
            agent, user, max_turns=20, run_config=RunConfig(tracing_disabled=True)
        )
        try:
            async for event in result.stream_events():
                session.guard()
                if event.type == "run_item_stream_event":
                    session.progress()
            session.last_text = str(result.final_output or "")
        finally:
            result.cancel(mode="immediate")
