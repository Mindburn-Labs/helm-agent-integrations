# Changelog

## Unreleased

- Added opt-in authenticated, content-hash-verified preflight EvidencePack
  exports to the TypeScript and Python tool wrappers, with workspace binding
  support, V5 input binding, and fail-closed Codex/Claude composition coverage.
- Added Daytona sandbox normalizers (`from_daytona_sandbox_create`,
  `from_daytona_process_exec`, `from_daytona_ssh_grant`) with fail-closed
  network normalization (`normalize_daytona_network`).
- Added reference-policy rules and generated samples for
  `SANDBOX_UNBOUNDED_EGRESS_DENY` and `SANDBOX_HUMAN_ACCESS_ESCALATE`.
- Added `integrations/daytona/` with a preflight example and an
  offline-runnable governed-sandbox demo with an opt-in live mode, verified
  against the live API on 2026-07-27 (SDK 0.176.0).
- Added a kernel-loadable policy and reference pack for the governed-sandbox
  demo, exercised against HELM AI Kernel v0.7.5.
- Added package-root runnable examples for all twelve framework intent
  normalizers in TypeScript and Python.
- Exposed the TypeScript example through the package export map and shipped
  the Python example as an installed module.
- Made CI execute both examples and isolated consumers installed from each
  package artifact, including the simulated preflight contract and default-deny
  no-dispatch vector.
- Added Python 3.9/3.12 type-check and lint coverage for the installed helper
  examples.
- Pinned the helper release tooling and switched JavaScript checks to `npm ci`
  for repeatable CI installs.
- Restored generated-sample verification on Python 3.9 with an explicit
  `tomli` compatibility dependency.
- Pinned the build backend and distribution validator compatibility layer for
  the organization-wide deterministic release gate.
- Added `demos/helm-kubectl-ai-guard-demo`: a PATH-level `kubectl` shim
  (`kubectl_guard.py`) that classifies kubectl-ai-proposed cluster operations
  (`read_only` / `mutating` / `exec_channel` / `destructive`), evaluates them
  against `POST /api/v1/evaluate` before dispatch, blocks on DENY/ESCALATE,
  forwards approval references, and mirrors receipts to JSONL. Fail-closed in
  enforce mode with an observe-mode shadow rollout. The shim binds the exact
  argv digest, preserves server dry-run effects, requires ALLOW references,
  scrubs HELM credentials before dispatch, and hardens its local receipt file.
- Added sample policy `policies/policy.kubectl.governed.toml` with reference
  pack and deterministic sample receipts/EvidencePacks for the read-only
  ALLOW, apply ESCALATE, and delete DENY scenarios.

## 0.1.0 - 2026-06-05

- Created public HELM-compatible agent integration repository.
- Added TypeScript `withHelmBoundary(...)` wrapper for direct
  `POST /api/v1/evaluate` preflight.
- Added Python `with_helm_boundary(...)` wrapper with sync and async support.
- Added demos for MCP boundary, OpenAI-compatible proxy, and generic tool
  wrappers.
- Added Hermes and OpenClaw example integration bundles.
- Added framework example surfaces for LangGraph, CrewAI, OpenAI Agents SDK,
  Google ADK, Mastra, Browser Use, E2B, Composio, LlamaIndex, and AG2.
- Added deterministic sample receipt and EvidencePack generation.
- Added GitHub Actions validation.
