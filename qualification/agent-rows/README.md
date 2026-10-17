# T87 and T98 attempt producer

`run.mjs` is a finite, source-owned trace producer for the existing `dev-1` to
`dev-5` QA slots. It starts the actual Claude Code, Codex and OpenClaw binaries
under an already prepared, disposable managed executor profile. It does not
provision a slot, install a client, create credentials, decide a HELM attempt or
publish a row verdict.

The integration harness supplies `producer-input/v1` as a noncredential JSON
file in the private QA mount. `--input` validates its structure without starting
clients. `--run-live` additionally requires an in-cluster Job in the named
namespace, six byte-pinned readback artifacts, byte-pinned executables and
three active executor episodes. The CP, edge and organization bindings are
explicit noncredential input fields passed to the clients. All paths,
including `--report`, are absolute.
The private artifact root must be a real directory below `/run/g0-private`.
[`input.example.json`](input.example.json) shows the shape. Its zero digests,
base SHAs and branch attempt id are placeholders; the slot owner substitutes
source-owned fake-provider state and valid catalog arguments before execution.

```sh
node qualification/agent-rows/run.mjs \
  --input /run/g0-private/agent-rows/input.json \
  --report /run/g0-private/agent-rows/producer-report.json

node qualification/agent-rows/run.mjs \
  --input /run/g0-private/agent-rows/input.json \
  --report /run/g0-private/agent-rows/producer-report.json --run-live
```

Use one fresh root and report path per run. The source fixes 26 attempts: eleven
T87 prompts for each managed client and four T98 prompts for OpenClaw. They
include the allowed controls. A case has a 20-second process-group limit and
256 KiB combined output limit; the entire run has a 600-second limit. It runs
sequentially. The producer stores raw stdout and stderr at mode 0600 under the
private root and puts only hashes, sizes, exit status and case identity in the
report. It copies no ambient provider credential variable into a child. An
executor episode and controlled stub model route are prerequisites; the runner
never makes a paid model call intentionally.

The disposable Claude probe uses `bypassPermissions` to make the client attempt
both negative and allowed calls without an interactive prompt. Managed deny
rules and `PreToolUse` hooks still apply in that mode; the independent network
profile and gateway custody remain required. This mode is confined to the
throwaway fake/stub QA Job.

The report always says `PRODUCED_UNQUALIFIED` and marks both rows
`NOT_QUALIFIED`, even when every client process exits zero. A successful exit
can mean the model did not attempt a tool. The integration harness must reject
timed-out or truncated cases, parse each client trace, require the named tool
action, and join it with independent source-owned readbacks before issuing a
row result.

## Required integration join

For T87, the harness must read back each client's effective managed policy and
its provenance, actual client/tool denial, CP hook observations with
`coverage='observed-only'`, gateway `ListAttempts` for the bound commitment,
and fake GitHub, Linear and cluster audit before and after. The second MCP
server must be refused by managed-only policy, and the HELM MCP control must
end in an observed successful gateway effect. Provider and attempt deltas for
the raw probes must be zero. A hook process exit or core `observe` exit is not
CP persistence evidence.

For T98, the harness must read back the installed OpenClaw host and plugin
digest, external verdict source/time from CP, Kernel `EFFECT_OUT_OF_SCOPE`
and MCP denied status, native duplicate `before_tool_call` block and its
observation, no proposal for external DENY, zero fake-provider requests for
both negative paths, and exactly one gateway/provider execution for the
ALLOW/ALLOW control. External ALLOW cannot stand in for admission, approval
or permit. Use the Gateway `ListAttempts` read API and CP observation table or
an equivalent source-owned read API, not client-reported success.

The six `references` in the input name evidence files prepared by the slot
owner: model stub, provider fakes, enforced network policy, effective Claude
and Codex managed policy, and installed OpenClaw plugin. The runner checks
their bytes against supplied hashes and records them; the integration harness
must independently verify their provenance, the applied image digest, the
adapter source revision, the fake endpoint routing, and the exact work-item
and commitment bindings. A self-declared input value is never proof.
The four exact catalog calls in `fixtures.calls` are noncredential JSON. The
harness must check their schemas, grant and mandate targets, and distinct
effect identities against the source-owned catalog before starting the runner.

The current CP observation migration in the inspected native-row branch allows
Claude Code and Codex clients only. The CP owner must add OpenClaw intake and
readback before T98 can pass. This repository does not change CP migrations.

[`trace-contract.mjs`](trace-contract.mjs) parses the pinned private client
stdout formats and the optional OpenClaw trajectory export. Its exact source
pins, fields and CP join limits are in [`TRACE-CONTRACT.md`](TRACE-CONTRACT.md).
The parser never upgrades the producer report into a row verdict. OpenClaw
`agent exec --json` is a run summary: its `toolSummary` cannot prove an
individual invocation. Preserve a per-case retained state and trajectory
export, or report T98 as unqualified. Stderr is diagnostic bytes only.
