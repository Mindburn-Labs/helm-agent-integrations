# HELM executor adapter for Claude Code

A Claude Code session that works as a HELM executor: its model calls and its
external actions go through the HELM kernel gateway, authenticated with a
15-minute episode token for one work item. This directory holds the Claude Code
configuration, the installer and an adapter conformance run. Login, checkout,
tokens and hook reports are in [executors/core](../core/README.md); the contract
between the two is [executors/core/CONTRACT.md](../core/CONTRACT.md).

Everything here follows the G0 plan's rule E2: credentials live only in the
gateway, and client-side hooks and deny rules are a convenience, not enforcement.
The tables below say which is which.

## What is enforced and what is observed

| Action | Control | Level |
|---|---|---|
| Model calls | `ANTHROPIC_BASE_URL` pinned to the executor edge, `apiKeyHelper` = `helm-executor token`, `allowedProviders: ["customEndpoint"]`. The gateway holds the provider key | enforced by the gateway; the managed file stops a session being re-pointed |
| GitHub, Linear and deploy writes | HELM MCP tools only (`managed-mcp.json`, `allowManagedMcpServersOnly`). The gateway holds the tokens | enforced by the gateway |
| Raw `git push`, `gh pr merge`, `kubectl`, `flux`, Linear write tools, `WebSearch`, `WebFetch` | `permissions.deny` rules | convenience: Claude Code documents Bash rules as not a security boundary. `git -C . push`, `/usr/bin/git push` and `sh -c '…'` get past them. Without a credential the call fails anyway |
| Reading the machine credential in `~/.config/helm-executor` | `Read` and `Edit` deny rules on that directory | convenience, and weaker than the rows above: the rules cover Claude's file tools and a few file commands it recognizes (`cat`, `head`, `sed`), not `base64`, `cp`, `tar` or a script. The control is the file mode (0600, directory 0700, one OS user) and revocation at the control plane. The gateway is not a second line here: a stolen refresh token mints episodes for the enrolled seat until the credential is revoked |
| What the session did | `observe` hooks on Bash, file edits, subagents, MCP calls and session start and end | observed-only. Lossy by design; nothing in it proves enforcement. A Bash call is reported as its shape (`git push origin`), never its arguments |
| Active time | OpenTelemetry metrics, see below | observation |

Not covered here: other raw writes such as `gh pr create` or `gh api`, and
`curl` to a provider API. They fail for lack of a credential, and GitHub
rulesets are the second line.

To make the credential directory unreadable for Bash commands at the operating
system level, Claude Code's sandbox has a documented layer: `sandbox.enabled:
true` with `sandbox.credentials.files` holding `{ "path":
"~/.config/helm-executor", "mode": "deny" }`. It narrows what every Bash command
can do (writes outside the working directory, network), so this profile does not
turn it on and it has not been exercised here. With it on, run `helm-executor
checkout` and `stop` from the launcher, not from the session. Keep an executor
host single-purpose, and do not export OTLP headers for another collector on it.

## Profiles

**Managed, for executor hosts.** `install.mjs managed` writes, machine-wide:
`helm-executor` under the prefix, a managed-settings drop-in
`managed-settings.d/50-helm-executor.json`, and `managed-mcp.json`. Claude Code
applies managed settings to every session on the machine and nothing a user or
`--settings` file sets can override them. That includes the owner's own
interactive sessions, so install this only on a machine that runs executors and
nothing else. With `--otel-endpoint` it adds `60-helm-executor-otel.json`.

```bash
(cd ../core && npm ci && npm run build)         # the installer copies core's build
sudo node src/install.mjs managed --node "$(command -v node)" \
  --edge-url https://<executor edge> --cp-url https://<control plane> --org <org id> \
  --otel-endpoint https://<collector>            # optional
# review the plan, then add --yes
```

The installed `helm-executor` wrapper pins the Node that is named by `--node`
(default: the one running the installer). Name a system Node on a host that other
users share.

Nothing is written without `--yes`. The installer refuses to overwrite a file it
did not write, refuses a Claude Code older than 2.1.285 (the policy would lock it
out), and after installing runs the pieces the way Claude Code will: the wrapper,
the `apiKeyHelper` and `headersHelper` command lines against an empty state
directory (they must fail closed with nothing on stdout), and the observe hook.
`uninstall` removes only what the manifest lists, only inside the installer's own
locations (the library directory, the wrapper and the three policy files), and
keeps anything edited since.
Then, as each executor user, `helm-executor login --cp-url …`, start Claude Code
and run `/status`: the setting sources line must show the managed settings file.
A macOS MDM profile for Claude Code ranks above the file and hides it.

**Session, for a shared machine.** Managed settings cannot be scoped to one
session or one user. On a machine where the owner's own sessions must stay on a
subscription, render the same content for one session:

`--helm-executor` is the absolute path of any executable that runs the core CLI, for
example a two-line script, `#!/bin/sh` then `exec node <repo>/executors/core/dist/cli.js "$@"`.

```bash
node src/install.mjs session --out ~/helm-session --edge-url … --cp-url … --org … \
  --helm-executor ~/bin/helm-executor
export HELM_EXECUTOR_SLOT=cc-1
helm-executor checkout <work-item-id> --client claude-code
eval "$(helm-executor env --format shell)"        # work item on the telemetry attributes
claude --settings ~/helm-session/settings.json --mcp-config ~/helm-session/mcp.json --strict-mcp-config
```

It writes two files into `--out` and nothing else. It lacks the managed-only keys
(`allowedProviders`, `allowManaged*Only`, `requiredMinimumVersion`), so it does not
stop a session being re-pointed; the credentials in the gateway still do.

**Owner telemetry, opt-in.** `install.mjs owner-otel --otel-endpoint … --yes` adds
six telemetry variables to the `env` block of the owner's own Claude Code settings,
backs the file up, refuses to overwrite a value, to edit a file that is not JSON,
or to touch one that already carries OTLP headers, client keys or an
`otelHeadersHelper` (they would follow the endpoint to the HELM collector), and
`--remove` undoes it. No other command writes to a user's settings. A test
runs every command against a sentinel settings file and checks it is unchanged.

## Starting a session

Check the work item out before Claude Code makes its first model call. Until an
episode exists `apiKeyHelper` fails closed, so a `claude -p` run started without one
stops at its first request with "Your apiKeyHelper script is failing". An interactive
session can start first and run `! helm-executor checkout …` itself.

```bash
helm-executor checkout <work-item-id> --client claude-code     # --wait 900 if a stopped episode still holds it
eval "$(helm-executor env --format shell)"                      # work item on the telemetry attributes
claude …
# at the end:
helm-executor stop
```

A session whose episode ends (a stop, the deadline, a revoked credential) stops
getting tokens; the last one it holds works for at most 15 minutes. Giving a work item
to a different executor is `stop` here and `checkout` there.

## What the managed file sets

| Key | Why |
|---|---|
| `requiredMinimumVersion` 2.1.285 | `allowedProviders` needs it. An older binary would ignore the key |
| `allowedProviders: ["customEndpoint"]`, `env.ANTHROPIC_BASE_URL` | the gateway is the only provider. Claude Code admits a custom endpoint only for the exact value pinned in managed `env` |
| `env.ANTHROPIC_API_KEY`, `env.ANTHROPIC_AUTH_TOKEN` = `""` | both outrank `apiKeyHelper` in Claude Code's credential order. An ambient key would be used instead of the episode token and sent to the edge. The empty override is checked by the conformance run |
| `apiKeyHelper`, `env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS` 240000 | Claude Code reruns the helper every four minutes and after a 401. Each run mints a 15-minute token |
| `env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | no traffic off the gateway path. It also turns off auto-update, so update Claude Code through your own channel |
| `env.HELM_EXECUTOR_*` | the control plane, organization and client name every helper in the session needs |
| `allowManagedHooksOnly` | only the managed hooks run |
| `allowManagedMcpServersOnly`, `allowedMcpServers` | only the HELM MCP server is allowed |
| `permissions.deny` | the table above |
| `hooks` | `helm-executor observe` in exec form on PreToolUse, PostToolUse, PostToolUseFailure and SessionStart, asynchronously; on SessionEnd synchronously with a 5 second limit |
| `managed-mcp.json` | the HELM server, `type: http`, `headersHelper` = `helm-executor headers` |

It sets no `forceLoginMethod` (that blocks `apiKeyHelper`), no
`OTEL_RESOURCE_ATTRIBUTES` (a managed value would override a launcher's), and no
telemetry credential: an OTLP header helper would send the episode token to the
collector, which is not the edge.

Doc facts this rests on, read from code.claude.com on 2026-10-02:

- `managedMcpServers` entries may not carry `headersHelper`, `command` or `env`, so
  the HELM server with a rotating token has to go in `managed-mcp.json`, which takes
  exclusive control of MCP on the machine.
- An HTTP hook's headers interpolate only environment variables, so they cannot
  carry a rotating token. The hooks are command hooks.
- A hook that times out does not block a tool call, and `claude -p` stops async hooks
  when the session ends, so the last PostToolUse of a `-p` run can be missing.
- Hook `async` is for command hooks, and deny rules apply in every permission mode,
  `bypassPermissions` included.

## Telemetry

`claude_code.active_time.total` carries `session.id` and every key in
`OTEL_RESOURCE_ATTRIBUTES`. The work item can only be a resource attribute if it
is known when Claude Code starts, so a launcher runs
`eval "$(helm-executor env --format shell)"` after `checkout` and before `claude`.
For a session that checks out later, the observations carry the same `session.id`,
so the control plane can join the two. The OTEL drop-in sets the exporter, the
endpoint and `OTEL_METRICS_INCLUDE_SESSION_ID`; which collector to use is not
decided yet, so `--otel-endpoint` is optional.

## Conformance

`conformance/run.mjs` checks the adapter's side. It is not a HELM kernel
conformance run.

```bash
node conformance/run.mjs                    # fake control plane and edge
node conformance/run.mjs --claude           # also drive the installed claude through the session profile
node conformance/run.mjs --cp-url https://… --edge-url https://… --org … [--work-item …] [--login] [--claude] \
  [--governed-flow --target github.com/<owner>/<repo> --branch-prefix helm/<seat>/ [--wait-approval 120]] \
  [--model <routed model>] [--report out.json]
```

Without `--cp-url` it starts the fake control plane from core and a scripted edge.
It checks login, checkout, `token`, `headers` and `observe`; that the edge accepts
the episode token in both headers `apiKeyHelper` sends and refuses another; that the
MCP endpoint accepts the headers; the governed write flow (read the repository, push
a branch, replay the push, open a draft pull request that waits for approval, read
attempts back, make one schema-breaking call); the rendered helper commands; and the
deny list. With `--claude` it runs the real client against a scripted model that asks
for one raw `git push` and one `echo`: the push must be denied, the echo must run,
the edge must see only the episode token with ambient `ANTHROPIC_API_KEY` and
`ANTHROPIC_AUTH_TOKEN` set in the environment, WebSearch and WebFetch must not be
offered, the hooks must report the session start, the denied attempt and the allowed
command as observed-only, and Claude Code must connect to the HELM MCP server through
the headers helper.

Against a live edge the governed flow runs only with `--governed-flow`, because it
needs the mandate's branch prefix, and a pull request that needs approval is reported
as awaiting approval unless `--wait-approval` gives a person time to approve it. The
flow is written from the kernel's effect schemas; no real edge has answered it yet.
The merge step of the QA scenario (an escalated merge approved in the Console) is not
in it: the merge effect is not served yet.

Run against the fake edge with Claude Code 2.1.274: 33 checks, 0 failed, 1
informational skip (2.1.274 is below the managed profile's floor of 2.1.285, which
the session profile does not need). Against a live edge, `--claude` runs `claude -p`
once and checks it completes; the scripted-model checks need the fake. The managed
profile itself, which needs root and Claude Code 2.1.285, has not been exercised on a
real managed host.

## Tests

```bash
npm test                                    # render, installer and fake-mode conformance
HELM_EXECUTOR_TEST_CLAUDE=1 npm test        # also drives the installed claude binary
```

The tests need `../core` built (`npm run build --prefix ../core`); `make test`
does that in order.
