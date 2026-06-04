# MCP Boundary Demo

This demo shows the universal HELM integration path for MCP tools:

```text
Agent / framework
  -> MCP client
  -> HELM MCP boundary
  -> MCP registry / authorization
  -> tool execution only after ALLOW
  -> receipt / EvidencePack
```

## Kernel Surface

Use the source-owned MCP surface from `helm-ai-kernel`:

```bash
cd ../../helm-ai-kernel
make build
./bin/helm-ai-kernel mcp serve
./scripts/launch/demo-mcp.sh
```

The maintained kernel demo asserts that unknown servers, unknown tools, and
missing schema pins return `DENY` or `ESCALATE` before dispatch.

## Integration Scenario

Generated sample:

```bash
python3 scripts/generate_samples.py
python3 scripts/verify_samples.py
cat receipts/samples/mcp-unknown-tool-quarantine.json
```

Expected result:

- unknown `gmail.send_email` MCP tool is quarantined
- HELM verdict is `ESCALATE`
- dispatch is false
- receipt and sample EvidencePack are generated
