# HELM MCP Playwright Demo

This demo models Playwright MCP around a critical administrative web interface.
The fixture records URL and action intent in the sample EvidencePack and
escalates an admin mutation before browser dispatch.

This is an integration fixture, not HELM conformance or upstream
certification.

## Upstream

- Repository: https://github.com/microsoft/playwright-mcp
- Pinned ref checked on 2026-06-11:
  `b301c372ec741289eff1cf6aab9d3bec553f31e2`

## Scenario

| Intent | Expected verdict | Reason | Dispatch |
| --- | --- | --- | --- |
| Click a destructive admin button in a mock user-management UI | `ESCALATE` | `PLAYWRIGHT_ADMIN_ACTION_ESCALATE` | `false` |

## Run

```bash
./demos/helm-mcp-playwright-demo/run.sh --safe
python3 scripts/verify_samples.py
```

Mock admin UI fixture: `mock-admin/index.html`.
