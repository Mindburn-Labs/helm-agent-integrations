# OpenAI Agents SDK worker

Runs the pinned Python Agents SDK with `Runner.run_streamed`, `OpenAIResponsesModel` and the
episode's Responses gateway. `MCPServerStreamableHttp` forwards the episode bearer and filters
the catalog to its allowed tools. The custom `tool_use_behavior` ends the vendor loop after a
parking result or an applied report; another tool cannot start after that result.

Tracing, provider retries, hosted tools and parallel tool calls are disabled. The SDK's
stream and HTTP clients are canceled when the A2A task is canceled or its deadline passes.

Build from repository root with `docker build -f workers/openai-agents/Dockerfile workers`.
Start the image with `HELM_A2A_BEARER_TOKEN` and `HELM_EPISODE_TOKEN`; see [the protocol](../contract/README.md).

SDK reference: [local MCP tools and filtering](https://openai.github.io/openai-agents-python/mcp/).
