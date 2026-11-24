# Maintainer PR Template

## Pull request title

```text
examples: add optional HELM boundary for high-risk tool calls
```

## Pull request body

````markdown
This PR adds an optional HELM AI Kernel example for {{PROJECT}}.

It does not change default behavior.

The example shows how users can route high-risk side effects through a local
HELM boundary before execution:

1. propose a tool call
2. submit a HELM preflight request
3. dispatch only on ALLOW
4. return decision and receipt metadata
5. verify the sample EvidencePack

The demo includes a refused or escalated call and shows how to inspect the
returned receipt metadata without dispatching that call.

Validation:

```bash
{{VALIDATION_COMMAND}}
```
````

## Submission checks

- Example only.
- No core rewrite.
- No dependency added to upstream runtime unless maintainers ask for it.
- No endorsement language.
