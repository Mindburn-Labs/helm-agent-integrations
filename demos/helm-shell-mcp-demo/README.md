# HELM Shell MCP Demo

This demo models `blazickjp/shell-mcp-server` behind HELM. It shows a
safe-by-default shell policy where read-only commands are allowed by policy
pack rules, while destructive commands are denied before dispatch.

This is an integration fixture, not HELM conformance or upstream
certification. `helm-ai-kernel` remains the source of truth for live verdicts,
receipts, and EvidencePack verification.

## Upstream

- Repository: https://github.com/blazickjp/shell-mcp-server
- Pinned ref checked on 2026-06-11:
  `309537a344fd48325644876dcb552bb39eb7a6fc`

## Scenario

| Intent | Expected verdict | Reason | Dispatch |
| --- | --- | --- | --- |
| `rm -rf ./workspace` through a shell MCP tool | `DENY` | `SHELL_DESTRUCTIVE_COMMAND_DENY` | `false` |

## Run

```bash
./demos/helm-shell-mcp-demo/run.sh --safe
python3 scripts/verify_samples.py
```

Generated proof fixture:

- Receipt: `receipts/samples/shell-mcp-destructive-command-deny.json`
- EvidencePack: `evidencepacks/samples/shell-mcp-destructive-command-deny.tar`
