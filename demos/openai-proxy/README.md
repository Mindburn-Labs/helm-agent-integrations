# OpenAI-Compatible Proxy Demo

Use the HELM proxy with clients that accept a custom OpenAI-compatible base URL.

From the [HELM AI Kernel source checkout](https://github.com/Mindburn-Labs/helm-ai-kernel),
run the maintained local demo.

```sh
make demo-openai-proxy
```

The demo starts a mock upstream and a proxy on loopback. It checks that the
proxy returns a model response, records a receipt, and blocks a denied tool
call before it reaches the client. Both processes stop when the demo exits.

Use the [Kernel proxy guide](https://github.com/Mindburn-Labs/helm-ai-kernel/blob/main/docs/INTEGRATIONS/openai_baseurl.md)
to run the proxy for your own client or select a policy.

## Sample receipt

The [denied side-effect fixture](../../receipts/samples/openai-proxy-side-effect-deny.json)
shows the verdict and reason recorded in this repository’s sample format.
