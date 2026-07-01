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
    helm_url="http://127.0.0.1:7714",
    principal="demo-agent",
    action_urn="tool.gmail.send_email",
    risk_class="T2",
    effect_class="E4",
)
def send_email(payload: dict[str, str]):
    return {"provider_id": "msg_123", **payload}

result = send_email({"to": "ops@example.com", "subject": "Review"})
```

This package does not define HELM verdict semantics. It only calls the kernel
boundary and follows the returned verdict.

TinyFish helpers normalize Search, Fetch, Browser, and Agent proposals before
the same HELM preflight:

```python
from helm_tool_wrapper import from_tinyfish_fetch, preflight_action

intent = from_tinyfish_fetch({
    "urls": ["https://example.com/source"],
    "ttl": 3600,
})

result = preflight_action(
    action_urn=intent.action_urn,
    input=intent.input,
    risk_class=intent.risk_class,
    effect_class=intent.effect_class,
    metadata=intent.metadata,
)
```
