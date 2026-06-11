# HELM Claude Shellfirm Demo

This demo models Claude Code with `shellfirm` as a PreToolUse signal and HELM
as the final execution boundary. The fixture records the chain:
shellfirm verdict, HELM decision, and sample receipt.

This is an integration fixture, not HELM conformance or upstream
certification.

## Upstream

- Repository: https://github.com/kaplanelad/shellfirm
- Pinned ref checked on 2026-06-11:
  `7ebf869770c197bf5591bdcf4003f6373af6c211`

## Scenario

| Intent | Expected verdict | Reason | Dispatch |
| --- | --- | --- | --- |
| Claude Bash command receives shellfirm `block`, then HELM denies | `DENY` | `SHELLFIRM_BLOCK_HELM_DENY` | `false` |

## Run

```bash
./demos/helm-claude-shellfirm-demo/run.sh --safe
python3 scripts/verify_samples.py
```

The safe harness does not install Claude Code hooks or execute shellfirm. It
verifies the sample receipt chain only.
