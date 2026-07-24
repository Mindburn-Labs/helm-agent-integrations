# @mindburn/helm-acp-connector

HELM-governed ACP (Agent Client Protocol) connector for embedded coding
engines (Claude Code, Codex).

The positioning matches this repository: engines propose and orchestrate
work; HELM governs execution and produces evidence. The connector drives
vendor coding agents over ACP (the Zed-originated JSON-RPC protocol) while
routing every sensitive decision through the HELM boundary.

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
  for warm-connection reuse.
- **Kernel-gated permission broker** (`permission.ts` + `kernel-evaluator.ts`) —
  every `session/request_permission` is routed through a Kernel verdict.
  Fail-closed default: DENY / ESCALATE / transport error / timeout all
  reject. There is deliberately **no `yolo` policy**. The tiered model is
  adapted as a LOW-RISK TIER beneath the heavyweight approval ceremony:
  `auto-approve-reads` only classifies read-only tool kinds (read/search/
  fetch/think) as low-risk for the kernel — the kernel still issues the
  verdict. Sticky per-session allows are recorded as receipts (decisionId +
  receiptId that authorized them). Option-family fallback mapping ensures a
  decision always lands on an option the agent actually offered, and a reject
  with no reject option offered answers `cancelled` — never an allow.
- **Allowlisted fs handlers** (`fs-guard.ts`) — the counter-position to the
  open-fs-handler anti-pattern: `fs/read_text_file` / `fs/write_text_file`
  are served only when the requested path canonicalizes inside a declared
  root with the required capability. Path canonicalization resolves symlinks
  (realpath walk-up for non-existent paths), so a symlink inside an allowed
  root pointing outside is denied. One canonical `isPathInside` — a divergent
  copy is a permission-bypass risk. The `terminal` capability is never
  advertised.
- **Managed engine provisioning client** (`provisioning.ts`) — lockfile-pinned
  versions, sha512 (npm SRI) verification, temp-dir extract, atomic rename,
  `.meta` ledger, prune-superseded. Plus the HELM additions:
  Ed25519-signed manifest enforcement (fail-closed before any download when
  trusted keys are configured) and a `ProvisioningReceipt` carrying the
  sha512 of the installed binary + manifest digest, persisted per install —
  the exact bytes being executed are receipted. Cache hits re-verify the
  ledger hash and reprovision on tamper.
- **Session manager** (`manager.ts` + `session-store.ts`) — warm-connection
  reuse with an unref'd dispose grace window (default 60 s),
  cancel → grace (default 2 s) → force-kill so a wedged adapter can never
  lock a turn, per-run session-id persistence with stale-session fallback.

## Usage sketch

```ts
import {
  AcpSessionManager, SessionStore, FsGuard, HelmKernelEvaluator,
  buildAdapterLaunchSpec, ensureEngine, getProvisionedEnginePath,
} from "@mindburn/helm-acp-connector";

// 1. Provision the engine (up front — never mid-session).
const { executablePath } = await ensureEngine("claude", {
  manifest, manifestSignature, trustedPublicKeys: [releaseKeyPem],
});

// 2. Governed session.
const manager = new AcpSessionManager({
  sessionStore: new SessionStore("/var/lib/helm/acp-sessions"),
  fsGuard: new FsGuard({ roots: [{ path: "/work/project", read: true, write: true }] }),
  evaluator: new HelmKernelEvaluator({ apiKey, tenantId, principal }),
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
handlers (full user FS reach), `yolo` permission policy, unsigned manifests.
No terminal capability is advertised.

## Tests

```bash
npm test
```

35 tests against a fake ACP agent speaking the real wire protocol:
lifecycle, startup deadline, cancel→grace→force-kill, warm reuse, kernel
verdict round-trips, fail-closed denials, allowlist enforcement including
symlink escape attempts, provisioning hash verification, signed-manifest
enforcement, and tamper-triggered reprovisioning.
