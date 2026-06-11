# HELM Kilntainers Demo

This demo models `Kiln-AI/Kilntainers` with HELM layered inside the sandbox
execution path. The fixture demonstrates stacking container isolation with an
exec firewall: the container boundary limits blast radius, and HELM still
denies destructive shell intent before dispatch.

This is an integration fixture, not HELM conformance or upstream
certification.

## Upstream

- Repository: https://github.com/Kiln-AI/Kilntainers
- Pinned ref checked on 2026-06-11:
  `79e26f5b93ee664435150038b4ee31f01b4e7ec0`

## Scenario

| Intent | Expected verdict | Reason | Dispatch |
| --- | --- | --- | --- |
| Destructive command inside an ephemeral Linux sandbox | `DENY` | `KILNTAINERS_EXEC_FIREWALL_DENY` | `false` |

## Run

```bash
./demos/helm-kilntainers-demo/run.sh --safe
python3 scripts/verify_samples.py
```

If Docker is not installed, the safe harness reports `SKIP` for the optional
container smoke.
