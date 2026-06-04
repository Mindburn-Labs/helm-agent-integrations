# Composio + HELM

Composio gives agents access to SaaS tools and auth. HELM governs what the
agent may do with those tools before dispatch.

Use `fromComposioAction(...)` plus `withHelmBoundary(...)`.

Sample receipt:

```text
receipts/samples/composio-salesforce-export-deny.json
```
