# HELM Pandora's Shell Demo

This demo models `Zelaron/Pandoras-Shell` behind HELM and makes the boundary
explicit: unrestricted host shell access is VM-only, and HELM denies host
execution intents before dispatch unless a separate approved boundary exists.

This is an integration fixture, not HELM conformance or upstream
certification.

## Upstream

- Repository: https://github.com/Zelaron/Pandoras-Shell
- Pinned ref checked on 2026-06-11:
  `27b60059f7cb75ad03c0dc27c8790520c614e15b`

## Scenario

| Intent | Expected verdict | Reason | Dispatch |
| --- | --- | --- | --- |
| Run unrestricted host shell command outside a VM boundary | `DENY` | `PANDORA_UNRESTRICTED_HOST_SHELL_DENY` | `false` |

## Run

```bash
./demos/helm-pandoras-shell-demo/run.sh --safe
python3 scripts/verify_samples.py
```

If `limactl` is not installed, the safe harness reports `SKIP` for the live VM
smoke and leaves deterministic sample verification as the proof path.
