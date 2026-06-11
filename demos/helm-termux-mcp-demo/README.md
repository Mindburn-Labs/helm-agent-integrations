# HELM Termux MCP Demo

This demo models an Android Termux MCP server behind HELM. The scenario focuses
on mobile resource and UX constraints: high-resource background work on mobile
hardware escalates instead of running silently.

This is an integration fixture, not HELM conformance or upstream
certification.

## Upstream

- Repository: https://github.com/xlisp/termux-mcp-server
- Pinned ref checked on 2026-06-11:
  `fc96806e135b3f82b46bf114734efa529ce6dcbf`

## Scenario

| Intent | Expected verdict | Reason | Dispatch |
| --- | --- | --- | --- |
| Start high-resource background work on Android Termux | `ESCALATE` | `TERMUX_RESOURCE_LIMIT_ESCALATE` | `false` |

## Run

```bash
./demos/helm-termux-mcp-demo/run.sh --safe
python3 scripts/verify_samples.py
```

If `adb` is not installed, the safe harness reports `SKIP` for the optional
Android emulator/device smoke.
