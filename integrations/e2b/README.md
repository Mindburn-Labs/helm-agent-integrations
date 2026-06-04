# E2B + HELM

E2B runs code for agents. HELM can decide whether code execution should happen
and record why before the sandbox starts or before risky capabilities are
enabled.

Use `fromE2BExecution(...)` plus `withHelmBoundary(...)`.

Sample receipt:

```text
receipts/samples/e2b-network-egress-deny.json
```
