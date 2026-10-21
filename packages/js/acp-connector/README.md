# @mindburn/helm-acp-connector

HELM-governed ACP (Agent Client Protocol) connector for coding agents. The
reviewed runtime supports Claude Code and Codex through their ACP bridges.
Native launch helpers remain available for Gemini, Kimi, and OpenCode, but
starting a governed session requires a verified permission-mode contract;
unknown native contracts fail closed.

The positioning matches this repository: engines propose and orchestrate
work; HELM governs execution and produces evidence. The connector drives
vendor coding agents over ACP (the Zed-originated JSON-RPC protocol) while
routing every interactive permission decision through the HELM boundary.

```text
┌─────────────┐   ACP (ndJSON/JSON-RPC over stdio)   ┌──────────────┐
│ this client │ ◄──────────────────────────────────► │ ACP adapter  │──► engine binary
└──────┬──────┘                                       └──────────────┘
       │ requestPermission ──► Kernel verdict (/api/v1/evaluate), fail-closed
       │ fs/read|write_text_file ──► FsGuard declarative allowlist (canonicalized)
```

## What it ships

- **ACP client connector** (`client.ts`) — session lifecycle over a minimal,
  self-contained ndJSON JSON-RPC peer (`jsonrpc.ts`, no runtime deps);
  60 s startup deadline on handshake phases only
  (`HELM_ACP_STARTUP_TIMEOUT_MS` override); cancel is a protocol
  notification; stderr-tail + exit-code error enrichment; handler swapping
  for warm-connection reuse. Codex is forced to `workspace-write` with the
  `user` reviewer. Session creation and each prompt read back the safe mode;
  missing mode/config capabilities or a mode change stop the connection.
- **Kernel-gated permission broker** (`permission.ts` + `kernel-evaluator.ts`) —
  every `session/request_permission` is routed through a Kernel verdict.
  Fail-closed default: DENY / ESCALATE / transport error / timeout all
  reject. There is deliberately **no `yolo` policy**. The tiered model is
  adapted as a LOW-RISK TIER beneath the heavyweight approval ceremony:
  `auto-approve-reads` only classifies read-only tool kinds (read/search/
  fetch/think) as low-risk for the kernel — the kernel still issues the
  verdict on every request unless it explicitly grants an exact-payload sticky
  allow with decision + receipt ids. MCP tools always require a fresh Kernel
  decision and use `allow_once`; HELM never grants the adapter persistent MCP
  approval. Missing concrete tool input, conflicting call IDs/arguments, or
  the absence of an offered single-use allow answers `cancelled`.
- **Allowlisted fs handlers** (`fs-guard.ts`) — the counter-position to the
  open-fs-handler anti-pattern: `fs/read_text_file` / `fs/write_text_file`
  are served only when the requested path canonicalizes inside a declared
  root with the required capability. Path canonicalization resolves symlinks
  (realpath walk-up for non-existent paths), so a symlink inside an allowed
  root pointing outside is denied. One canonical `isPathInside` — a divergent
  copy is a permission-bypass risk. The `terminal` capability is never
  advertised. A writable root is an explicit static sandbox grant; individual
  file writes are not Kernel decisions or production EvidencePack entries.
- **Managed engine provisioning client** (`provisioning.ts`) — lockfile-pinned
  versions, sha512 (npm SRI) verification, temp-dir extract, atomic rename,
  `.meta` ledger, prune-superseded. Plus the HELM additions:
  Ed25519-signed manifest enforcement (trusted keys are required by default;
  only an explicit dev-only opt-in permits an unsigned fixture) and a
  `ProvisioningReceipt` carrying the sha512 of the installed binary + manifest
  digest, persisted per install —
  the exact bytes being executed are receipted. Cache hits re-verify the
  ledger hash and reprovision on tamper; runtime lookup re-verifies the binary,
  ledger, manifest digest, and path containment before returning an executable.
- **Session manager** (`manager.ts` + `session-store.ts`) — warm-connection
  reuse with an unref'd dispose grace window (default 60 s),
  cancel → protocol grace (default 2 s) → SIGTERM → bounded SIGKILL escalation.
  Stop cancels pending policy evaluation and awaits the owned process group
  and observed descendants. A pre-aborted run never launches or prompts.
  Session persistence binds the agent, workspace path, and MCP configuration.
  The supervised runtime requires POSIX process groups.
- **Concrete action evidence** — joins sparse permission requests to ACP
  `tool_call` updates by session and call ID. Kernel input includes actual MCP
  server, tool, complete arguments, and an explicit navigation URL or the last
  confirmed selected-page URL for browser operations. Raw tool input, output,
  and content are retained in events; oversized evidence fails closed.
- **Process credential boundary** — spawned adapters inherit only basic OS
  runtime variables. Provider/cloud credentials must be delegated explicitly
  through `extraEnv`; ambient parent-process secrets are not copied by default.

## Usage sketch

```ts
import {
  AcpSessionManager, SessionStore, FsGuard, HelmKernelEvaluator,
  buildAdapterLaunchSpec, buildNativeAcpLaunchSpec, ensureEngine,
  getProvisionedEnginePath,
} from "@mindburn/helm-acp-connector";

// 1. Provision the engine (up front — never mid-session).
const { executablePath } = await ensureEngine("claude", {
  manifest, manifestSignature, trustedPublicKeys: [releaseKeyPem],
});

// 2. Governed session.
const manager = new AcpSessionManager({
  sessionStore: new SessionStore("/var/lib/helm/acp-sessions"),
  fsGuard: new FsGuard({ roots: [{ path: "/work/project", read: true, write: true }] }),
  evaluator: new HelmKernelEvaluator({ apiKey, tenantId, principal, workspaceId }),
  mcpServers: [{ name: "browser", command: "/path/to/mcp-browser", args: [], env: [] }],
  launchSpecFor: (agent) => buildAdapterLaunchSpec({
    agent, adapterEntry: "/path/to/acp-adapter.js", engineExecutablePath: executablePath,
  }),
});

const result = await manager.runPrompt({
  runId: "run-1", agent: "claude", cwd: "/work/project",
  prompt: "fix the failing test", policy: "auto-approve-reads",
  onEvent: (e) => console.log(e),
});
```

The executable must already be installed and authenticated. HELM does not copy
ambient credentials into the child; pass any non-interactive credential
explicitly through `extraEnv`.

`runPrompt` accepts a per-session `mcpServers` override, an `AbortSignal`, and
an awaited `onSessionReady(sessionId)` callback for durable session binding.
`stop(runId)`, `dispose(runId)`, and `disposeAll()` are asynchronous. Await them
before reporting cleanup. Stop returns `{adapterExited, descendantsExited,
forced}` and rejects when termination cannot be confirmed. Explicit model and
effort selections must be applied and read back; they never silently fall back.
Codex's effort option is `reasoning_effort`.

MCP servers use ACP stdio or HTTP shapes. The default is an empty list. For
Codex, the connector supplies the complete server map through `CODEX_CONFIG`
and forces `default_tools_approval_mode="prompt"` with no static tool grants;
the bridge's ACP MCP translation drops those approval fields. Caller-supplied
servers outside the declared map are disabled. Claude receives explicit ACP
servers and SDK ask settings with ambient settings sources disabled. The
connector rejects permission requests for undeclared MCP servers.

## Organization runtime process bridge

Run `node dist/bridge.js`. The process accepts one episode through NDJSON on
stdin and emits NDJSON on stdout. Diagnostic adapter output stays on stderr.
The host supplies trusted launch configuration and FS grants; this command is
an internal process boundary, not a public remote execution service.

```json
{"id":"run-command","method":"run","params":{"runId":"episode-id","agent":"codex","cwd":"/work/project","prompt":"Inspect the page","policy":"ask","model":"selected-model","effort":"max","evaluator":"host","launch":{"adapterEntry":"/managed/codex-acp/dist/index.js","engineExecutablePath":"/managed/codex"},"mcpServers":[{"name":"browser","command":"/managed/browser-mcp","args":[],"env":[]}],"fsRoots":[{"path":"/work/project","read":true,"write":false}]}}
```

The bridge emits `{"type":"session","runId":"episode-id","sessionId":"actual-vendor-id"}`
after safe-session and model/effort verification. It waits for
`{"id":"bind-command","method":"session_bound","params":{"sessionId":"actual-vendor-id"}}`
before prompting. The host must persist its task/session binding before ACK.
Startup metadata is buffered until the ACK; tool execution before binding is
rejected. Missing ACK, disconnect, and Stop all prevent prompting.

Each permission emits `{type:"permission",runId,id,request,tier,agent,cwd,policy}`.
`request` is a `PermissionAsk` with `sessionId`, `toolCallId`, `title`, `kind`,
`isRead`, complete `toolInput`, and `action:{server?,tool,arguments,url?,browserContext?}`.
Browser context includes its confirming `sourceToolCallId`; it does not infer
URLs hidden inside JavaScript. Navigation arguments and script contents remain
available to the host policy as complete arguments.

The authenticated host evaluates the request and verifies its receipt, then sends
`{id,method:"permission_result",params:{permissionId,decision:{verdict,decisionId,receiptId,reason?,reasonCode?}}}`.
`ALLOW` requires nonempty decision and receipt IDs. Unknown, late, malformed,
and missing replies never authorize execution. Aborted waits emit
`{type:"permission_cancelled",runId,id}`. The bridge does not verify signatures;
that responsibility remains with the authenticated Kernel client in the host.
Standalone callers may use `evaluator:"kernel"` and explicit `kernel` options.

Tool and result events emit `{type:"event",runId,event}`. Tool events retain
`rawInput`, `rawOutput`, `content`, and normalized `action` when available.
An individual retained event is limited to 1 MiB; authorization input remains
limited to 8192 UTF-8 bytes. Exceeding a limit closes/rejects the boundary rather
than silently truncating evidence used to authorize an action.

`{id,method:"stop",params:{runId}}` may arrive during any phase. Its result is
`{id,result:{termination}}`; the run result becomes `cancelled`. Normal run
completion also tears down tracked workers before returning
`{id,result:{sessionId,stopReason,termination}}`. Unconfirmed termination is an
error with termination metadata. Close stdin after receiving the final result
and await bridge process exit. Restarts must treat an uncertain old process
handle as unresolved; this command does not relaunch an interrupted episode.

These controls supervise the owned POSIX process group and observed descendants.
They do not revoke effects already accepted by a remote service or replace an
OS sandbox against an intentionally escaping executable.

## Contract notes

- **Kernel evaluate contract** mirrors `packages/js/helm-tool-wrapper`
  (`POST /api/v1/evaluate`, Bearer apiKey, `X-Helm-Tenant-ID` /
  `X-Helm-Principal-ID`, `X-Helm-*` receipt headers). Replicated locally to
  keep this package build-independent; `helm-ai-kernel` remains the source of
  truth for verdict and receipt semantics.
- **Manifest signing contract** (toward helm-desktop / platform-actions): the
  engine manifest is expected to be generated in CI from lockfile pins,
  signed with the HELM release key (Ed25519 over the canonical manifest
  bytes), and shipped with the desktop app. `ProvisioningReceipt` is the
  handoff point for EvidencePack assembly on the desktop side.

## Provenance & licensing

Design mechanisms adapted from Rowboat (Apache-2.0) with attribution comments
in each module; all code here is original. Deliberately NOT adopted: open fs
handlers (full user FS reach), `yolo` permission policy, or implicit unsigned
manifests. No terminal capability is advertised. This is a HELM-compatible
example, not a production connector-certification or conformance claim. Static
filesystem grants do not replace per-effect permits, ProofGraph entries, or a
source-owned EvidencePack integration.

## Tests

```bash
npm test
```

Focused tests against a fake ACP agent speaking the real wire protocol cover:
lifecycle, startup deadline, cancel→grace→force-kill, warm reuse, kernel
verdict round-trips, fail-closed denials, allowlist enforcement including
symlink escape attempts, provisioning hash verification, signed-manifest
enforcement, session binding, and tamper-triggered reprovisioning.
