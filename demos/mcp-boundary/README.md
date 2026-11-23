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

From the root of a `helm-ai-kernel` checkout, run the maintained MCP demo.

```bash
make demo-mcp
```

The maintained kernel demo asserts that unknown servers, unknown tools, and
missing schema pins return `DENY` or `ESCALATE` before dispatch.

From the same checkout, generate the receipt-backed proof pack.

```bash
./bin/helm-ai-kernel mcp proof \
  --scenario all \
  --out /tmp/helm-mcp-proof \
  --run-id public-mcp-proof \
  --json
```

The sanitized transcript checked in beside this README is
`mcp-proof-transcript.json`. It records only public proof fields: scenario id,
verdict, reason, dispatch state, receipt reference, and offline verifier
summary.

## Integration Scenario

Return to the root of the `helm-agent-integrations` checkout to generate and
verify the integration fixtures.

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
