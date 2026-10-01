# OpenClaw HELM worker

This HELM-compatible adapter runs the public OpenClaw `Agent` core from the
published `openclaw@2026.9.6` package. It reuses the HELM worker contract and A2A
server; it has no separate controller, organization state or authority issuer.

The upstream [enterprise announcement](https://openclaw.ai/blog/openclaw-enterprise)
and [MIT-licensed enterprise harness](https://github.com/openclaw/openclaw-enterprise)
identify the framework. This adapter uses the actual public
`openclaw/plugin-sdk/agent-core` and `openclaw/plugin-sdk/llm` exports, rather than
the upstream controller, embedded gateway or provider credential configuration.
It does not claim an upstream endorsement.

## Execution boundary

Only the episode's granted tools are discovered through the canonical MCP SDK
and installed on the native Agent. There are no built-in shell, filesystem,
browser, channel or plugin tools. Sequential execution stops further calls after
an escalated attempt, delegation, input request or successful report. Actual MCP
error/status metadata is retained; a denied report cannot complete the episode.

The native OpenClaw Responses stream uses the supplied gateway origin plus `/v1`.
The episode itself keeps the origin without `/v1`, as required by the shared
contract. Model requests retain the supplied model and output limit, disable
parallel tool calls and provider storage, and cannot fall back to another route.
Both native fetch and MCP fetch enforce the exact supplied endpoint and episode
credential, with redirects refused. The gateway owns actual budget, authority,
pricing and context admission. Local SDK model metadata does not grant those.

The episode token travels only through private stdin. The child receives an
empty ephemeral home and a small environment preserving public private-CA trust
paths; no ambient provider keys, proxy settings or Node options are inherited.
Cancellation/deadline terminates the child's entire process group. A2A ingress
uses the separate shared-runtime bearer, and retained task recovery remains
Get/Subscribe rather than a second episode start.

## Qualification

Root owns native jobs, image builds and network conformance. Source tests use the
actual Agent with native SDK event streams and exercise refusal, stop ordering,
cancellation and bounded looping without provider calls. The same existing
black-box kit qualifies the built image, including network and TLS/CA behavior.

```sh
make workers-adapters-check
make workers-conformance-openclaw
```

The Node base is pinned to the enterprise runtime source's digest; engine-strict
must verify its real version. The Python base and hash-locked JSON-schema closure
are reused from the existing published Node-backed worker. Installing scripts is
disabled. Release uses the shared image workflow: digest conformance, signature
and attestation precede publication. No image, live CP integration or production
conformance is claimed by this source checkpoint.
