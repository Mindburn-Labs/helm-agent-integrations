# HELM Claude Code /goal Demo

This sample models a Claude Code `/goal` request routed through an optional
HELM boundary. The fixture registers a bounded docs truth loop and records
Agent Run Receipt v2 loop metadata without writing memory directly.

This is a HELM-compatible example, not upstream certification or HELM
conformance.

## Upstream

- Repository: https://github.com/anthropics/claude-code
- Pinned ref checked on 2026-06-22:
  `12281998d8c85813c4b5952ed9367784aae37d31`

## Scenario

| Intent | Expected verdict | Reason | Dispatch |
| --- | --- | --- | --- |
| Register a docs truth loop from `/goal` | `ALLOW` | `CLAUDE_GOAL_DOCS_TRUTH_ALLOW` | `false` |
| Attempt `/loop` as a production operate action without approval | `DENY` | `CLAUDE_LOOP_OPERATE_APPROVAL_DENY` | `false` |

## Run

```bash
./demos/helm-claude-code-goal-demo/run.sh --safe
python3 scripts/verify_samples.py
```

The safe harness does not require a Claude subscription or API key.
