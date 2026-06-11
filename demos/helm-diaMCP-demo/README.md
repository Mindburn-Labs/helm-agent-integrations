# HELM diaMCP Demo

This demo models `chartrambiz/diaMCP`, an all-in-one MCP server with file,
shell, git, and code execution surfaces. HELM treats those tool families
differently instead of granting one broad all-tools permission.

This is an integration fixture, not HELM conformance or upstream
certification.

## Upstream

- Repository: https://github.com/chartrambiz/diaMCP
- Pinned ref checked on 2026-06-11:
  `e73651388fe4ecfaef54d4a1082bd9066f3d0fff`

## Scenario

| Intent | Expected verdict | Reason | Dispatch |
| --- | --- | --- | --- |
| `filesystem.write` through a multi-tool MCP server | `ESCALATE` | `FILESYSTEM_WRITE_ESCALATE` | `false` |

## Run

```bash
./demos/helm-diaMCP-demo/run.sh --safe
python3 scripts/verify_samples.py
```

If Docker is not installed, the safe harness reports `SKIP` for the optional
containerized upstream smoke.
