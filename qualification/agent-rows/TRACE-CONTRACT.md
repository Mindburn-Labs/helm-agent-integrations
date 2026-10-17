# Private client trace contract for T87 and T98

`trace-contract.mjs` is a strict parser for the versions in `input.example.json`.
It consumes each producer case's byte-pinned `stdout.bin` and `stderr.bin` in
the private QA mount. It returns in-memory tool requests and correlation
candidates; it does not issue a row verdict, prove tool dispatch, or replace CP,
Gateway, native host or fake-provider readback. Do not publish its
`private_arguments` or `private_command` fields.

## Source and version pins

| Client | Reviewed contract and immutable pin | Local inspection limit |
| --- | --- | --- |
| Claude Code `2.1.295` | [Official programmatic output and subagent stream contract](https://code.claude.com/docs/en/headless); npm `@anthropic-ai/claude-code@2.1.295` integrity `sha512-PTdE5NdqwwyCmtbX/0WAuosyip8DkwC6M5mAJv+b9KGuxMFnkTJbc2b3EY6FYdo5ZTWkm6MN8reA9YWWMrLR+g==` | The installed owner-host CLI was `2.1.285`, below this pin. The package tarball SHA-256 was `fe0d5efb8136f23e7292e227d14a1fc04f3fb05981dd9d0585d03be7bd8d863a`; this is not the QA executable hash. |
| Codex `0.159.0-alpha.12.1` | [Official JSONL mode](https://learn.chatgpt.com/docs/non-interactive-mode) and [pinned `exec_events.rs`](https://github.com/openai/codex/blob/c15025eb3975b163bbc251008a87d6d67509bec2/codex-rs/exec/src/exec_events.rs) (`06565c097b28d3bf2ad592943cc30c776b45e236` Git blob), [pinned JSONL projector](https://github.com/openai/codex/blob/c15025eb3975b163bbc251008a87d6d67509bec2/codex-rs/exec/src/event_processor_with_jsonl_output.rs) (`73e0c9d911c82aae67c44e6b1a4ce54c7092b6be` Git blob); npm `@openai/codex@0.159.0-alpha.12.1` integrity `sha512-0hWKpy36LmHt2J7PpwsJ0h+HAgUk3GhUbzrgAavooT4+iY9GXbvpcPCsqI8WNJUspdhk6Q4k3VWCzLS1iY9WGA==` | The installed owner-host CLI was `0.163.0-alpha.10.2`, so it is not pinned-runtime acceptance. The existing installed-client inspection records an earlier binary SHA and does not qualify this producer. |
| OpenClaw `2026.9.6` | Committed `plugins/openclaw/package-lock.json` npm integrity `sha512-Ie0kyQSCVfFqixsgVg39vevUDq01Ch5u3+7Yu5Y3qARczmdAe+lzp8bVnO9925rHiW/+CFp70zfORCyPmCH31g==`; [official `agent exec` contract](https://docs.openclaw.ai/cli/agent) and [trajectory export contract](https://docs.openclaw.ai/cli/sessions). In the installed package, `dist/agent-exec-B0cHNAVy.mjs` SHA-256 is `a7d9042e150909ffaed39be4a3fa7e4588012a0c955c4e31b3a9a510f0c05a02`; `dist/export-trajectory-Do1Kku1G.mjs` is `002c3c282f41146554cca7ac4a4c2513d6c4778886fe59d85c708cc0c0e39149`; `dist/hooks-CKanWLsK.mjs` is `e3d29c0cc98b4e70a309a7a98e33692fd0799d80226eab2065eef35ed713ec4d`. | Bounded `agent --help`, `agent exec --help`, and isolated `sessions --json` ran with Node `24.16.0`, without a provider call. The owner host has no global OpenClaw binary or managed QA profile. |

The source pins identify the contract reviewed here. The QA Job must separately
read back each actual executable SHA-256, `--version`, OpenClaw package and
plugin bytes, source revision, Node runtime SHA-256, and effective managed
policy. The producer already records or requires these fields. A package
integrity string is never an installed executable readback.

## Stdout and stderr parser

Call `parseCaseTrace({client, version, stdout, stderr, trajectory?})` with raw
Buffers after comparing their SHA-256 and byte lengths with the private
producer report. Reject `timed_out` or `output_limited` cases before parsing;
check the recorded process exit status separately. The parser accepts only the
three exact versions above,
bounded UTF-8 output, valid JSON/JSONL, one terminal, and unique call IDs. It
returns the raw stdout and stderr hashes. Stderr is retained as diagnostic
bytes; it never supplies tool invocation or denial proof.

- Claude `-p --output-format stream-json --verbose` emits JSONL. `assistant.message.content[]` blocks with `type="tool_use"` carry `id`, `name`, and `input`; `user.message.content[]` blocks with `type="tool_result"` carry `tool_use_id` and `is_error`. The terminal `type="result"` has `session_id` and may list `permission_denials[].tool_use_id`. Subagent messages carry `parent_tool_use_id`. A tool-use block is a client request, and a matching result or permission denial is a reported outcome. Neither proves provider state.
- Codex `exec --json` emits JSONL `thread.started`, `turn.started`, `item.started|updated|completed`, and `turn.completed|failed`. The pinned `command_execution` item has `id`, `command`, `status`, `exit_code`, and `aggregated_output`. An `mcp_tool_call` item has `id`, `server`, `tool`, `arguments`, `status`, `result`, and `error`. The JSONL projector creates its own item ID with `make_id()`; **it is not the managed hook's `tool_use_id`**. A command item has no structured hook input, so its command hash is not CP's input digest.
- OpenClaw `agent exec --json` emits one stable envelope with `ok`, `status`, `final`, `payloads`, `sessionId`, optional `toolSummary`, and run metadata. `toolSummary.calls` and `.tools` are aggregate. This stdout has no per-call ID, arguments or native hook verdict. The parser returns no invocation from it, even when calls is positive. A failure envelope or stderr message is not a tool event.

`hookRef(kind, value)` matches CP's `sha256("helm.executor.hook.label.v1|" + kind + "|" + value)` reference. Candidate fields are `name_ref` for kind `tool`, `use_ref` for kind `tool_use`, and `input_digest_candidate` from core's sorted-key `canonicalJson` digest. For Claude, compare the exact tool-use ID, name, input digest, episode/work item and case window to one CP `observed-only` row. For Codex, require separately retained managed hook stdin/provenance to establish the real hook use ID and command input, or a unique exact name and input-digest CP match where both inputs are actually available. A time-window or synthetic JSONL item ID alone is not an exact join; reject ambiguity.

## OpenClaw per-call source

The producer invokes pinned `agent exec --state-dir <client.home> --config
<client.config> --cwd <caseDir> --json`. The pinned source creates a new explicit
session ID and a key of the form `agent:<agentId>:explicit:<sessionId>` in its
retained state (`dist/session-LWX45H--.mjs:91-94,286-299`). Use the same
`OPENCLAW_STATE_DIR=<client.home>` and
`OPENCLAW_CONFIG_PATH=<client.config>` environment for both read commands:

```sh
<pinned-openclaw-binary> sessions --json
<pinned-openclaw-binary> sessions export-trajectory \
  --session-key <exact-key> --workspace <caseDir> \
  --output <unique-name> --json
```

IH must find **one** session entry whose `sessionId` equals the case stdout
`sessionId`, and use that entry's exact `key` for the export. Pin and preserve the
export's `manifest.json` and `events.jsonl` bytes, count, hash, source version,
and exporter status inside the private QA artifact root. The export directory
is beneath `<caseDir>/.openclaw/trajectory-exports/`.

In the pinned exporter, `events.jsonl` records `traceSchema="openclaw-trajectory"`,
`schemaVersion=1`, `sessionId`, `source`, `type`, and `ts` per event. Transcript
`type="tool.call"` carries `data.toolCallId`, `data.name`, and
`data.arguments` (an object or a JSON-encoded object); `type="tool.result"` carries
`data.message.toolCallId`, `.toolName`, and `.isError`. The parser checks the
manifest and envelope identities, event count, unique call IDs, and call/result
pairing. It rejects an export with parse warnings. Export redaction can change
arguments, so an exported digest is only a candidate: require exact equality
to CP's input digest or a separate bounded
raw hook capture. A missing ID, truncated export, redaction mismatch, or more
than one CP row match leaves T98 unqualified.

The native duplicate path additionally needs a source-owned OpenClaw
`before_tool_call` decision readback. The pinned hook runtime records
`family="plugin"`, `operation="before_tool_call"`, outcome `allowed|denied|unknown`,
and a reason code; `plugin_hook_blocked` is the ordinary blocked path
(`dist/hooks-CKanWLsK.mjs:585-618`). A `tool.result` error or assistant final
text does not identify the plugin decision. If the QA host does not retain and
expose that native decision with original run/session provenance, T98 remains
unqualified. Join this with CP's OpenClaw external verdict source, decision and
native observed time, the bound episode/work item, Gateway `ListAttempts`,
Kernel receipt and fake-provider audit. An external ALLOW grants no permit.

The parser tests use source-shaped synthetic events to check fail-closed
normalization. They are not live client, managed-policy, CP, Gateway, or
provider acceptance.
