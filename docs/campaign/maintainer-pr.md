# Maintainer PR Template

Title:

```text
examples: add optional HELM boundary for high-risk tool calls
```

Body:

```markdown
This PR adds an optional HELM AI Kernel example for {{PROJECT}}.

It does not change default behavior.

The example shows how users can route high-risk side effects through a local
HELM boundary before execution:

1. propose a tool call
2. submit a HELM preflight request
3. dispatch only on ALLOW
4. return decision and receipt metadata
5. verify the sample EvidencePack

Why this is useful:

- safer persistent or autonomous agents
- auditable side-effect execution
- optional MCP quarantine path
- receipt-bearing demos for security review

Validation:

```bash
{{VALIDATION_COMMAND}}
```
```

Rules:

- Example only.
- No core rewrite.
- No dependency added to upstream runtime unless maintainers ask for it.
- No endorsement language.
