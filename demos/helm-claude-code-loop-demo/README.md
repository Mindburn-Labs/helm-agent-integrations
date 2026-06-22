# HELM Claude Code /loop Demo

This sample models a Claude Code `/loop` run that attempts a high-risk
operation without approval evidence. HELM denies the effect before dispatch and
records denied loop evidence.

This is a HELM-compatible example, not upstream certification or HELM
conformance.

## Upstream

- Repository: https://github.com/anthropics/claude-code
- Pinned ref checked on 2026-06-23:
  `12281998d8c85813c4b5952ed9367784aae37d31`

## Scenario

| Intent | Expected verdict | Reason | Dispatch |
| --- | --- | --- | --- |
| Run `/loop` as a production operate action without approval | `DENY` | `CLAUDE_LOOP_OPERATE_APPROVAL_DENY` | `false` |

## Run

```bash
./demos/helm-claude-code-loop-demo/run.sh --safe
python3 scripts/verify_samples.py
```

The safe harness does not require a Claude subscription or API key.
