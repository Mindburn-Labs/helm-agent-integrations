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
port = 7715

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
- `tinyfish.web_capability.toml`

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
