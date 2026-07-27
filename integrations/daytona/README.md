# Daytona + HELM

Daytona provisions sandboxes that run agent code. HELM can decide whether a
sandbox should exist at all, with what egress, and whether a human may enter
it — and record why — before anything is provisioned.

Use `from_daytona_sandbox_create(...)`, `from_daytona_process_exec(...)`, and
`from_daytona_ssh_grant(...)` plus `with_helm_boundary(...)`.

Network settings normalize fail closed: a sandbox proposal without an explicit
block-all or allowlist is treated as `network: "external"`. An ALLOW verdict
carries the constraints the dispatch call must pin (allowlist, lifetime,
resource caps); the live example compiles them into Daytona create parameters.

Sample receipts:

```text
receipts/samples/daytona-sandbox-unbounded-egress-deny.json
receipts/samples/daytona-ssh-grant-escalate.json
```

This is a HELM-compatible example, not an official Daytona integration.
