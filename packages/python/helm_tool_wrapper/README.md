# helm-tool-wrapper

Thin Python wrapper for routing side-effectful tool calls through a local HELM
AI Kernel boundary before dispatch.

The wrapper sends a direct preflight request to `POST /api/v1/evaluate`.
Each request binds the tool input through the served V5 top-level fields while
retaining the matching legacy aliases for current policy compatibility.
It dispatches the wrapped function only when the HELM verdict is `ALLOW`.
`DENY`, `ESCALATE`, and `PENDING` return a non-dispatched result with decision
and receipt metadata. The current served route requires the admin bearer key
plus explicit tenant and principal binding headers. Set `workspace_id` when
the Kernel runtime requires an authenticated workspace binding.

```python
import os

from helm_tool_wrapper import with_helm_boundary

@with_helm_boundary(
    helm_url="http://127.0.0.1:7714",
    api_key=os.environ["HELM_ADMIN_API_KEY"],
    tenant_id="local-demo",
    principal="demo-agent",
    workspace_id="workspace-demo",
    session_id="demo-session-1",
    action_urn="tool.gmail.send_email",
    risk_class="T2",
    effect_class="E4",
    export_evidence=True,
)
def send_email(payload: dict[str, str]):
    return {"provider_id": "msg_123", **payload}

result = send_email({"to": "ops@example.com", "subject": "Review"})
print(result.receipt.receipt_id, result.evidence_pack.evidence_hash)
```

This package does not define HELM verdict semantics. It only calls the kernel
boundary and follows the returned verdict.

`export_evidence=True` is opt-in. After the evaluate response returns a real
`receipt_id`, the wrapper calls the authenticated `POST /api/v1/evidence/export`
route for that session, verifies the source-defined `X-Helm-Evidence-Hash`
against the returned bytes, and only then permits an `ALLOW` dispatch. Export
failure, a missing receipt, or a hash mismatch fails closed before dispatch.
Even without export enabled, an `ALLOW` response must carry a durable
`receipt_id` before the wrapper dispatches.
The returned pack is preflight evidence only: it contains the receipts
available before tool execution and does not reconcile or attest to the later
provider result.

TinyFish helpers normalize Search, Fetch, Browser, and Agent proposals before
the same HELM preflight:

```python
import os

from helm_tool_wrapper import from_tinyfish_fetch, preflight_action

intent = from_tinyfish_fetch({
    "urls": ["https://example.com/source"],
    "ttl": 3600,
})

result = preflight_action(
    action_urn=intent.action_urn,
    input=intent.input,
    api_key=os.environ["HELM_ADMIN_API_KEY"],
    tenant_id="local-demo",
    principal="demo-agent",
    session_id="tinyfish-session-1",
    risk_class=intent.risk_class,
    effect_class=intent.effect_class,
    metadata=intent.metadata,
)
```

Configure `api_key` from `HELM_ADMIN_API_KEY` for the tenant-scoped evaluate
route. `service_token` is accepted as an explicit configuration key only so
the wrapper can reject it before transport; `HELM_SERVICE_API_KEY`
authenticates service-internal Kernel routes, not `/api/v1/evaluate`.

Codex and Claude Code normalizers preserve the real tool arguments (including
Claude's `tool_input`) and assign the conservative trusted default `T2/E4`.
Caller-supplied risk/effect downgrades and principal overrides are ignored.

## Twelve runnable framework helper examples

The installed package includes one deterministic example for every framework
normalizer. It checks normalization and sends each intent through an
in-process `/api/v1/evaluate` contract double; it also proves a denied
unknown-tool attempt does not dispatch:

```bash
python -m helm_tool_wrapper.examples.framework_helpers
```

The module exposes `framework_helper_examples()`,
`verify_framework_helper_examples()`, and
`verify_framework_helper_preflight_contract()`. It covers Hermes, OpenClaw,
Mastra, Codex, Claude Code, Browser Use, four TinyFish surfaces, E2B, and
Composio. The examples use representative call payloads and a simulated
transport only; they do not contact a provider, a live Kernel, or authorize an
external effect.
