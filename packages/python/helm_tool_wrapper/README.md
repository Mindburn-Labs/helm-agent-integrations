# helm-tool-wrapper

Thin Python wrapper for routing side-effectful tool calls through a local HELM
AI Kernel boundary before dispatch.

The wrapper sends a direct preflight request to `POST /api/v1/evaluate`.
It dispatches the wrapped function only when the HELM verdict is `ALLOW`.
`DENY`, `ESCALATE`, and `PENDING` return a non-dispatched result with decision
and receipt metadata.

```python
from helm_tool_wrapper import with_helm_boundary

@with_helm_boundary(
    helm_url="http://127.0.0.1:7715",
    principal="demo-agent",
    action_urn="tool.gmail.send_email",
    risk_class="T2",
    effect_class="IRREVERSIBLE",
)
def send_email(payload: dict[str, str]):
    return {"provider_id": "msg_123", **payload}

result = send_email({"to": "ops@example.com", "subject": "Review"})
```

This package does not define HELM verdict semantics. It only calls the kernel
boundary and follows the returned verdict.
