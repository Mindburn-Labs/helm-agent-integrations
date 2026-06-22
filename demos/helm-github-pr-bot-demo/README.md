# HELM GitHub PR Bot Demo

This sample models a GitHub PR bot running an overnight triage loop. The
fixture emits a read-only report receipt with recurring loop metadata and does
not mutate pull requests.

This is a HELM-compatible example, not upstream certification or HELM
conformance.

## Upstream

- Repository: https://github.com/actions/github-script
- Pinned ref checked on 2026-06-22:
  `3a2844b7e9c422d3c10d287c895573f7108da1b3`

## Scenario

| Intent | Expected verdict | Reason | Dispatch |
| --- | --- | --- | --- |
| Emit overnight PR triage without mutating PRs | `ALLOW` | `GITHUB_PR_TRIAGE_REPORT_ALLOW` | `false` |
| Attempt to mutate PR labels or comments without reviewer approval | `ESCALATE` | `GITHUB_PR_MUTATION_ESCALATE` | `false` |

## Run

```bash
./demos/helm-github-pr-bot-demo/run.sh --safe
python3 scripts/verify_samples.py
```

The safe harness does not require a GitHub token.
