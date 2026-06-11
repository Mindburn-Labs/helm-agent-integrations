# HELM Agent Integrations

HELM Agent Integrations is a public adapter and demo repository for routing
agent-framework side effects through HELM AI Kernel.

The positioning is deliberately narrow:

```text
Agent frameworks propose and orchestrate work.
HELM governs execution and produces evidence.
```

This repository does not define HELM conformance. `helm-ai-kernel` remains the
source of truth for verdicts, receipts, MCP quarantine, OpenAI-compatible proxy
behavior, and EvidencePack verification.

## First Slice

This repo currently ships:

- TypeScript `withHelmBoundary(...)` wrapper around `POST /api/v1/evaluate`
- Python `with_helm_boundary(...)` wrapper around `POST /api/v1/evaluate`
- framework intent normalizers for Hermes, OpenClaw, Mastra, Browser Use, E2B,
  Composio, and TinyFish governed web capability
- universal demo docs for MCP boundary, OpenAI-compatible proxy, and generic
  tool wrappers
- high-risk MCP and shell demo fixtures for shell, VM, container, mobile,
  browser-admin, Claude Code hook, and OpenAI Agents tool-call surfaces
- Hermes and OpenClaw example integration bundles
- sample policies and policy-pack templates for common agent-side-effect classes
- generated sample receipts and EvidencePack archives
- maintainer issue/PR copy for upstream example submissions
- CI checks that rebuild and verify the generated samples

## Quickstart

Start a local HELM boundary from `helm-ai-kernel`:

```bash
cd ../helm-ai-kernel
make build
HELM_ADMIN_API_KEY=local-admin-key \
  ./bin/helm-ai-kernel serve \
  --policy examples/launch/policies/agent_tool_call_boundary.toml
```

Use the TypeScript wrapper:

```ts
import { withHelmBoundary } from "@mindburn/helm-tool-wrapper";

const sendEmail = withHelmBoundary({
  helmUrl: "http://127.0.0.1:7715",
  principal: "demo-agent",
  actionUrn: "tool.gmail.send_email",
  riskClass: "T2",
  effectClass: "E4",
  tool: async (input: { to: string; subject: string; body: string }) => {
    return { provider_id: "msg_123", ...input };
  },
});

const result = await sendEmail({
  to: "investor@example.com",
  subject: "Follow-up",
  body: "Drafted by agent.",
});

if (!result.allowed) {
  console.log(result.verdict, result.decision.reason);
}
```

Use the Python wrapper:

```python
from helm_tool_wrapper import with_helm_boundary

@with_helm_boundary(
    helm_url="http://127.0.0.1:7715",
    principal="demo-agent",
    action_urn="tool.sql.execute",
    risk_class="T2",
    effect_class="E4",
)
def execute_sql(query: str):
    return {"rows": 1, "query": query}

result = execute_sql("DROP TABLE customers")
if not result.allowed:
    print(result.verdict, result.decision.reason)
```

## Repository Layout

```text
packages/js/helm-tool-wrapper/       TypeScript direct preflight wrapper
packages/python/helm_tool_wrapper/   Python direct preflight wrapper
demos/                               universal boundary/proxy/wrapper demos
integrations/                        framework-specific examples
policies/                            sample integration policy profiles
receipts/samples/                    generated sample receipt JSON
evidencepacks/samples/               generated sample EvidencePack archives
docs/campaign/                       maintainer-ready issue and PR copy
```

TinyFish-style web capability examples live under `integrations/tinyfish/`.
They are HELM-governed external web capability fixtures, not TinyFish
certification or partnership claims.

## Generate And Verify Samples

Sample receipts and EvidencePack archives are generated from
`scripts/generate_samples.py`.

```bash
python3 scripts/generate_samples.py
python3 scripts/generate_samples.py --check
python3 scripts/verify_samples.py
```

The samples are deterministic local proof fixtures for demos. They are not
customer trust anchors and do not replace native `helm-ai-kernel verify`.

## Validation

```bash
make validate
```

The validation target runs TypeScript build/tests, Python tests, sample
regeneration checks, and sample integrity checks.

## Source Truth

- HELM Kernel repo: https://github.com/Mindburn-Labs/helm-ai-kernel
- MCP integration docs: `helm-ai-kernel/docs/INTEGRATIONS/mcp.md`
- OpenAI-compatible proxy docs:
  `helm-ai-kernel/docs/INTEGRATIONS/openai_baseurl.md`
- HTTP API docs: `helm-ai-kernel/docs/reference/http-api.md`
- Verification docs: `helm-ai-kernel/docs/VERIFICATION.md`

## Maintainer Copy

Use `docs/campaign/maintainer-issue.md` and
`docs/campaign/maintainer-pr.md` when opening upstream examples. Keep upstream
submissions small, optional, and example-only.
