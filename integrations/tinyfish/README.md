# TinyFish + HELM

TinyFish exposes Search, Fetch, Browser, and Agent API surfaces. This example
models those surfaces as an external web capability routed through HELM before
dispatch.

HELM remains the policy, receipt, approval, and EvidencePack boundary:

- missing `X-API-Key` credentials deny before dispatch
- Search and Fetch outputs must carry source URL hashes before evidence use
- Browser sessions with credentials require a credential grant and TTL
- Agent goals that submit, purchase, send, publish, or affect external state
  escalate before dispatch
- generated fixtures are `sample_only` and are not customer trust anchors

Sample policy:

```text
policies/tinyfish.web_capability.toml
```

Sample receipts:

```text
receipts/samples/tinyfish-search-missing-api-key-deny.json
receipts/samples/tinyfish-fetch-partial-source-deny.json
receipts/samples/tinyfish-browser-credential-grant-escalate.json
receipts/samples/tinyfish-agent-external-action-escalate.json
```

Use the TypeScript helpers:

```ts
import {
  fromTinyFishFetch,
  preflightAction,
} from "@mindburn/helm-tool-wrapper";

const intent = fromTinyFishFetch({
  urls: ["https://example.com/source"],
  ttl: 3600,
});

const result = await preflightAction({
  actionUrn: intent.actionUrn,
  input: intent.input,
  riskClass: intent.riskClass,
  effectClass: intent.effectClass,
  metadata: intent.metadata,
});
```

Use the Python helpers:

```python
from helm_tool_wrapper import from_tinyfish_agent_run, preflight_action

intent = from_tinyfish_agent_run({
    "url": "https://shop.example/checkout",
    "goal": "Submit the saved cart",
    "action_intent": "submit",
})

result = preflight_action(
    action_urn=intent.action_urn,
    input=intent.input,
    risk_class=intent.risk_class,
    effect_class=intent.effect_class,
    metadata=intent.metadata,
)
```
