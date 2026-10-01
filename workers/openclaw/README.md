# OpenClaw HELM worker

This HELM-compatible adapter runs the public OpenClaw `Agent` core from the
published `openclaw@2026.9.6` package. It reuses the HELM worker contract and A2A
server; it has no separate controller, organization state or authority issuer.

The upstream [enterprise announcement](https://openclaw.ai/blog/openclaw-enterprise)
and [MIT-licensed enterprise harness](https://github.com/openclaw/openclaw-enterprise)
identify the framework. This adapter uses the actual public
`openclaw/plugin-sdk/agent-core`, `openclaw/plugin-sdk/llm` and the published
`@openclaw/ai` embedding port, rather than
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
The native registered Responses provider receives the exact guarded fetch through
`configureAiTransportHost`; the lazy OpenClaw convenience stream is not selected.
That convenience stream can bypass an ambient fetch hook via imported Undici.
Provider plugin routing is inert. Native model and MCP requests enforce the exact
supplied endpoint and episode credential, with redirects refused.
The gateway owns actual budget, authority,
pricing and context admission. Local SDK model metadata does not grant those.

The episode token travels only through private stdin. The child receives an
empty ephemeral home and a small environment preserving public private-CA trust
paths; no ambient provider keys, proxy settings or Node options are inherited.
Model responses are capped at 1 MiB. MCP responses allow 4 MiB for a canonical
1 MiB artifact plus its structured result and JSON text mirror, with 8 MiB of
HTTP response bytes per episode. Model request context uses the gateway's
existing 4 MiB limit. Private IPC caps each line at 512 KiB and all lines at
8 MiB; larger tool observations use ordered, digest-checked chunks, bounded to
5 MiB of reassembled JSON. Python observes only the complete original result;
missing, reordered, repeated or altered chunks fail the episode. Other oversized
events fail without truncation. One episode permits at most 256
tool dispatches and 20 model turns. Cancellation/deadline terminates the child's
entire process group. A2A ingress
uses the separate shared-runtime bearer, and retained task recovery remains
Get/Subscribe rather than a second episode start.

## Qualification

Root owns native jobs, image builds and network conformance. Source tests use the
actual Agent with native SDK event streams and exercise refusal, stop ordering,
cancellation and bounded looping without provider calls. An additional test uses
the actual native Responses provider against a loopback HTTP/SSE server and
checks guarded egress, redirects, destination refusal and stalled-stream abort.
The same existing
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
