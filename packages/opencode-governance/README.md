# @helm-ai/opencode-governance

**Private, unpublished.** Fail-closed [HELM](https://github.com/Mindburn-Labs) governance plugin for [opencode](https://opencode.ai). It maps HELM kernel verdicts onto opencode's `permission.ask` hook (ALLOW → allow, DENY → deny, ESCALATE → ask) and taps `tool.execute.before`/`tool.execute.after` to mint boundary evidence records.

> Status: scaffold. This package is a HELM-compatible integration example, not
> a certified opencode plugin and not a HELM conformance artifact. Kernel
> verdict semantics, receipt semantics, and EvidencePack verification rules
> remain owned by `helm-ai-kernel`.

## What it does

1. **Every tool call requires an exact kernel ALLOW.** `tool.execute.before` evaluates the call against the kernel and throws `HelmGovernanceDeny` *before the tool runs* unless the verdict is exactly `ALLOW`. Throwing in this hook blocks execution — this is opencode's documented `.env`-protection pattern, and the hook is triggered for every tool call in the studied opencode sources (`packages/opencode/src/session/tools.ts`).
2. **`permission.ask` verdict mapping.** When opencode triggers `permission.ask`, the kernel verdict is mapped onto opencode's status slot: `ALLOW → allow`, `ESCALATE → ask` (a human or approval ceremony decides — HELM never auto-allows), `DENY → deny`.
3. **Fail closed on everything unknown.** Kernel unreachable, timeout, non-2xx, malformed body, unrecognized verdict string, misconfiguration, or (in strict mode) evidence-sink failure → **deny**, with a locally synthesized reason code (`KERNEL_UNAVAILABLE`, `KERNEL_UNKNOWN_VERDICT`, `KERNEL_MALFORMED_RESPONSE`, `PLUGIN_MISCONFIGURED`, `EVIDENCE_SINK_FAILURE`) that cannot be confused with kernel-signed evidence. Verdict parsing is strict: only the exact contract fields (`verdict` or `decision.verdict`) carrying the exact values `ALLOW`/`DENY`/`ESCALATE` are honored — near-misses like `{status:"allow"}`, `"allow"`, or `"ALLOW "` are deny-path errors, never authorization.
4. **Boundary evidence taps.** `tool.execute.before` mints an `opencode.boundary.open.v1` record (args SHA-256, verdict, decision id); `tool.execute.after` mints `opencode.boundary.close.v1` (args + output hashes, outcome `completed`/`error` from the hook's error metadata); denied calls mint `opencode.boundary.deny.v1`; permission mappings mint `opencode.permission.decision.v1`. Records are appended as JSONL to the evidence dir, one file per UTC day.

## What it does NOT do

- **It does not mint kernel receipts.** Records are plugin-local *evidence / receipt requests*. The kernel owns `DecisionRecord`/`Receipt`/`ExecutionBoundaryRecord` semantics and signing. The `opencode.*` record-type namespace is deliberately disjoint so these records can never masquerade as kernel-signed artifacts; a kernel-side ingester (the `svc-high-risk-loop-bridge` projection pattern) can verify and project them later.
- **It does not grant authority.** opencode's in-memory "always allow" rules, session caches, and human replies cannot be turned into HELM authority by this plugin. Signed approvals with scope and expiry remain a kernel concern.
- **It does not govern MCP servers.** opencode connects to configured MCP servers directly. Route MCP through HELM's quarantine + pinned-schema firewall separately; treat opencode-native MCP tools as untrusted by default.
- **It does not sandbox the plugin runtime.** opencode loads plugins in-process with ambient authority. This package makes no network calls except the configured kernel endpoint/binary, but other plugins you install can do anything.
- **It is not a conformance gate.** Passing these unit tests says nothing about HELM conformance; that requires the kernel's golden packs and replay harness.

## Install

```bash
cd packages/opencode-governance
npm install
npm test
```

Then reference it from `opencode.json` (once published internally or via a file path):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@helm-ai/opencode-governance"]
}
```

or with options:

```json
{
  "plugin": [["@helm-ai/opencode-governance", { "tenantId": "acme", "principal": "dev-agent" }]]
}
```

## Configuration

Precedence: plugin options > environment > documented defaults. **Missing required config aborts plugin load** — a governance plugin that cannot reach its authority must not load silently and wave traffic through. There is no disable flag. Plugin options accept native JSON types (boolean `strictEvidence`, numeric `timeoutMs`, string-array `kernelBinaryArgs`); a wrong-typed value is a hard configuration error, never a silent fallback to env/defaults.

| Env var | Option key | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `HELM_KERNEL_URL` | `kernelUrl` | http mode | — | Kernel (or control-plane PEP façade) base URL. **https required; plaintext http is accepted for loopback literals only** (`127.0.0.0/8`, `::1`, `localhost`). |
| `HELM_API_KEY` | `apiKey` | http mode | — | Bearer token for the tenant-scoped evaluate endpoint. |
| `HELM_KERNEL_BINARY` | `kernelBinary` | binary mode | — | Path to a local kernel binary. |
| `HELM_KERNEL_BINARY_ARGS` | `kernelBinaryArgs` | no | `[]` | Argv between binary and payload (binary mode). |
| `HELM_KERNEL_MODE` | `mode` | only if both targets set | inferred | `http` or `binary`. Both targets set without this = hard error. |
| `HELM_TENANT_ID` | `tenantId` | yes | — | Tenant scope. |
| `HELM_PRINCIPAL` | `principal` | yes | — | Agent principal. Never taken from tool metadata. |
| `HELM_RISK_CLASS` | `riskClass` | no | `T2` | One of `T0..T3`. |
| `HELM_EFFECT_CLASS` | `effectClass` | no | `E4` | One of `E0..E4`. |
| `HELM_TIMEOUT_MS` | `timeoutMs` | no | `5000` | Evaluation timeout; expiry = deny. |
| `HELM_EVIDENCE_DIR` | `evidenceDir` | no | `~/.helm-ai-kernel/evidence/opencode` | JSONL sink directory. |
| `HELM_EVIDENCE_STRICT` | `strictEvidence` | no | `1` | `0` relaxes evidence-failure handling to stderr warnings. In strict mode a pre-execution sink failure denies the call, and a post-execution sink failure arms a next-call deny gate. Development only. |

### Kernel targets

**HTTP mode** — `POST {HELM_KERNEL_URL}/api/v1/evaluate` with `Authorization: Bearer`, `X-Helm-Tenant-ID`, `X-Helm-Principal-ID`, and an `EXECUTE_TOOL` payload whose resource is `tool.opencode.<tool>`. Only an exact `ALLOW`/`DENY`/`ESCALATE` in the response is honored.

**Binary mode** — adapter contract: the binary receives one JSON evaluation request on stdin and prints one JSON object on stdout with a `verdict` field. Exit 0 + exact `ALLOW` is the *only* authorizing path. An `ALLOW` printed alongside a non-zero exit is refused (fail closed); `DENY`/`ESCALATE` printed with a non-zero exit are honored (they only restrict). A binary that exits before reading the full stdin payload (EPIPE) is treated as a transport failure — truncated requests never authorize. This mirrors the kernel hook's last-mile posture: signer or receipt failure denies.

## Threat model

**Protected against**

- Tool calls executing without a kernel decision (unreachable kernel ⇒ deny).
- Kernel response tampering that mutates verdicts into anything unrecognized (⇒ deny) — note: full signature verification of kernel responses remains the kernel/gateway layer's job, not this plugin's.
- Network interception of credentials/verdicts: plaintext http kernel URLs are refused except loopback literals; https is required everywhere else (enforced at config resolution AND at HTTP client construction).
- Agent-controlled metadata spoofing authority (`principal`, `tenant_id`, `risk/effect class` keys are stripped before evaluation).
- Replay of a permission approval into a different call: non-ALLOW evaluations are cached for 30 s keyed by `(sessionID, callID, SHA-256 of the exact evaluated payload)` — mutated arguments under a reused callID always trigger a fresh kernel evaluation. `ALLOW` outcomes are never cached at all; every authorization is freshly evaluated. The cache is hard-bounded (256 entries, expired-sweep + oldest-eviction) so agent-driven unique denies cannot exhaust memory.
- Conflicting authority responses: if a kernel response carries verdict material in both contract fields (`verdict` and `decision.verdict`) and they disagree, the response fails closed as `KERNEL_MALFORMED_RESPONSE` — conflicts are never resolved in the permissive direction.
- Post-authorization argument mutation (three layers): (1) the kernel evaluates a **defensive copy** of the args snapshotted at hook entry; (2) after all evaluation awaits, the live args object is **re-hashed and compared** — any concurrent mutation during the evaluation window denies with `ARGS_MUTATED_DURING_EVALUATION`; (3) immediately after re-verification and **before any further await**, the authorized args object is **deep-frozen and the `output.args` slot sealed** (`writable:false, configurable:false`), so neither later plugins in opencode's sequential chain nor concurrent code holding a reference can mutate or replace what the kernel authorized — attempts throw in ESM strict mode, failing that code and blocking the call. Unserializable args (cyclic, BigInt) deny pre-execution with `EVIDENCE_SERIALIZATION_FAILURE`.
- Post-execution evidence failures (including hashing cyclic/BigInt/undefined payloads) never throw into the tool path — they are reported and arm a next-call deny gate in strict mode, so a retry with duplicate side effects is never induced.

**Not protected against (out of scope)**

- A compromised opencode host process (plugins are in-process; the host can skip or neuter hooks). True host-level enforcement needs the kernel PEP in front of the effect, e.g. MCP firewall or sandbox-runner.
- opencode's own permission ruleset allowing a tool before/without plugin hooks firing (see Known gaps).
- Other plugins rewriting verdicts via the same hook surface.
- **Residual argument-mutation limitation:** the freeze only covers mutation *by later plugin hooks*. Mutation of args by opencode internals or the tool itself *after* all `tool.execute.before` hooks return is unobservable from a plugin; equally, a plugin registered *before* this one sees pre-snapshot args (we evaluate what we receive, which is the correct post-their-mutation state). Closing the post-hook window requires host-level enforcement (kernel PEP / MCP firewall), not a plugin. Note the deliberate availability tradeoff: a tool that mutates its own args object during execution will hit the freeze and fail loudly — that is fail-closed by design, not a bug.
- Evidence-file tampering after write; the JSONL sink is a tap, not a transparency log. Verification happens when records are ingested and projected by HELM.

## Verification status

**Verified by tests** (`npm test`, 74 tests, no network/kernel required):

- Verdict mapping matrix and fail-closed behavior on every kernel failure class.
- Strict verdict parsing incl. near-miss and conflicting-field payloads.
- Loader/dispatch contract (`src/opencode-contract.test.ts`): the built module is loaded through a faithful replication of opencode's `readV1Plugin` default-export contract and `applyPlugin` instantiation (`server(input, options)`), and hooks are dispatched through a `Plugin.trigger`-equivalent loop with opencode's error-propagation semantics — a kernel DENY rejects in `tool.execute.before`, which is exactly the failure opencode's `session/tools.ts` observes as a blocked tool call; ALLOW passes and mints evidence through the full path.
- Boundary evidence records, cache bounding, transport rules, config typing.

**NOT verified:** behavior inside a real opencode process (opencode version drift, interplay with other plugins, TUI/config surfaces), and the `permission.ask` hook path in production (no trigger site at the studied commit — see Known gaps). The handwritten contract types in `src/opencode-types.ts` mirror `@opencode-ai/plugin` structurally; if opencode changes the hook contract, update the mirror and the contract test.

## Known gaps (audited against opencode @ `62e46412`, 2026-07-23)

- **`permission.ask` is declared but not triggered at the studied commit.** The hook exists in the plugin type surface (`packages/plugin/src/index.ts:261`) and is listed in the hook-surface docs, but no trigger call site was found in the clone (the V2 Effect permission service does not invoke it). This plugin implements the hook for forward compatibility; the enforcement that is live *today* is `tool.execute.before`. Defense in depth: if opencode starts triggering `permission.ask`, both paths consult the same fail-closed evaluation.
- `tool.execute.after` fires only for tools that actually executed; denied calls produce only the deny record (by design — there is no output to hash).
- ESCALATE blocks at `tool.execute.before` because opencode's "ask" UX is an in-memory, unsigned human reply; a governed escalation ceremony (signed approval with scope/expiry) is future work, tracked as a proposed sibling task.

## Development

```bash
npm run build   # tsc, strict, NodeNext ESM
npm test        # build + node --test over dist
```

Tests mock the kernel verdict source (fetch/spawn injected); no network or kernel binary is required. Layout:

- `src/verdict.ts` — strict verdict normalization + status mapping (unknown ⇒ deny).
- `src/kernel.ts` — `KernelClient` interface, HTTP + local-binary clients, non-throwing outcome type.
- `src/config.ts` — env/options resolution, fail closed on anything missing/invalid.
- `src/evidence.ts` — canonical JSON + SHA-256, boundary record types, JSONL/memory sinks.
- `src/plugin.ts` — hook bag (`permission.ask`, `tool.execute.before/after`), verdict cache, `HelmGovernanceDeny`.
- `src/opencode-types.ts` — structural mirror of `@opencode-ai/plugin` contract types (kept local so the package compiles without the opencode dependency tree).

Evidence base: `research/opencode-study/26-helm-map-kernel-governance.md` (integration seams) and `17-pkg-plugin-codemode.md` (plugin loading/hook semantics).
