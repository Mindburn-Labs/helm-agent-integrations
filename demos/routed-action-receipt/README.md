# Routed Action Receipt Example

This is the smallest integration pattern:

```text
agent proposes side effect
-> wrapper calls POST /api/v1/evaluate
-> dispatch only on ALLOW
-> return verdict, reason, and receipt metadata
```

## TypeScript Shape

```ts
import { withHelmBoundary } from "@mindburn/helm-tool-wrapper";

const result = await withHelmBoundary({
  helmUrl: "http://127.0.0.1:7714",
  apiKey: process.env.HELM_ADMIN_API_KEY ?? "",
  tenantId: "local-demo",
  principal: "demo-agent",
  sessionId: "demo-session-1",
  actionUrn: "tool.gmail.send_email",
  riskClass: "T2",
  effectClass: "E4",
  tool: sendEmail,
})({ to: "ops@example.com", subject: "Review", body: "Draft" });

if (!result.allowed) {
  console.log(result.verdict, result.decision.reason, result.receipt?.receiptId);
}
```

## Python Shape

```python
import os

from helm_tool_wrapper import preflight_action

result = preflight_action(
    action_urn="tool.sql.execute",
    input={"query": "DROP TABLE customers"},
    api_key=os.environ["HELM_ADMIN_API_KEY"],
    tenant_id="local-demo",
    principal="demo-agent",
    session_id="demo-session-1",
    risk_class="T2",
    effect_class="E4",
)

if not result.allowed:
    receipt_id = result.receipt.receipt_id if result.receipt else None
    print(result.verdict, result.decision.reason, receipt_id)
```

`DENY` and `ESCALATE` do not dispatch. EvidencePack verification remains owned
by `helm-ai-kernel verify`.
