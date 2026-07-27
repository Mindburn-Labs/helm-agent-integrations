# Changelog

## Unreleased

- Added Daytona sandbox normalizers (`from_daytona_sandbox_create`,
  `from_daytona_process_exec`, `from_daytona_ssh_grant`) with fail-closed
  network normalization (`normalize_daytona_network`).
- Added reference-policy rules and generated samples for
  `SANDBOX_UNBOUNDED_EGRESS_DENY` and `SANDBOX_HUMAN_ACCESS_ESCALATE`.
- Added `integrations/daytona/` with a preflight example and an
  offline-runnable governed-sandbox demo with an opt-in live mode.

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

