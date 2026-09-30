# Claude Agent SDK worker

Runs the pinned TypeScript Claude Agent SDK with the episode's Anthropic Messages gateway.
All built-in tools are disabled; ungranted MCP tools are removed from the model context and
denied before invocation. `PostToolUse` feeds plain, content-only and structured MCP results
through the shared HELM outcome tracker and stops after parking or an applied report.

The SDK receives a fresh temporary home, empty setting sources, no provider API key, no
session persistence and disabled telemetry. The Python A2A transport supervises its process
group so cancellation closes an open tool/model call within ten seconds.

Build from repository root with `docker build -f workers/claude-agent-sdk/Dockerfile workers`.
Start the image with `HELM_A2A_BEARER_TOKEN` and `HELM_EPISODE_TOKEN`; see [the protocol](../contract/README.md).

SDK reference: [TypeScript options and hooks](https://platform.claude.com/docs/en/agent-sdk/typescript).
