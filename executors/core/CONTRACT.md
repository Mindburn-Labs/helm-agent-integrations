# helm-executor core contract (v1)

Status: v1, written 2026-10-01 by claude:executor-adapters (HELM-910) and agreed
with codex:cp-org on 2026-10-02 for the executor and observation routes. The
code in `executors/core/` implements this file. If the two disagree, the code is
wrong; open an issue on the lane instead of working around it.

`helm-executor` is the one auth and observation client for every HELM executor
front-end (Claude Code, Codex, later the OCE plugin). Adapters call it as a
subprocess. They hold no credential, parse no token and carry no copy of the
device-code flow.

What it is not: it makes no model call, writes nothing to GitHub or Linear, and
decides nothing. The kernel gateway is the authority. Everything `observe`
sends is observed-only.

## 1. Surface

| Command | Used by |
|---|---|
| `helm-executor token` | Claude Code `apiKeyHelper`; Codex provider `auth.command` |
| `helm-executor headers` | Claude Code MCP `headersHelper`; Codex `http_headers_helper` |
| `helm-executor observe --client <c> --event <e>` | client hooks, on stdin |
| `helm-executor login --cp-url <url> [--org <org-id>]` | a person, once per machine |
| `helm-executor checkout <work-item-id> --client <c> [--org <org-id>] [--json]` | launcher or agent |
| `helm-executor stop [--local]` | launcher or agent |
| `helm-executor status [--json]` | people, installers, conformance |
| `helm-executor env [--format shell\|json]` | launchers |

All of these are stable in v1.

Every command is a plain subcommand. It works as `command` plus `args` with no
shell, from any working directory and with a minimal environment (only `HOME`
is needed). Only `observe` reads stdin.

`<c>` is `claude-code`, `codex` or `openclaw` for `checkout`, and `claude-code`
or `codex` for `observe`. `<e>` is `PreToolUse` or `PostToolUse` for both
clients. Claude Code may also send `PostToolUseFailure`; both may send
`SessionStart` and `SessionEnd`.

The binary needs Node 22 or later. The adapter installers decide where it is
installed and write an absolute path into the client configuration.

## 2. Rules for every command

**Output.** Stdout carries data only. Human messages go to stderr. No command
prints a credential except `token` and `headers`, and they print nothing else
on stdout. No command writes a credential to a log or to stderr.

**Failure line.** On failure a command prints one line to stderr and nothing to
stdout:

```text
helm-executor: <code>: <short reason>
```

The reason is under 200 characters and carries no credential.

**Exit codes.**

| Exit | `<code>` | Meaning |
|---|---|---|
| 0 | | success |
| 1 | `internal` | unexpected failure |
| 2 | `usage` | bad flag or argument. Never returned by `observe` |
| 3 | `not_logged_in` | no machine credential, or the control plane refused to refresh it |
| 4 | `no_episode` | nothing is checked out in this slot |
| 5 | `episode_ended` | the episode was stopped, has expired or is past its deadline |
| 6 | `unavailable` | the control plane could not be reached, or answered 429 or 5xx. Retry later |
| 7 | `rejected` | the control plane answered another 4xx. Retrying will not help |

**Environment.**

| Variable | Meaning |
|---|---|
| `HELM_EXECUTOR_HOME` | state directory, default `~/.config/helm-executor`, mode 0700 |
| `HELM_EXECUTOR_CP_URL` | control plane origin. Overrides the stored one. `https`, or `http` on loopback only |
| `HELM_EXECUTOR_ORG` | organization id. Overrides the stored one |
| `HELM_EXECUTOR_CLIENT` | default for `--client` |
| `HELM_EXECUTOR_SLOT` | slot name, default `default`, pattern `^[a-z0-9][a-z0-9_-]{0,31}$` |
| `HELM_EXECUTOR_OBSERVE_SUMMARY` | `off` drops `tool.input_summary` from observations. Default `on` |
| `HELM_EXECUTOR_DEBUG` | `1` adds diagnostics to stderr. Never a credential |

**Slots.** One slot holds one checked-out episode. Sessions that run at the same
time on one machine must use different slots, so a launcher sets
`HELM_EXECUTOR_SLOT` once and every helper in that session inherits it. The
machine credential is shared by all slots. The control plane allows one live
episode per work item, so changing executor on a work item (T100) is `stop` in
the first session, then `checkout` of the same work item from the second.

**State.** Machine credential and episode state live under
`HELM_EXECUTOR_HOME` in files of mode 0600, written atomically. Callers must
not read or write them. There is no keychain backend in v1.

**Concurrency.** Any number of invocations may run at once in one slot. They
serialize the refresh steps with a lock file, so a rotating refresh token is
used once.

**No redirects.** The client never follows an HTTP redirect, so a bearer token
never goes to a host other than the configured one.

## 3. `token`

```text
$ helm-executor token
<opaque bearer token>
```

- Stdout is the token, then exactly one LF. No label, no other line.
- Exit 0 means the token has at least 120 seconds of validity left at the moment
  it is printed. Normally it is freshly minted, about 15 minutes. In the last 120
  seconds before the episode deadline the token is valid until the deadline
  instead.
- Exit non-zero means nothing was written to stdout. The exit code and stderr
  line follow section 2. In particular: no episode checked out is exit 4;
  stopped, expired, past the deadline or refused as gone by the control plane is
  exit 5; no usable machine credential is exit 3.
- Each call mints a new token from the control plane, with one exception: a
  token minted in this slot less than 15 seconds ago is returned as it is, so
  helpers that start together get the same one.
- If the control plane is unreachable or answers 429 or 5xx, and the slot holds
  a token with at least 120 seconds left, that token is printed. Otherwise exit
  6.
- The call finishes or fails within 8 seconds. Claude Code gives up on an MCP
  `headersHelper` after 10 seconds.
- The token is opaque. Callers must not parse it or cache it past the
  invocation.

Claude Code: `"apiKeyHelper": "<abs>/helm-executor token"`. Codex:
`command = "<abs>/helm-executor"` with `args = ["token"]`.

## 4. `headers`

```text
$ helm-executor headers
{"Authorization":"Bearer <opaque bearer token>"}
```

- Stdout is one JSON object on one line, then LF. In v1 it has exactly one key,
  `Authorization`. Treat the object as an opaque header map; keys may be added in
  a v1 minor release.
- Success, failure, exit codes, freshness and the 8 second cap are the same as
  for `token`.

## 5. `observe`

Exact invocations:

```text
helm-executor observe --client claude-code --event PreToolUse
helm-executor observe --client claude-code --event PostToolUse
helm-executor observe --client codex --event PreToolUse
helm-executor observe --client codex --event PostToolUse
```

The hook JSON goes to stdin unchanged.

**Never blocks.**

- It always exits 0, including on a bad flag, malformed stdin, no episode, no
  credential, a network error or a rejected post. Exit 2 would block a tool call
  in both clients, so it is never used.
- It writes nothing to stdout.
- It finishes within 5 seconds, including a possible refresh of the machine
  access token. The post has a 3 second timeout and is not retried.
- Hook config should run it with `async: true` where the client supports that.
- A failure is one line on stderr in the section 2 format, which clients send to
  their debug log, and an entry in the slot's observe record, which `status`
  shows. Nothing else happens. Observations are lossy by design.
- Deny is not done here. It is done by the static deny rules in the adapter
  configuration.

**No episode, no post.** With nothing checked out in the slot, `observe` exits 0
and posts nothing. The post carries `episode_id` and `work_item_id` from the
checked-out episode, never from the hook input.

**Stdin envelope.** [schema/observe-input.schema.json](schema/observe-input.schema.json)
is the schema. Unknown fields are ignored. Input over 8 MiB is skipped.

| Field | Claude Code | Codex | Read for |
|---|---|---|---|
| `session_id` | yes | yes | `session_id` |
| `hook_event_name` | yes | yes | event, only when `--event` is absent |
| `tool_name` | yes | yes | `tool.name`, and `tool.mcp_server` when it has the form `mcp__<server>__<tool>` |
| `tool_input` | yes | yes | `tool.input_digest`, `tool.input_summary` |
| `tool_use_id` | yes | yes | `tool.use_id`, the idempotency key |
| `tool_response` | Post events | PostToolUse | nothing. Never sent |
| `duration_ms` | PostToolUse | no | `tool.duration_ms` |
| `permission_mode` | yes | yes | `permission_mode` |
| `agent_id`, `agent_type` | in a subagent | in a subagent | same names |
| `prompt_id` | yes | no | `prompt_id` |
| `mcp_server.name` | 2.1.274 and later | no | `tool.mcp_server`, wins over the parsed name |
| `turn_id` | no | yes | `turn_id` |
| `cwd` | yes | yes | the path summary of file tools only. Never sent on its own |
| `transcript_path`, `model`, `effort` | yes | yes | nothing |

**What is posted.** `POST {ORG}/observations`, where `{ORG}` is
`/api/v1/workspaces/{workspace_id}/organizations/{org_id}`:

- `Authorization: Bearer <machine access token>`. This is the device-code
  access token, not the episode token. It is refreshed under the lock when it
  is about to expire.
- `Content-Type: application/json`.
- `Idempotency-Key: obs-<32 hex>`, the first 32 hex digits of
  SHA-256(`episode_id|event|tool_use_id`). Sent only when `tool_use_id` is
  present.
- Body: [schema/observation.schema.json](schema/observation.schema.json).

```json
{
  "schema": "helm.executor.observation/v1",
  "coverage": "observed-only",
  "client": "claude-code",
  "event": "PostToolUse",
  "observed_at": "2026-10-08T12:00:00.000Z",
  "episode_id": "6f1c2c1e-2d63-4a39-93a5-6d8c9a3b2e10",
  "work_item_id": "0b6f1d52-3c3e-4a77-9d0f-5f2c7a1e8b34",
  "session_id": "abc123",
  "tool": {
    "name": "Bash",
    "use_id": "toolu_01ABC",
    "phase": "after",
    "input_digest": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "input_summary": "git status --short",
    "duration_ms": 12
  }
}
```

- `coverage` is always `observed-only`. The control plane stores it as such and
  must not present it as enforcement.
- `tool.phase` is `before`, `after` or `failed`. `tool_response` is never
  inspected, so no success or failure is inferred from it.
- `tool.input_digest` is SHA-256 of `tool_input` as JSON with object keys sorted
  and no whitespace.
- `tool.input_summary` is optional and at most 256 characters. Bash: the
  command on one line. Read, Edit, Write, MultiEdit, NotebookEdit and
  apply_patch: the path. Every other tool: omitted. Credential-shaped strings
  are replaced with `[redacted]`; this is best effort, not a guarantee. Set
  `HELM_EXECUTOR_OBSERVE_SUMMARY=off` to drop the field.
- Never sent: file contents, tool output, prompts, the transcript, the
  environment, the working directory.
- A 2xx response is delivery. Anything else is dropped and recorded.

## 6. `login`, `checkout`, `stop`, `status`, `env`

**`login`.** Device-code authorization against the control plane's
`/api/v1/auth/device/*` routes. It prints the verification URL and user code to
stderr and polls. It stores the machine credential (access token, refresh token)
and the control plane URL, and the organization id when `--org` is given. It
never prints a token. A person runs it once per machine. It proves the machine
credential and nothing more: it never enrolls the credential for a seat.
Enrollment is server side. The organization owner, or a member with seat
management authority over the team, enrolls the credential with step-up. A
credential with no enrollment for the work item's seat gets 403 at `checkout`,
which is exit 7.

**`checkout <work-item-id>`.** Creates an executor episode for the work item and
stores it in the slot, with its deadline. `--client` is required unless
`HELM_EXECUTOR_CLIENT` is set. The organization comes from `--org`, then
`HELM_EXECUTOR_ORG`, then the stored one. A second `checkout` of the same work
item in the same slot is a no-op that reports the existing episode, unless that
episode is past its deadline, in which case it creates a new one. A different
work item in an occupied slot is exit 2. `<work-item-id>` is the work item's id
as the control plane knows it, a UUID. Stdout is one human line, or with
`--json`:

```json
{"schema":"helm.executor.checkout/v1","episode_id":"…","work_item_id":"…","client":"claude-code","slot":"default","deadline":"2026-10-08T13:00:00Z","reused":false}
```

It never prints the token.

**`stop`.** Stops the slot's episode at the control plane and clears the slot.
The control plane answering that the episode is already ended counts as success.
`--local` clears the slot without contacting the control plane. Exit 0 with
nothing to do when the slot is empty.

**`status`.** Prints state without secrets. With `--json`:

```json
{
  "schema": "helm.executor.status/v1",
  "logged_in": true,
  "workspace_id": "…",
  "cp_url": "https://…",
  "slot": "default",
  "episode": { "episode_id": "…", "work_item_id": "…", "client": "claude-code", "deadline": "…", "seconds_left": 3120, "ended": null },
  "observe": { "last_ok_at": "…", "last_error_at": null, "last_error": null }
}
```

`episode` is `null` when the slot is empty. `ended` is `null` for a live episode and the reason once the control plane has said the episode is gone.

**`env`.** Prints the OpenTelemetry resource attributes for the slot's episode,
for a launcher to export before it starts the client:

```text
OTEL_RESOURCE_ATTRIBUTES=helm.work_item_id=0b6f1d52-3c3e-4a77-9d0f-5f2c7a1e8b34,helm.episode_id=…,helm.executor=claude-code
```

An existing `OTEL_RESOURCE_ATTRIBUTES` in the environment is kept and extended.
`--format shell` prints `export …`; `--format json` prints an object. Exit 4
when the slot is empty.

## 7. Control plane wire contract

These are the calls the client makes. The device-code routes exist today in the
control plane (`internal/deviceauth/service.go`, origin/main `c69c338`). The
executor and observation routes were agreed with codex:cp-org on 2026-10-02 and
are not merged yet; when its OpenAPI is published it replaces this table. The
client keeps the routes in one file, `src/contract.ts`; changing them is a
one-file change.

| Call | Auth | Request | Success |
|---|---|---|---|
| `POST /api/v1/auth/device/code` | none | `{"client_name","client_type":"cli"}` | 201 `{device_code,user_code,verification_uri,verification_uri_complete,expires_in,interval}` |
| `POST /api/v1/auth/device/token` | none | `{"grant_type":"urn:ietf:params:oauth:grant-type:device_code","device_code"}` | 200 `{token_type,access_token,expires_in,refresh_token,refresh_expires_in,scope,credential_id,subject,workspace_id}`; 400 `authorization_pending`, `slow_down`, `expired_token`, `invalid_grant` |
| `POST /api/v1/auth/device/refresh` | none | `{"grant_type":"refresh_token","refresh_token"}` | same body as the token call. The refresh token rotates |
| `POST {ORG}/work-items/{work_item_id}/executor-episodes` | machine | `{"client","idempotency_key"}` | 201 `{episode_id,work_item_id,token,token_expires_at,deadline}` |
| `POST {ORG}/work-items/{work_item_id}/executor-episodes/{episode_id}/token` | machine | `{}` | 200 `{token,token_expires_at}`. `expires_in` seconds is accepted in place of `token_expires_at`, and the create body also fits |
| `POST {ORG}/work-items/{work_item_id}/executor-episodes/{episode_id}/stop` | machine | `{}` | 200 or 204 |
| `POST {ORG}/observations` | machine | [observation](schema/observation.schema.json) | 202 |

`machine` is `Authorization: Bearer <access_token>` from the device-code flow.
`token` is the episode token the gateway accepts on `/v1/*` and `/mcp`.
`token_expires_at` and `deadline` are RFC 3339 timestamps.

Status mapping, which decides the exit code:

| Response | Meaning |
|---|---|
| 401 on a `{ORG}` call | the access token expired or was revoked. The client refreshes once and retries once. A refresh refused with `invalid_grant` is `not_logged_in` |
| 410 on `…/token` | the episode was stopped or has expired: `episode_ended` |
| 404 or 409 on `…/token` | the episode is not ours, or is gone: `episode_ended` |
| 404, 409 or 410 on `…/stop` | already ended, or not ours; success |
| 403 on `checkout` | no authority: the credential is not enrolled for the seat. `rejected` |
| 409 on `checkout` | the work item already has a live episode. `rejected` |
| 403, or any other 4xx | `rejected` |
| 429, 5xx (503 is the usual one), a timeout or a network error | `unavailable` |

Error bodies may be `{"error","error_description"}` (device-code routes) or
`{"error","message","code"}` (console routes). The client prints a redacted,
truncated message from either.

Identity, as the control plane keeps it. The episode token's `sub` and the
episode's actor are `agt:<seat>`, the seat the machine credential is enrolled
for. `executor:<client>` is stored separately as provenance. `client` in the
create body is `claude-code`, `codex` or `openclaw`. Machine authorization on
`POST {ORG}/observations` is the machine access token, as `observe` sends it.

## 8. Fake server for adapter tests

`dist/testing/fake-cp.js` implements the device-code routes and the four `{ORG}`
routes above with the same status codes, plus `GET /healthz`. It checks bearer
tokens, rotates refresh tokens and expires tokens on an injectable clock.

- Library: `startFakeCp(options)` returns `{ url, orgId, workspaceId, requests, close }`.
  `options.routes` adds client-specific routes, such as a model endpoint.
- Process: `node dist/testing/serve.js [--port N]` prints one JSON line on
  stdout, `{"cp_url":"…","org_id":"…","workspace_id":"…"}`, then serves until
  SIGTERM. The first device-code poll is pending and the second is approved.

## 9. Change control

- Within v1 changes are additive: new commands, new optional fields, new keys in
  the `headers` object, new events and clients. Nothing documented here changes
  meaning.
- A breaking change is v2 with a new schema `$id`, announced in lane
  `executor-adapters` field `core_contract` before it merges.
- Not in v1: a keychain backend, Windows, deny logic in hooks, per-tool
  filtering inside `observe`.
