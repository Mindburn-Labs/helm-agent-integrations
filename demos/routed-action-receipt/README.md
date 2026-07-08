# Routed Action Receipt Example

This is the smallest integration pattern:

```text
agent proposes side effect
-> wrapper calls POST /api/v1/evaluate
-> dispatch only on ALLOW
-> return verdict, reason, receipt ref, and EvidencePack ref
```

## TypeScript Shape

```ts
const result = await withHelmBoundary({
  helmUrl: "http://127.0.0.1:7714",
  principal: "demo-agent",
  actionUrn: "tool.gmail.send_email",
  riskClass: "T2",
  effectClass: "E4",
  tool: sendEmail,
})({ to: "ops@example.com", subject: "Review", body: "Draft" });

if (!result.allowed) {
  console.log(result.verdict, result.decision.reason, result.receipt.ref);
}
```

## Python Shape

```python
result = preflight_action(
    action_urn="tool.sql.execute",
    input={"query": "DROP TABLE customers"},
    risk_class="T2",
    effect_class="E4",
)

if not result.allowed:
    print(result.verdict, result.decision.reason, result.receipt.ref)
```

`DENY` and `ESCALATE` do not dispatch. EvidencePack verification remains owned
by `helm-ai-kernel verify`.
