# Local managed Codex executor

This HELM-compatible adapter prepares a dedicated local Codex executor to use
the HELM model gateway and MCP edge. It renders configuration for review and
wires shared core commands into provider auth, MCP headers and observed-only
hooks. A separate PreToolUse hook handles local denies. Codex Cloud is outside
this adapter's G0 scope.

`executors/core` owns `helm-executor login`, `checkout`, `token`, `headers`,
`observe`, `stop`, `status` and `env`, device credentials, the 15-minute episode
token, and refresh. CP owns episode state and observation ingestion. The
gateway owns admission, effects, credentials, receipts and D8 effect identity.
Hooks are observations; gateway admission authorizes effects.

[core-contract.json](core-contract.json) pins the shared CLI and fake CP source
at `83f82bced4f0e405fb762843a3c3dd5f2c974a35`, including the exact contract and
schema hashes. Its [published contract](https://github.com/Mindburn-Labs/helm-agent-integrations/blob/83f82bced4f0e405fb762843a3c3dd5f2c974a35/executors/core/CONTRACT.md)
supersedes the earlier provisional adapter payload. Runtime qualification
remains separate from source presence and hash readback.

## Supported configuration

The implementation was checked against installed Codex CLI 0.159.2 help and
binary field symbols, then the official OpenAI source and documentation.
Installed-client parsing and live QA still require qualification in the
dedicated environment. The source references are:

- [Provider token command](https://github.com/openai/codex/blob/d91294c39edb93d204926b33f21310dc968edc34/codex-rs/protocol/src/config_types.rs)
- [Admin requirements](https://github.com/openai/codex/blob/d91294c39edb93d204926b33f21310dc968edc34/codex-rs/config/src/config_requirements.rs)
- [Managed hook shape](https://github.com/openai/codex/blob/d91294c39edb93d204926b33f21310dc968edc34/codex-rs/config/src/hook_config.rs)
- [MCP transport shape](https://github.com/openai/codex/blob/d91294c39edb93d204926b33f21310dc968edc34/codex-rs/config/src/mcp_types.rs)
- [Config schema](https://github.com/openai/codex/blob/d91294c39edb93d204926b33f21310dc968edc34/codex-rs/core/config.schema.json)
- [Managed configuration](https://learn.chatgpt.com/docs/enterprise/managed-configuration) and [Codex hooks](https://learn.chatgpt.com/docs/hooks)

Provider `auth.command` is an executable path with `args = ["token"]`.
It is not a shell string containing `helm-executor token`. The provider refresh
interval is five minutes and its 10-second timeout covers core's eight-second
budget. Core prints only the opaque bearer plus LF on success. Missing,
stopped or expired state returns nonzero, empty stdout and a reason on stderr.
The adapter does not parse or cache credentials.

MCP `http_headers_helper` calls `helm-executor headers` directly. Core prints an
opaque JSON map, including any future header keys. Explicit bearer tokens and
OAuth credentials must be absent because they take precedence over that
helper's Authorization header.

The requirements pin the complete `helm` provider definition and the approved
HELM MCP URL, enable managed hooks, forbid the unrestricted sandbox, and
activate the managed network proxy with an exclusive edge hostname allowlist.
The network policy denies all sandbox connections to direct GitHub, Linear
and provider hosts, including reads. Dependency-download hosts must receive a
separate controller-approved network policy if needed. The proxy controls
sandboxed commands; it does not filter hosted tools, apps or MCP requests.
Actual gateway custody and network behavior require independent runtime proof.

## Render for review

Python 3.11 or later is required for the renderer. Supply the controller's
TLS edge origin, installed admin-owned adapter directory, Python interpreter
and core executable. Shared core needs Node 22 or later. The example paths and
hostname below are illustrative.

```sh
python3 executors/codex/render.py \
  --edge https://executor.qa.example \
  --adapter /opt/helm/executors/codex \
  --executor /opt/helm/bin/helm-executor \
  --python /opt/helm/bin/python3 \
  --output /tmp/helm-codex-policy-review
```

The output directory must be new. Rendering to `.codex` or `/etc/codex` is
refused. The renderer writes `config.toml`, `requirements.toml` and
`helm.rules` only; a managed deployment must separately distribute the
admin-owned scripts and read back the effective policy. The templates do not
select a model, reasoning effort or approval mode. Never apply this package
to the owner's interactive app or configuration.

## Shared commands and observations

The managed requirements declare two PreToolUse commands: a synchronous local
deny hook, then `helm-executor observe --client codex --event PreToolUse` with
`async = true`. PostToolUse runs the corresponding shared observation command
asynchronously. Codex supplies each command the original hook stdin JSON. The
adapter creates no observation envelope and does not re-encode that input.
Installed-client qualification must verify that the effective managed hooks
receive that input and only the synchronous local hook supplies a deny.

Core binds the checked-out work item and episode, minimizes the posted payload,
applies best-effort redaction, and exposes failure diagnostics in `status`. Its `observe`
command always exits zero with empty stdout, including when nothing is posted.
An exit code cannot establish CP delivery or persistence. The local deny hook
returns only its permission decision and makes no delivery claim. Observed
hook correlation never replaces the shared D8 effect identity.

A launcher must assign a distinct `HELM_EXECUTOR_SLOT` to every concurrent
session and preserve it for provider, MCP and hook helpers. The config retains
the shared core environment variables, including `HELM_EXECUTOR_HOME`. Use
`checkout <work-item-id> --client codex` in the Codex slot. T100 switches clients
by checking out the same work item in another slot. The adapter never reads or
writes core state files. Use `HELM_EXECUTOR_OBSERVE_SUMMARY=off` when the managed
session should omit summaries; core still owns input digests.

The hook denies common raw command forms, including git/gh global flags and
shell wrappers, plus direct Linear MCP writes. Exec rules independently deny
the direct command prefixes. These controls are convenience coverage labelled
observed-only: shell aliases, scripts, tool paths and hook failures require
the gateway credentials and actual network restriction for enforcement.

D22 limits Wave 1 to the named Claude Code adapter, Codex adapter and one
release rehearsal session: two or three sessions in total through gateway API
keys. Other sessions remain on subscriptions. Under D23, acceptance follows
dependency availability: local contract fake plus edge smoke, real CP E1 QA,
integrated QA with both adapters, then rehearsal. Dates are latest markers.

## Qualification

The root coordinator owns local test/build/QA jobs. The focused source
commands to run from the owning worktree are:

```sh
python3 -m unittest discover -s executors/codex/tests -v
ruby scripts/check-markdown.rb
```

After rendering, `verify_schema.py --config PATH --schema PATH` requires
`jsonschema` and the pinned OpenAI config schema. That check covers
`config.toml`; the requirements shape must also be parsed by the installed
Codex client in the managed QA environment. The repository's native gate
remains `make check`.

[qa-contract.json](qa-contract.json) defines the unrun T48/T87/T97/T100/T103
acceptance work and shared D8 lost-response scenario. It contains no runtime
results. Qualification needs the E1 CP API, the executor edge, shared core,
gateway MCP/effects, managed-config readback and exact deployed build digests.
Synthetic local tests cannot substitute for those observations.

The command fixture in `tests/` captures stdin and returns synthetic headers
without credentials or network access. It checks command quoting, unchanged
input and separation of deny from observe. It implements no CP or auth flow
and cannot substitute for the actual shared core fake CP or the executor edge.
