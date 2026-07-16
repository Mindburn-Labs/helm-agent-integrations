# @mindburn/helm-tool-wrapper

Thin TypeScript wrapper for routing side-effectful tool calls through a local
HELM AI Kernel boundary before dispatch.

The wrapper sends a direct preflight request to `POST /api/v1/evaluate`.
It dispatches the wrapped tool only when the HELM verdict is `ALLOW`. `DENY`,
`ESCALATE`, and `PENDING` return a non-dispatched result with decision and
receipt metadata. The current served route requires the admin bearer key plus
explicit tenant and principal binding headers.

```ts
import { withHelmBoundary } from "@mindburn/helm-tool-wrapper";

const sendEmail = withHelmBoundary({
  helmUrl: "http://127.0.0.1:7714",
  apiKey: process.env.HELM_ADMIN_API_KEY ?? "",
  tenantId: "local-demo",
  principal: "demo-agent",
  sessionId: "demo-session-1",
  actionUrn: "tool.gmail.send_email",
  riskClass: "T2",
  effectClass: "E4",
  tool: async (input: { to: string; subject: string }) => {
    return { provider_id: "msg_123", ...input };
  },
});

const result = await sendEmail({ to: "ops@example.com", subject: "Review" });
```

This package does not define HELM verdict semantics. It only calls the kernel
boundary and follows the returned verdict.

TinyFish helpers normalize Search, Fetch, Browser, and Agent proposals before
the same HELM preflight:

```ts
import { fromTinyFishAgentRun, preflightAction } from "@mindburn/helm-tool-wrapper";

const intent = fromTinyFishAgentRun({
  url: "https://shop.example/checkout",
  goal: "Submit the saved cart",
  action_intent: "submit",
});

const result = await preflightAction({
  actionUrn: intent.actionUrn,
  input: intent.input,
  apiKey: process.env.HELM_ADMIN_API_KEY ?? "",
  tenantId: "local-demo",
  principal: "demo-agent",
  sessionId: "tinyfish-session-1",
  riskClass: intent.riskClass,
  effectClass: intent.effectClass,
  metadata: intent.metadata,
});
```

Configure `apiKey` from `HELM_ADMIN_API_KEY` for the tenant-scoped evaluate
route. `serviceToken` is accepted as an explicit configuration key only so the
wrapper can reject it before transport; `HELM_SERVICE_API_KEY` authenticates
service-internal Kernel routes, not `/api/v1/evaluate`.

Codex and Claude Code normalizers preserve the real tool arguments (including
Claude's `tool_input`) and assign the conservative trusted default `T2/E4`.
Caller-supplied risk/effect downgrades and principal overrides are ignored.

## Twelve runnable framework helper examples

The package exports one deterministic example for every framework normalizer.
It checks normalization and sends each intent through an in-process
`/api/v1/evaluate` contract double; it also proves a denied unknown-tool
attempt does not dispatch. Run it locally:

```bash
npm run example:framework-helpers
```

Consumers may also import `@mindburn/helm-tool-wrapper/examples/framework-helpers`
and call `frameworkHelperExamples()`, `verifyFrameworkHelperExamples()`, or
`verifyFrameworkHelperPreflightContract()`. The examples cover Hermes,
OpenClaw, Mastra, Codex, Claude Code, Browser Use, four TinyFish surfaces,
E2B, and Composio. They use representative call payloads and a simulated
transport only; they do not contact a provider, a live Kernel, or authorize an
external effect.
