# HELM Agent Integrations

Use these adapters and examples to check an agent’s proposed tool call with
[HELM AI Kernel](https://github.com/Mindburn-Labs/helm-ai-kernel) before dispatch.

## Quickstart

Run the TypeScript and Python wrapper examples from a clean checkout. The
commands below use Node.js 22 and Python 3.12.

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install ./packages/python/helm_tool_wrapper
npm ci --prefix packages/js/helm-tool-wrapper
make examples
```

The examples normalize fixture calls and send them to an in-process double
for `POST /api/v1/evaluate`. Each checks that a denied unknown-tool call
skips dispatch.

To get and verify receipts from a running local Kernel, follow the
[Kernel HTTP walkthrough](https://github.com/Mindburn-Labs/helm-ai-kernel/tree/main/examples/first-use).
Use the Kernel’s URL and tenant and principal bindings in the wrapper you choose.

## Choose an integration

| If you want to | Start here |
| --- | --- |
| Check a tool call from your own code | [TypeScript wrapper](packages/js/helm-tool-wrapper/README.md) or [Python wrapper](packages/python/helm_tool_wrapper/README.md) |
| Try a framework or inspect a receipt | [Framework examples](integrations/) and [routed-action demo](demos/routed-action-receipt/README.md) |
| Route calls through MCP or an OpenAI-compatible proxy | [MCP boundary demo](demos/mcp-boundary/README.md) or [proxy demo](demos/openai-proxy/README.md) |
| Connect an agent client to a HELM control plane | [Executor core](executors/core/README.md), [Claude Code](executors/claude-code/README.md), or [Codex](executors/codex/README.md) |
| Embed a coding engine over ACP | [ACP connector](packages/js/acp-connector/README.md) |
| Run an agent framework as a container worker | [Worker contract, adapters, and conformance kit](workers/README.md) |

Refer to the Kernel’s [HTTP API](https://github.com/Mindburn-Labs/helm-ai-kernel/blob/main/docs/reference/http-api.md)
and [verification guide](https://github.com/Mindburn-Labs/helm-ai-kernel/blob/main/docs/VERIFICATION.md)
for verdicts, receipt formats, and EvidencePack verification.

## Check changes

Run `make check` for builds, tests, package install checks, fixture checks,
and Markdown links. The required CI gate also runs `make workers-conformance`
against the worker images on an isolated Docker network.

Run `python3 scripts/generate_samples.py` to regenerate the checked-in
sample receipts and EvidencePacks. `make samples verify-samples` checks
byte-for-byte regeneration and sample integrity. These artifacts are demo fixtures.

For upstream example submissions, see the [maintainer issue template](docs/campaign/maintainer-issue.md)
and [pull request template](docs/campaign/maintainer-pr.md).
