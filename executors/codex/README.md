# Local managed Codex executor

This HELM-compatible adapter prepares a dedicated local Codex executor to use
the HELM model gateway and MCP edge. It renders configuration for review,
shapes the shared core token into MCP headers, and implements a PreToolUse
hook with local denies and observed-only metadata. It does not install policy
or open an episode. Codex Cloud is outside this adapter's G0 scope.

`executors/core` owns `helm-executor login`, `start --work`, `token`, `switch`
and `stop`, device credentials, the 15-minute episode token, and refresh. CP
owns episode state and observation ingestion. The gateway owns admission,
effects, credentials, receipts and D8 effect identity. The adapter neither
dispatches effects directly nor treats a hook as a gateway decision.

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
It is not a shell string containing `helm-executor token`. The token helper
runs again after at most five minutes. MCP `http_headers_helper` is a local
command that prints a JSON map of header names to values; `mcp_headers.py`
calls the same core `token` command each time. Explicit bearer tokens and
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
and core executable. The example paths and hostname below are illustrative.

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

## Shared observation seam

The core owner must approve an observation helper argv and its payload before
live use. Pass that argv as JSON through renderer `--observer-argv`. The hook
invokes it directly with metadata JSON on stdin, without a shell, and with a
three-second timeout. Without a sink, the hook reports that the observation
was not submitted; local deny decisions still stand. A successful helper
exit is labelled submitted, and is not proof of CP persistence.

The provisional `helm.executor.codex.observation.v1` envelope contains the
client, observed-only coverage, event and tool names, session/turn/tool-call
correlation ids, a SHA-256 digest of the tool input, and the local deny/observe
decision. It omits raw tool input, prompts, transcripts and credentials. Core
binds the active work item and episode; hook correlation ids never replace the
shared D8 effect identity. The sink's accepted command, envelope mapping and
CP response are dependency needs until source-qualified.

The hook denies common raw command forms, including git/gh global flags and
shell wrappers, plus direct Linear MCP writes. Exec rules independently deny
the direct command prefixes. These controls are convenience coverage labelled
observed-only: shell aliases, scripts, tool paths and hook failures require
the gateway credentials and actual network restriction for enforcement.

## Qualification

The root coordinator owns all local test/build/QA jobs. The focused source
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
