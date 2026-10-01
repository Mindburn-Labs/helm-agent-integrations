# Native governed replay fixture

`helm_worker_conformance.native_governed_replay` drives already provisioned
workers against the native Kernel worker listener. It preserves each original
episode, model origin and MCP URL. The existing `governed_replay` transport relay
has separate unit coverage; its substituted endpoints cannot qualify the direct
Docker `Policy` network boundary.

The native producer is external to this kit. There is no default fixture or
catalog entry that fabricates credentials, ledger counters or a successful
sandbox readback. Until the producer below exists, native D8 remains unrun.

## Producer port

A caller-owned Python factory returns a context manager yielding `NativeReplay`.
It supplies the exact retained probes, tool name, native tool arguments and one
`NativeFixture`. The context manager owns finite resource lifetimes and cleanup
through the existing launcher. It must preserve primary failures and read back
actual absence of every resource it owns.

`NativeFixture.arm(probe, world, tool=..., arguments=..., drop_first=...)` installs
instrumentation on the actual worker TLS listener. It scripts the model behind
native `modelgw`, records real model/MCP traffic in the existing `World` format,
and loses one accepted MCP reply after the native ledger and adapter have run.
It performs actual image verification and `Policy.Readback` before the worker
receives its first A2A message. It creates no alternative worker model/MCP server.

`NativeFixture.observe(probe)` returns `NativeObservation`: actual accepted-call
facts, the gateway-authenticated caller binding, and public references to exact
image signature and same-sandbox isolation/negative-egress readback. References
must name actual producer evidence; their presence alone is not independent
signature or network verification. This kit relies on the trusted fixture owner
to perform those native checks and retain their evidence.

`NativeFixture.readback(attempt_id)` returns the existing `LedgerReadback` port:
native attempt IDs and dispatch/observe counts scoped to this work/effect/target/
intent, the Kernel-produced intent digest and original attempt binding. Readback
uses operator authority. A continuation's generic worker `GetAttempt` remains
N1 scoped and cannot supply cross-episode proof. The producer must never infer
counters from a worker artifact or use an in-memory replacement ledger.

Every callback needs a finite deadline. Observed traffic uses the host monotonic
clock used by `World`. Model/tool authorization violations record static labels
without bearer values. `AcceptedCall.session_ref` refers to a real initialized
native MCP client session; stateless protocol initialization needs a retained
native initialization reference rather than a fabricated header value.
`request_ref` names the actual received request within that initialized client
session. JSON-RPC IDs may repeat in different sessions; this producer uses an
actual native request observation reference and never rewrites the wire ID.

## Required native binding

Use at least two fresh framework/episode probes for the same actual work item;
one must be OpenClaw by default. Each probe has an actual, distinct A2A proxy
endpoint on port 8080. Both use the same exact HTTPS gateway origin on port 8444,
with no `/v1` suffix, and that origin's `/mcp`. The allowed tool list contains
only the effect under test. Ingress and episode bearers are distinct.

CP issues each actual worker token through its retained software signer. The
native listener verifies the signature and claims. The binding includes:

- `iss` from configured CP identity, `sub=agt:<seat_id>`,
  `aud=helm-gateway-worker:<environment>` distinct from the CP listener audience;
- `scope` covering `helm.gateway.propose` (and the issuer's applicable read scope),
  actual `tenant_id`, `workspace_id`, CP SPIFFE `act.sub`, unique `jti`;
- `exp <= min(episode deadline, iat + 3600 seconds)`, without client-certificate
  `cnf` on the worker listener;
- `helm_episode.episode_id`, `work_item_id`, `organization_version_id` equal to
  the exact retained CP episode/work/version.

Each seat still needs its real active mandate and model route/budget. Imported
cards, decoded claims and this fixture grant no authority. The observer copies
binding from the verified native handler, never from the episode body.

The fixture retains the first attempt snapshot independently before the later
episode runs. It must prove the same attempt, one admission/dispatch, unchanged
observation count and unchanged original episode/version/requester/intent. A
replayed effect or transport failure is not an applied work report.

## Native host configuration

The actual gateway composition owns these existing inputs:

- `HELM_GATEWAY_DATABASE_URL`: restricted native PostgreSQL connection;
- `HELM_GATEWAY_MODEL_ROUTES_FILE`: native routes, prices and gateway-only key
  references; the scripted qualification upstream is behind this gateway;
- `HELM_CP_IDENTITY_JWKS_URL`, `HELM_CP_IDENTITY_ISSUER`,
  `HELM_CP_IDENTITY_AUDIENCE`, `HELM_CP_IDENTITY_ACTOR` and the public outbound CA;
- `HELM_GATEWAY_WORKER_AUDIENCE` and `HELM_GATEWAY_WORKER_MAX_TTL` at most `1h`;
- serving TLS certificate/key and CP client CA configured by `servetls`;
  CP listener `--listen :8443`, native worker `--worker-listen :8444` with server
  TLS and no client certificate.

The launcher consumes actual public CA bytes/digest and a hostname matching the
gateway certificate SAN. It uses a signed worker manifest digest, resource/deadline
limits and the qualified dynamic per-episode `Policy`. The worker's internal
network has exactly worker + relay; only the gateway TLS port is reachable.
Negative probes and stopped/live attachment readback belong to that same policy
producer. No extra sinkhole member, host-published port, Docker socket, unsigned
image bypass or provider key is introduced by this driver.

## Parent-owned command

After the native producer publishes its real module and private configuration,
run from the immutable workers checkout using the qualified worker venv:

```bash
PYTHONPATH=workers/contract/python:workers/conformance:<native-fixture-module-directory> \
  <qualified-worker-venv>/bin/python -m helm_worker_conformance.native_governed_replay \
  --fixture <native-fixture-module>:open_fixture \
  --report <qualification-directory>/lost-tool-response-native.json
```

The module/path placeholders are explicit missing producer inputs, not runnable
defaults. The driver accepts no credential argument, prints only PASS/FAIL and
writes redacted checks plus public runtime evidence references. A missing native
producer, partial readback, unsupported actual worker or cleanup failure fails
qualification. Each probe is started once over A2A; a lost first response never
causes a resend or a guessed task ID.

Gate this source through the repository's native checks and the actual parent
fixture before declaring OpenClaw D8. This scenario alone proves neither a signed
release nor the complete organization runtime/OCE plugin acceptance.
