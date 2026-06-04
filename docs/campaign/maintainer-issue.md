# Maintainer Issue Template

Title:

```text
Optional HELM AI Kernel example for fail-closed tool execution + receipts
```

Body:

```markdown
I built an optional HELM AI Kernel integration example for {{PROJECT}}.

It does not change {{PROJECT}} defaults.

What it adds:

- fail-closed preflight for side-effectful tools
- MCP/tool quarantine support where applicable
- ALLOW / DENY / ESCALATE verdict handling
- receipt metadata for governed calls
- sample EvidencePack verification artifacts

Demo:
{{DEMO_LINK}}

Adapter:
{{ADAPTER_LINK}}

Would you be open to adding this under examples/security or integrations?
If not, I can maintain it externally.
```

Rules:

- Keep the issue technical and reproducible.
- Do not imply official partnership or certification.
- Do not attack the upstream project.
- Offer to maintain the adapter externally.
