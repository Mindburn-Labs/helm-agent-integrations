# HELM Container MCP Demo

This demo models `54rt1n/container-mcp`, a containerized MCP surface for file,
shell, code execution, and web operations. HELM is shown as the inner
execution boundary: container isolation is useful, but mutating code execution
still needs an exec policy.

This is an integration fixture, not HELM conformance or upstream
certification.

## Upstream

- Repository: https://github.com/54rt1n/container-mcp
- Pinned ref checked on 2026-06-11:
  `50acc5e1fae9c3d4ce0328f87f843ba37a3c9759`

## Scenario

| Intent | Expected verdict | Reason | Dispatch |
| --- | --- | --- | --- |
| `code_exec` attempts a mutating Python script | `DENY` | `CODE_EXEC_MUTATION_DENY` | `false` |

## Run

```bash
./demos/helm-container-mcp-demo/run.sh --safe
python3 scripts/verify_samples.py
```

If Podman is not installed, the safe harness reports `SKIP` for the optional
container smoke.
