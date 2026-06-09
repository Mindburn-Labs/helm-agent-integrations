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

For the receipt-backed competitive proof pack, run the kernel command:

```bash
./bin/helm-ai-kernel mcp proof \
  --scenario all \
  --out /tmp/helm-mcp-proof \
  --run-id public-mcp-proof \
  --at 2026-06-09T00:00:00Z \
  --json
```

The sanitized transcript checked in beside this README is
`mcp-proof-transcript.json`. It records only public proof fields: scenario id,
verdict, reason, dispatch state, receipt reference, and offline verifier
summary.

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
