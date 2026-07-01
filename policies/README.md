# Sample Policies

These policy files are demo profiles for HELM-compatible integration examples.
They are intentionally small and source-backed by generated scenarios in this
repository.

For production policy semantics, use `helm-ai-kernel` policy material and
verification commands. These samples are not conformance packs.

## Local Boundary Form

The TOML files keep the same top-level shape used by local
`helm-ai-kernel serve --policy` examples:

```toml
name = "..."
profile = "..."
reference_pack = "..."

[server]
bind = "127.0.0.1"
port = 7714

[receipts]
store = "sqlite"
path = "./data/launch_receipts.db"
```

## Included Profiles

- `default.low_risk.toml`
- `agent.browser.high_risk.toml`
- `agent.devtools.high_risk.toml`
- `agent.email.high_risk.toml`
- `mcp.quarantine.strict.toml`
- `policy.shell.safe-by-default.toml`
- `policy.db.readonly.toml`
- `policy.cicd.approval-required.toml`
- `policy.cloud.mutations.toml`
- `policy.loop.governance.toml`
- `policy.mcp.multi-tool.sandbox.toml`
- `policy.mobile.resource-limits.toml`
- `tinyfish.web_capability.toml`

## Policy-Pack Assembly Guide

Build policy packs by MCP server type and keep each pack narrow enough that a
reviewer can see the intended authority boundary:

- Shell: allow read-only commands such as `pwd`, `ls`, `cat`, `grep`, and
  `find`; deny destructive commands, privilege escalation, secret reads,
  pipe-to-shell installers, and writes outside the declared workspace.
- DB: allow only `SELECT` and `EXPLAIN`; deny DDL, DML, transaction mutation,
  export, extension loading, and administrative commands.
- CI/CD: escalate workflow dispatch, deploy, release, environment, runner, and
  secret changes. Attach the approval owner and artifact digest in production
  policy material.
- Cloud: deny mutations by default and allow only explicit operation names.
  Keep read-only inventory and mutation whitelists in separate rules.
- Stripe and payments: escalate charge, refund, transfer, payout, subscription,
  price, and customer-data mutations; deny unbounded exports and missing spend
  caps.
- GitHub and Git: allow read-only repository inspection; escalate pushes, branch
  protection changes, release creation, workflow edits, token/secret changes,
  and issue or PR state mutation when required by the workflow.
- Kubernetes: allow read-only discovery; escalate or deny `apply`, `delete`,
  `exec`, `port-forward`, secret reads, RBAC changes, and production namespace
  mutations.
- Browser and Playwright: log URL, action intent, selector or semantic target,
  and form-submit/admin-change intent. Escalate critical administrative actions.
- Mobile and Termux: include CPU, battery, network, storage, background-task,
  and UX interruption facts. Escalate high-resource work on mobile hardware.

Each pack should include a TOML profile, a matching
`policies/reference/*.json` rule file, generated sample receipts, and sample
EvidencePacks. These references are demo fixtures; production enforcement and
verification remain owned by `helm-ai-kernel`.

## Integrity

`SHA256SUMS.txt` pins the digest of every policy TOML and reference pack JSON
in this directory. `make verify-samples` (also run in CI by the HELM Boundary
Check workflow) parses each TOML, resolves its `reference_pack`, validates the
reference rules against canonical ALLOW/DENY/ESCALATE verdicts, and fails on
any digest mismatch. After intentionally editing a policy, regenerate the
manifest:

```bash
cd policies && { for f in *.toml; do shasum -a 256 "$f"; done; \
  for f in reference/*.json; do shasum -a 256 "$f"; done; } > SHA256SUMS.txt
```
