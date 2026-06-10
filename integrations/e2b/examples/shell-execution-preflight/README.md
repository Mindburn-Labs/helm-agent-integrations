# E2B Shell Execution Preflight

Expected result:

- network egress request is denied
- sandbox dispatch is false
- reason code: `SANDBOX_NETWORK_EGRESS_DENY`

The denial is backed by a concrete policy fact: the wrapper normalizes the
E2B network capability into the stable `network: "external"` field (missing
or unknown capability fails closed to `external`), and the reference policy
rule in `policies/reference/agent.devtools.high_risk.json` denies
`tool.e2b.execute` when `network: external`. The generated sample receipt
records the matched facts under `policy_facts`, and sample generation fails
if a receipt reason code is not backed by a matching reference-policy rule.
