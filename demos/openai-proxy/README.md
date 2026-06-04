# OpenAI-Compatible Proxy Demo

This demo shows the low-friction integration path for frameworks that already
support an OpenAI-compatible `base_url`.

```text
OpenAI-shaped client
  -> http://127.0.0.1:9090/v1
  -> HELM proxy
  -> HELM boundary
  -> upstream model only after policy check
  -> X-Helm-* receipt headers
```

## Kernel Surface

Use the source-owned proxy surface from `helm-ai-kernel`:

```bash
cd ../../helm-ai-kernel
make build
HELM_ADMIN_API_KEY=local-admin-key \
  ./bin/helm-ai-kernel serve \
  --policy examples/launch/policies/agent_tool_call_boundary.toml

python3 scripts/launch/mock-openai-upstream.py --port 19090
./bin/helm-ai-kernel proxy \
  --upstream http://127.0.0.1:19090/v1 \
  --port 9090 \
  --receipts-dir ./helm-receipts
```

Point compatible clients at:

```text
http://127.0.0.1:9090/v1
```

## Integration Scenario

Generated sample:

```bash
cat receipts/samples/openai-proxy-side-effect-deny.json
```

Expected result:

- side-effectful shell request is denied
- upstream dispatch is false
- receipt metadata is visible through HELM
