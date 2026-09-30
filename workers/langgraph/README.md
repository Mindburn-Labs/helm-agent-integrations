# LangGraph worker

Runs a pinned Python LangGraph with `ChatOpenAI` in Chat Completions mode or `ChatAnthropic`
in Messages mode. `langchain-mcp-adapters` supplies only the episode's allowed tools and
forwards the bearer to the MCP gateway. A tool interceptor records HELM outcome mirrors;
`interrupt()` parks escalations, delegation and input requests without another model turn.

An applied report ends the graph. Tracing and retries are disabled. Graph state is held only
for the episode; the control plane provides continuation context in the next pod.

Build from repository root with `docker build -f workers/langgraph/Dockerfile workers`.
Start the image with `HELM_A2A_BEARER_TOKEN` and `HELM_EPISODE_TOKEN`; see [the protocol](../contract/README.md).

SDK reference: [MCP tools](https://docs.langchain.com/oss/python/langchain/mcp) and
[LangGraph interrupts](https://reference.langchain.com/python/langgraph/types/interrupt).
