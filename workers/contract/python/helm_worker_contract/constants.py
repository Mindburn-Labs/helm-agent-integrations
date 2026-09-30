"""Identifiers fixed by the HELM episode contract."""

from __future__ import annotations

EPISODE_SCHEMA = "helm.episode.v1"
STATUS_SCHEMA = "helm.episode.status.v1"
PROPOSAL_SCHEMA = "helm.proposal.v1"
REPORT_SCHEMA = "helm.report.v1"

# The A2A extension every worker declares as required on its AgentCard.
EXTENSION_URI = "urn:helm:a2a:episode:v1"
EPISODE_MEDIA_TYPE = "application/vnd.helm.episode.v1+json"
STATUS_MEDIA_TYPE = "application/vnd.helm.episode.status.v1+json"

A2A_VERSION = "1.0"
DEFAULT_TOKEN_ENV = "HELM_EPISODE_TOKEN"
# Secret the control plane presents to the worker's JSON-RPC endpoint.
INGRESS_TOKEN_ENV = "HELM_A2A_BEARER_TOKEN"

MODEL_API_ANTHROPIC = "anthropic-messages"
MODEL_API_RESPONSES = "openai-responses"
MODEL_API_CHAT = "openai-chat-completions"
MODEL_APIS = (MODEL_API_ANTHROPIC, MODEL_API_RESPONSES, MODEL_API_CHAT)

# MCP tool names (tool names use underscores; OpenAI-compatible APIs reject dots).
REPORT_TOOL = "helm_work_report"
DELEGATE_TOOL = "helm_work_delegate"
REQUEST_INPUT_TOOL = "helm_work_request_input"

# Terminal-state reason codes carried in helm.episode.status.v1 `error.code`.
REJECTED_CODES = ("INVALID_EPISODE", "MISSING_CREDENTIAL", "UNSUPPORTED_MODEL_API")
FAILED_CODES = (
    "NO_REPORT",
    "MODEL_ERROR",
    "TOOL_ERROR",
    "MAX_TURNS",
    "DEADLINE_EXCEEDED",
    "INTERNAL",
)
