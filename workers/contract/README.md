# helm.episode.v1 worker contract

The wire contract between the control plane (the A2A client) and a HELM agent worker
(the A2A server inside a sandbox). It has three parts:

| Path | What |
| --- | --- |
| `schema/` | Canonical JSON Schemas and the AgentCard template. |
| `ts/` | `@mindburn/helm-worker-contract`: TypeScript types, validators, outcome rules. |
| `python/` | `helm-worker-contract`: the same for Python, plus the A2A server glue the Python adapters share. |
| `fixtures/` | Test vectors both languages run: episodes, outcome rules, target binding, the golden prompt. |

`ts/schema/` and `python/helm_worker_contract/schema/` are copies of `schema/`.
`make workers-contract-check` fails when they drift; `make workers-contract-sync` refreshes them.

## The episode

The control plane starts an episode with A2A `SendStreamingMessage` (protocol 1.0, JSON-RPC over
HTTP with SSE):

- headers `A2A-Version: 1.0` and `A2A-Extensions: urn:helm:a2a:episode:v1`, and
  `Authorization: Bearer <HELM_A2A_BEARER_TOKEN>`;
- `message.messageId` = the episode id, `message.contextId` = the work item id;
- two parts: a text part with the goal, and a data part with media type
  `application/vnd.helm.episode.v1+json` holding a `helm.episode.v1` document
  ([`schema/episode.v1.schema.json`](schema/episode.v1.schema.json)).

The episode never contains a secret. The model gateway token is in the environment variable
named by `credentials.env` (`HELM_EPISODE_TOKEN`). A worker sends it as `Authorization: Bearer`
to `tools.mcp_url` and to the model gateway, and to nowhere else.

The worker's AgentCard ([`schema/agent-card.template.json`](schema/agent-card.template.json))
declares the extension `urn:helm:a2a:episode:v1` with `required: true`. A request without it in
`A2A-Extensions` fails with JSON-RPC error `-32008`. The extension `params` list `model_apis`,
the model APIs the adapter speaks: `anthropic-messages`, `openai-responses`,
`openai-chat-completions`.

## What the worker sends back

The stream is the A2A task lifecycle: the `task` (SUBMITTED), then `statusUpdate` and
`artifactUpdate` events, ending in one of these states, after which the stream closes.

| State | When |
| --- | --- |
| `COMPLETED` | An ordinary episode applied `helm_work_report`; a bound evaluator applied `helm_work_review` to its original target. |
| `INPUT_REQUIRED` | The episode is parked; the control plane starts a follow-on episode later. |
| `FAILED` | Reason code in the status detail (see below). `NO_REPORT` when the agent ended without an applied report. |
| `REJECTED` | The worker refused the episode before doing anything. |
| `CANCELED` | `CancelTask` was honored (within 10 seconds). |

`WORKING` updates carry a text progress message. `artifactUpdate` events named `helm.proposal`
(one per tool call) and `helm.report` (the `helm_work_report` call) are mirrors for humans and
logs: the gateway attempts and the `helm.work.report` effect are the record.

The machine-readable detail of a terminal or parked state is a `helm.episode.status.v1` document
([`schema/status.v1.schema.json`](schema/status.v1.schema.json)). It is the data part (media type
`application/vnd.helm.episode.status.v1+json`) of `status.message`, and each member except
`schema` is mirrored in the event `metadata`.

```json
{"schema": "helm.episode.status.v1", "waiting_on": {"attempts": ["att-1"]}}
{"schema": "helm.episode.status.v1", "waiting_on": {"children": ["work-9"]}}
{"schema": "helm.episode.status.v1", "waiting_on": {"input": {"question": "Which branch?", "options": ["main"]}}}
{"schema": "helm.episode.status.v1", "error": {"code": "NO_REPORT", "message": "..."}}
{"schema": "helm.episode.status.v1", "report": {"status": "done", "summary": "..."}}
```

`REJECTED` codes: `INVALID_EPISODE`, `MISSING_CREDENTIAL`, `UNSUPPORTED_MODEL_API`.
`FAILED` codes: `NO_REPORT`, `NO_REVIEW`, `EFFECT_OUTCOME_PENDING`, `MODEL_ERROR`, `TOOL_ERROR`, `MAX_TURNS`, `DEADLINE_EXCEEDED`, `INTERNAL`.

`EFFECT_OUTCOME_PENDING` means the worker stopped because a gateway effect is still
being confirmed; it does not mean the effect failed. Deploy CP support for this
code before adopting these workers: CP must retain the original execution and
escalate without automatic or ordinary manual retry. Resolving the original
attempt and authorizing subsequent work remain separate from this stop behavior.

## What the agent's tool calls mean

The rules live in `OutcomeTracker` (both languages, one set of test vectors,
[`fixtures/outcome.cases.json`](fixtures/outcome.cases.json)). Adapters feed it every MCP tool
result and stop their agent loop when it says so.

- A result `{"status": "escalated", "attempt_id": "..."}` (a non-error result, in
  `structuredContent` or as JSON text) parks the episode: `INPUT_REQUIRED` with
  `waiting_on.attempts`. The loop stops at once; nothing is retried or worked around.
- An applied `helm_work_report` (not an error, status not `denied`, `failed`, and so on) stops
  the loop and completes the episode, whatever status the report carries.
- A successful `helm_work_delegate` parks on `waiting_on.children` (the child ids named in the
  results; empty when they are not named). A successful `helm_work_request_input` parks on
  `waiting_on.input`.
- Without an uncertain effect, escalated attempts take priority over an applied report.
- A result with status `reconciling` or `unknown` stops the model and tool loop,
  even if the gateway omitted its attempt ID. The worker returns `FAILED` with
  `EFFECT_OUTCOME_PENDING`, retains any supplied attempt ID in the proposal mirror,
  and never treats an unconfirmed report as applied. This takes priority over an
  earlier report or other waiting obligations; none authorizes repeating the effect.
- An episode with `evaluation` reads its original work/report binding through its own
  `helm_work_get`. Only a succeeded `helm_work_review` of that exact target, with an
  attempt ID, matching result target, decision and reason, completes it. Terminal
  detail carries `review` instead of `report`; it is a mirror, not proof of acceptance.
  CP verifies the applied review against the original producer episode and report.
- No required completion effect and nothing parked: `FAILED` with `NO_REPORT` for
  ordinary episodes or `NO_REVIEW` for bound evaluators. A manager reviewing a
  delegated child still owes its own report; that review does not end its episode.

Deploy matching CP support before adopting the evaluation status extension; enable
agent evaluators only after the selected worker supports `evaluation`. An evaluator
needs existing get/review grants. The extension never adds report or execution grants.

### Bound targets

Before the MCP call, every tool call passes `bind_target` / `bindTarget` with the episode's
`bound_targets` / `boundTargets` (vectors: [`fixtures/binding.cases.json`](fixtures/binding.cases.json)).
The episode, not the model, fixes the target of the self-targeted work tools:

| Tool | Bound target |
| --- | --- |
| `helm_work_get`, `helm_work_report`, `helm_work_request_input` | `work:<work_item_id>` |
| `helm_org_request_capability` | `org:<organization.id>` (when the episode names one) |
| `helm_work_review`, in an episode with `evaluation` | `work:<evaluation.work_item_id>` |

A target the model left out (absent, `null` or empty) is filled in. A target that differs is
never sent: the model gets an ordinary tool error in the gateway's shape,
`{"status": "invalid", "reason_code": "SCHEMA_VIOLATION", "message": ...}`, naming only the bound
target, so it can call again; the episode goes on. The worker mirrors the refused call and posts
a `WORKING` note naming the tool and `SCHEMA_VIOLATION`. Delegation, team reads, a manager's
review of a delegated child and every other tool keep the model's target. Where an adapter lists
the tool schemas to the model itself, `bound_input_schema` / `boundInputSchema` make a bound
`target` optional and say what it is bound to (the Claude Agent SDK lists the gateway's schemas
directly, so there it stays required). The binding is the worker's: native ACP clients that
talk to the gateway directly are not covered by it.

## Choices where the contract text was open

These were decided for this lane and are pinned by the schemas and the conformance kit. The
control plane implementation must match them.

1. `model.api` is one of `anthropic-messages`, `openai-responses`, `openai-chat-completions`
   (the contract text names only the first).
2. `waiting_on.attempts` and `waiting_on.children` are arrays of id strings; `waiting_on.input`
   is `{question, options}`. One status may carry several keys; every key present must be
   satisfied before the continuation.
3. Detail travels in the status data part and is mirrored in `metadata` (see above).
4. The secret the control plane presents to the worker is `HELM_A2A_BEARER_TOKEN`, sent as
   `Authorization: Bearer`. A worker refuses to start without it. The AgentCard and nothing else
   is served without it.
5. The JSON-RPC endpoint is `POST /`; the card is at `/.well-known/agent-card.json`. Its interface
   URL is `HELM_A2A_PUBLIC_URL` when set, else built from the request's `Host` header.
6. `model.base_url` has no `/v1` suffix; each client appends its API path.
