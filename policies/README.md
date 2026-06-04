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
