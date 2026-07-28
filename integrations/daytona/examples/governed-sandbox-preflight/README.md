# Daytona Governed Sandbox Preflight

Expected results:

- a sandbox creation request with unbounded egress is denied
- sandbox dispatch is false
- reason code: `SANDBOX_UNBOUNDED_EGRESS_DENY`
- an SSH grant into a sandbox escalates instead of dispatching
- reason code: `SANDBOX_HUMAN_ACCESS_ESCALATE`

Both outcomes are backed by concrete policy facts: the wrapper normalizes
Daytona network settings into the stable `network` field (no explicit
block-all or allowlist fails closed to `"external"`), and the reference policy
rules in `policies/reference/agent.devtools.high_risk.json` deny
`tool.daytona.sandbox.create` when `network: external` and escalate
`tool.daytona.sandbox.ssh_grant` on `access_channel: ssh`. The generated
sample receipts record the matched facts under `policy_facts`, and sample
generation fails if a receipt reason code is not backed by a matching
reference-policy rule.
