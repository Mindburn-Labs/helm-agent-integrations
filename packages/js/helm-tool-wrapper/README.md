# @mindburn/helm-tool-wrapper

Thin TypeScript wrapper for routing side-effectful tool calls through a local
HELM AI Kernel boundary before dispatch.

The wrapper sends a direct preflight request to `POST /api/v1/evaluate`.
It dispatches the wrapped tool only when the HELM verdict is `ALLOW`. `DENY`,
`ESCALATE`, and `PENDING` return a non-dispatched result with decision and
receipt metadata.

```ts
import { withHelmBoundary } from "@mindburn/helm-tool-wrapper";

const sendEmail = withHelmBoundary({
  helmUrl: "http://127.0.0.1:7715",
  principal: "demo-agent",
  actionUrn: "tool.gmail.send_email",
  riskClass: "T2",
  effectClass: "IRREVERSIBLE",
  tool: async (input: { to: string; subject: string }) => {
    return { provider_id: "msg_123", ...input };
  },
});

const result = await sendEmail({ to: "ops@example.com", subject: "Review" });
```

This package does not define HELM verdict semantics. It only calls the kernel
boundary and follows the returned verdict.
