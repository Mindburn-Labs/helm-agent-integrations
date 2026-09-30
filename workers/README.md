# HELM agent workers

Container images that run one bounded HELM episode of an organization seat with an agent
framework. The control plane (the A2A client) starts an episode with `SendStreamingMessage`;
the worker is the A2A server inside the sandbox. Every side effect and every model call goes
through the HELM gateway named in the episode, so the worker holds no provider key and no
built-in tools.

This is HELM-compatible example code, in the same spirit as the rest of this repository: the
gateway, the verdicts and the receipts are owned by `helm-ai-kernel`, and the control plane that
starts episodes lives in its own repository.

| Path | What |
| --- | --- |
| [`contract/`](contract/README.md) | The `helm.episode.v1` schema, TypeScript and Python types, the outcome rules and the AgentCard template with the required extension. |
| [`conformance/`](conformance/README.md) | The black-box kit every image must pass: stub control plane, HELM MCP server and model endpoints on an isolated Docker network. |
| [`runtime/`](runtime/README.md) | Shared A2A v1 transport, task stream/reconnect and bounded cancellation. |
| [`claude-agent-sdk/`](claude-agent-sdk/README.md) | Claude Agent SDK with Anthropic Messages and HELM MCP tools. |
| [`openai-agents/`](openai-agents/README.md) | OpenAI Agents SDK with Responses and HELM MCP tools. |
| [`langgraph/`](langgraph/README.md) | LangGraph with Chat Completions or Anthropic Messages and HELM MCP tools. |

## Commands

```bash
make workers-check          # lint and unit tests, no Docker (part of `make check`)
make workers-conformance    # the kit in Docker mode (needs Docker; CI runs it after `make check`)
make workers-images         # build all three adapter images locally
```

To run the kit against one image, see [`conformance/README.md`](conformance/README.md).

Release tags `vMAJOR.MINOR.PATCH-workers.N` publish the three `helm-worker-*` images using
the shared platform release workflow. It builds amd64 and arm64, qualifies the pushed digest
with the worker kit, signs and attests it, then creates the immutable version tag. Deployed
workers must use the returned digest. Image publication and a live CP-driven QA episode are
separate verification steps.

## Environment every worker understands

| Variable | Meaning |
| --- | --- |
| `HELM_A2A_BEARER_TOKEN` | Secret the control plane presents to the JSON-RPC endpoint. The worker refuses to start without it. |
| `HELM_EPISODE_TOKEN` | Episode token for the model gateway and the MCP server (the episode names the variable). |
| `PORT` | Listen port, default 8080. |
| `HELM_A2A_PUBLIC_URL` | Interface URL for the AgentCard; by default built from the request's `Host` header. |
