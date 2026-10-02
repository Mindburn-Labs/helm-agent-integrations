# helm-executor

The one auth and observation client for HELM executor front-ends. An executor is
an agent session, such as Claude Code or Codex, that does a work item's job while
its external actions go through the HELM kernel gateway. This package is the
part every front-end shares:

- `login` authorizes the machine with the control plane (device code).
- `checkout` opens an executor episode for one work item.
- `token` and `headers` print the short-lived episode bearer token for an
  `apiKeyHelper`, an MCP `headersHelper` or a Codex `auth.command`.
- `observe` reports a client hook event, observed-only.
- `stop`, `status` and `env` end an episode, show state and print OpenTelemetry
  resource attributes for a launcher.

The behavior, exit codes, hook envelope and control plane calls are specified in
[CONTRACT.md](CONTRACT.md). The JSON Schemas are in [schema/](schema). The
adapters call this CLI as a subprocess: [Claude Code](../claude-code/README.md).

This package decides nothing and holds no provider, GitHub or Linear credential.
The kernel gateway is the authority; `observe` is evidence that a hook saw a call,
nothing more.

## Build and test

```bash
npm ci
npm test        # builds, then runs the node:test suite
```

Node 22 or newer, TypeScript, no runtime dependencies. The tests run the real
executable against a fake control plane; no network and no credentials are
involved.

## State

`HELM_EXECUTOR_HOME` (default `~/.config/helm-executor`) is a directory of mode
0700. The machine credential and each slot's episode are files of mode 0600,
written atomically. A rotating refresh token and an episode mint run under a lock
file, so helpers that start at the same moment share one refresh and one mint. The
holder refreshes the lock while it works, and a waiter takes a lock over only from
a process that is gone or has stopped refreshing it, one waiter at a time.
Nothing prints a credential except `token` and `headers`, and a credential never
reaches a log, a stderr line or an observation. The client never follows a
redirect, so a bearer token cannot be sent to another host, and the machine
credential is sent only to the control plane that issued it: an environment that
names another one is a usage error.

A hook never renews the credential, and a renewal is not started with under 2.5
seconds left, because a renewal cut off after the control plane rotated the refresh
token loses the machine's login. Whatever the control plane does with a lost answer
is its call; see "Open request" in CONTRACT.md section 7.

Limits, deliberate for now: macOS and Linux only; the credential is a file, not a
keychain item.

## Fake control plane

`startFakeCp()` from `@mindburn/helm-executor/testing` serves the device-code
routes and the executor routes of the contract on an injectable clock, and an MCP
endpoint that accepts episode tokens and stands in for the kernel gateway's GitHub
effects, including approval of the draft pull request. `node dist/testing/serve.js`
runs it as a process. `dist/testing/governed-flow.js` is the write flow an executor
must complete through that endpoint. Adapters use both for their conformance runs
until a real control plane and edge are reachable.
