# OpenAI Agents SDK + HELM

Use one of four integration paths:

1. OpenAI-compatible `base_url` proxy
2. direct tool wrapper
3. guardrail or human-review hook
4. MCP boundary

The lowest-friction path is the existing HELM proxy:

```text
base_url = http://127.0.0.1:9090/v1
```

HELM receipt metadata is available through `X-Helm-*` headers or receipt
tailing.
