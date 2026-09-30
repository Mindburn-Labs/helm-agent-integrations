# Worker conformance kit

A black-box test kit for HELM agent worker images. It checks an image against the worker
contract in [`../contract`](../contract/README.md) (A2A protocol 1.0, `helm.episode.v1`). It is
not HELM AI Kernel conformance and certifies nothing: it answers one question, "will the control
plane be able to run this image as a worker?".

It runs in CI and against a published image with the same command.

```bash
# any image: a local tag, or a published digest
python3 -m helm_worker_conformance --image ghcr.io/mindburn-labs/helm-worker-langgraph@sha256:...

# a subset, with the worker logs and a JSON report kept
python3 -m helm_worker_conformance --image helm-worker-langgraph:dev \
  --scenario report_completes --scenario escalated_parks --logs out/logs --report out/report.json
```

Run it from `workers/conformance` (or set `PYTHONPATH` to it). The host side uses only the Python
standard library; it needs `docker`. Exit status 0 means every check passed.

## How it isolates the worker

```text
docker network (--internal: no route out)
  ├─ runner   stubs + a strict A2A client + the egress sinkhole; the worker's DNS server
  └─ worker   the image under test; one fresh container per scenario
```

- The worker container runs read-only with all capabilities dropped and bounded memory, CPU and
  processes (scratch space is a `/tmp` tmpfs), as it will in the sandbox. Images must keep `HOME`
  and any state under `/tmp`.
- The network is `--internal`, so nothing outside it is reachable; the kit first proves that from
  inside. On top of that, the worker's DNS server is a sinkhole that answers every name with its
  own address and logs the question, and TCP traps on ports 80 and 443 log any connection that
  follows. A worker that tries to reach anything other than the two stub hostnames leaves a
  record, even though the connection could not have left.
- The runner hosts the stubs the episode points at: a HELM MCP server (streamable HTTP, more
  tools than any episode allows, one that always answers `{"status": "escalated", "attempt_id"}`)
  and scripted model endpoints for `/v1/messages`, `/v1/responses` and `/v1/chat/completions`
  (streaming and not). The model script is chosen by how many assistant turns the conversation
  already holds, so retries cannot desync it.
- The worker's environment is `HELM_EPISODE_TOKEN`, `HELM_A2A_BEARER_TOKEN` and `PORT`. The
  episode carries no secret.

## What it checks

`agent_card` reads the card first; the model APIs it advertises decide which APIs the other
scenarios sweep.

| Scenario | Rule |
| --- | --- |
| `agent_card` | JSONRPC 1.0 interface, streaming, the extension `urn:helm:a2a:episode:v1` declared `required`, `model_apis` listed. |
| `extension_required` | A request without `A2A-Extensions` fails with `-32008` and starts nothing. |
| `ingress_auth` | The JSON-RPC endpoint refuses a missing or wrong bearer; the card needs none. |
| `report_completes` | Streaming events are well formed and ordered (task, WORKING, `helm.proposal` and `helm.report` mirrors, COMPLETED, stream closes); COMPLETED comes only after `helm_work_report` was applied; the loop stops once it is. |
| `escalated_parks` (+ `_text_only`) | An escalated tool result stops the loop and ends INPUT_REQUIRED with `waiting_on.attempts`; the trap turn after it is never requested; works with and without `structuredContent`. |
| `delegate_parks_children`, `request_input_parks_input` | The other two parking rules. |
| `no_report_fails` | Ending without a report is FAILED with `NO_REPORT`. |
| `cancel_during_model_call`, `cancel_during_tool_call` | `CancelTask` is answered and the stream ends CANCELED within 10 seconds; nothing new starts afterwards; the held call is abandoned. |
| `invalid_episode`, `missing_episode`, `unsupported_model_api` | Refused with a REJECTED task and a reason code; no model or tool traffic. |
| `hallucinated_tools_are_inert` | Calls to `Bash`, `WebFetch` and other tools the model was never offered do nothing. |
| `deadline_exceeded` | The worker stops at the episode deadline (FAILED, `DEADLINE_EXCEEDED`). |
| `model_error_fails` | A provider error fails the episode with `MODEL_ERROR`. |
| `resume_via_subscribe` | The task survives a dropped client; `GetTask` and `SubscribeToTask` resume it. |

Checks that run in most scenarios: only the allowed HELM tools are offered to the model (nothing
built in, nothing provider-executed, no `mcp_servers`); the episode's model name and output-token
limit are respected; the goal and seat instructions reach the model; every call carries the
episode token; neither secret appears in the worker's A2A output or its container logs; no
egress.

## Tests of the kit itself

`make workers-test` runs the kit against a framework-free reference worker
(`reference_worker.py`) in process. Every scenario must pass, and each defect the reference
worker can be told to have (`MUTATIONS`) must be caught by the check written for it. A check that
could not fail would show up there. `make workers-conformance` also runs the kit in Docker mode
against the reference worker image, so the isolation itself is exercised.

## Adding a scenario or a check

Scenarios live in `scenarios.py` (`SCENARIOS`), checks in `checks.py`. Add the scenario to
`MANIFEST` in `tests/test_kit.py`, and a mutant to `MUTANTS` when the rule can be broken.
