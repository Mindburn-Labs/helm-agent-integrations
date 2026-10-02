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
at `7394a3bf18b58b13153ff9f677722a7b45145eba`, including the exact contract and
schema hashes. Its [published contract](https://github.com/Mindburn-Labs/helm-agent-integrations/blob/7394a3bf18b58b13153ff9f677722a7b45145eba/executors/core/CONTRACT.md)
supersedes the earlier provisional adapter payload. Runtime qualification
remains separate from source presence and hash readback.

## Supported configuration

The initial schema review used Codex CLI 0.159.2 help/binary symbols and the
official OpenAI source. The current ChatGPT-bundled binary is
`0.159.0-alpha.12.1`; [installed-client.json](installed-client.json) records its
read-only inspection and digest. Installed parsing/hooks and live QA require
separate qualification. The source references are:

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
`checkout <work-item-id> --client codex` in the Codex slot, using the CP work
item UUID. CP permits one live episode per work item: T100 calls `stop` in the
first session before `checkout` in the second. CP can return 409 until the old
token has expired and retained attempts are read back. Shared core offers
`checkout --wait <seconds>` for that bounded wait; a refused refresh or stop
keeps the unresolved binding. A device login does not enroll a
machine credential for a seat; enrollment is a separate server-authorized
prerequisite, and checkout rejects missing authority. The adapter never reads
or writes core state files. Use `HELM_EXECUTOR_OBSERVE_SUMMARY=off` when the
managed session should omit summaries; core still owns input digests.

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

### Local core integration

[integration-conformance.mjs](integration-conformance.mjs) invokes the actual
built core CLI through the rendered provider, MCP header and hook commands.
It uses core's `startFakeCp`, `dropResponse` and `runGovernedFlow`, stops a first slot, checks
an injected 409 hold, and checks out Codex in a second slot. It drops a real
loopback MCP connection after the shared fake applies a branch effect, then
retries and reads back the same attempt from a different episode and MCP
session. Raw tools are tested through the deny hook without executing them.
Original Pre/Post JSON is piped to core and the fake sink is read back; rejected
observations retain zero exit and no delivery claim.

The parent builds core from the pinned checkpoint and runs this finite command
with Node 22+ and Python 3.11+. Supply the core directory explicitly. The report
path must be new; the runner never installs or builds anything itself.

```sh
node executors/codex/integration-conformance.mjs \
  --core /absolute/qualified-checkout/executors/core \
  --report /tmp/helm-codex-local-integration.json \
  --timeout-ms 45000
```

The report covers local contract integration. The shared fake does not model
the native stopped-token/retained-attempt drain barrier; the injected 409 only
checks consumer refusal and retry. Its effect application count proves the
fake's replay behavior. Installed Codex hook execution, public TLS/network
posture, signed D24 audience/client/TTL admission, native Kernel D8 UNKNOWN
reconciliation and deployed CP E1 remain separate gates. D24 expects
`aud=helm-gateway-executor:<env>`, signed `helm_executor={client}` and the
existing `helm_episode`, with a lifetime of at most 900 seconds. The adapter
continues to treat the shared credential as opaque.

### Installed client probe

[installed-client.json](installed-client.json) records read-only inspection of
the current ChatGPT-bundled CLI, version `0.159.0-alpha.12.1`, and its binary
digest. [client-conformance.mjs](client-conformance.mjs) prepares a finite
acceptance run for that exact binary. The parent runs it with the pinned built
core, Node 22+ and Python 3.11+:

```sh
node executors/codex/client-conformance.mjs \
  --core /absolute/qualified-checkout/executors/core \
  --report /tmp/helm-codex-installed-client.json \
  --timeout-ms 60000
```

The runner creates private `HOME`, `CODEX_HOME`, work and core-state directories.
It checks strict configuration through the documented app-server read RPCs,
then uses local Responses SSE fixtures to request one allowed command and five
raw commands. Local sentinel executables catch an unexpected raw dispatch.
The actual provider/header helpers and observation commands consume shared
core. An extra QA hook captures the same client payload for sink correlation.
The runner deletes its temporary files and writes one new report.

This probe copies the template commands into disposable user hooks and uses the
documented automation hook-trust flag for these reviewed sources. It requires
macOS `sandbox-exec`, permits loopback traffic and denies writes outside its
temporary directory. It uses no model inference or real credentials.

The [managed configuration documentation](https://learn.chatgpt.com/docs/enterprise/managed-configuration)
locates Unix requirements at `/etc/codex` or managed policy. `CODEX_HOME` isolates
the user layer. The probe refuses non-null host requirements and reports managed
configuration/provenance as `NOT_RUN`. Acceptance of `requirements.toml` needs a
dedicated execution environment with its own system or managed policy. Ivan's
profile and host configuration must not be used to install these templates.
