"""An explicit LangGraph with allow-listed MCP tools and an interrupt on HELM parking."""

import os
from typing import Any

from helm_worker_contract import ToolResult, build_prompts
from helm_worker_runtime import Session
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.types import interrupt


async def run(session: Session) -> None:
    episode = session.episode
    os.environ["LANGSMITH_TRACING"] = "false"
    os.environ["LANGCHAIN_TRACING_V2"] = "false"

    async def observe(request: Any, handler: Any) -> Any:
        session.guard()
        if request.name not in episode.tools.allowed or session.tracker.stopped:
            raise ValueError("Tool is not allowed")
        session.progress(f"Calling {request.name}.")
        result = await handler(request)
        text = "\n".join(c.text for c in result.content if c.type == "text")
        session.observe(
            request.name,
            request.args,
            ToolResult(result.isError or False, result.structuredContent, text),
        )
        return result

    client = MultiServerMCPClient(
        {
            "helm": {
                "url": episode.tools.mcp_url,
                "transport": "streamable_http",
                "headers": {"Authorization": f"Bearer {session.token}"},
            }
        },
        tool_interceptors=[observe],
    )
    async with client.session("helm") as mcp:
        tools = await load_mcp_tools(
            mcp, tool_interceptors=[observe], server_name="helm"
        )
        allowed = {
            tool.name: tool for tool in tools if tool.name in episode.tools.allowed
        }
        if episode.model.api == "anthropic-messages":
            # Auth token is a gateway workload token, never a provider API key.
            model: Any = ChatAnthropic(
                model_name=episode.model.model,
                anthropic_api_url=episode.model.base_url,
                anthropic_api_key=session.token,
                default_headers={"Authorization": f"Bearer {session.token}"},
                max_tokens=episode.model.max_output_tokens,
                streaming=True,
                max_retries=0,
            )
        else:
            model = ChatOpenAI(
                model=episode.model.model,
                api_key=session.token,
                base_url=episode.model.base_url + "/v1",
                max_tokens=episode.model.max_output_tokens,
                streaming=True,
                max_retries=0,
                use_responses_api=False,
            )
        model = model.bind_tools(list(allowed.values()), parallel_tool_calls=False)
        system, user = build_prompts(episode)

        async def agent(state: MessagesState) -> dict[str, Any]:
            session.guard()
            answer = await model.ainvoke(state["messages"])
            session.last_text = str(answer.content or "")
            session.progress()
            return {"messages": [answer]}

        async def tool_node(state: MessagesState) -> dict[str, Any]:
            replies = []
            for call in state["messages"][-1].tool_calls:  # type: ignore[attr-defined]
                session.guard()
                tool = allowed.get(call["name"])
                if tool is None:
                    replies.append(
                        ToolMessage(
                            content="Tool is not allowed.", tool_call_id=call["id"]
                        )
                    )
                    continue
                replies.append(await tool.ainvoke({**call, "type": "tool_call"}))
                if session.tracker.stopped:
                    if session.tracker.report is None:
                        interrupt(session.tracker.outcome().status)
                    break
            return {"messages": replies}

        graph = StateGraph(MessagesState)
        graph.add_node("agent", agent)
        graph.add_node("tools", tool_node)
        graph.add_edge(START, "agent")
        graph.add_conditional_edges(
            "agent", lambda state: "tools" if state["messages"][-1].tool_calls else END
        )  # type: ignore[attr-defined]
        graph.add_conditional_edges(
            "tools", lambda _state: END if session.tracker.stopped else "agent"
        )
        compiled = graph.compile(checkpointer=InMemorySaver())
        async for _ in compiled.astream(
            {"messages": [SystemMessage(system), HumanMessage(user)]},
            {"configurable": {"thread_id": episode.episode_id}, "recursion_limit": 40},
        ):
            session.guard()
