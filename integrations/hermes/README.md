# Hermes + HELM Boundary

Hermes is a strong fit for HELM-compatible examples because persistent agents
can run shell, file, browser, Kanban, memory, and MCP workflows over time.

This integration is optional. It does not change Hermes defaults and does not
claim upstream endorsement.

## Boundary Shape

```text
Hermes tool proposal
  -> classify side effect
  -> submit HELM ActionProposal via /api/v1/evaluate
  -> dispatch only on ALLOW
  -> attach decision and receipt metadata to Hermes task/Kanban handoff
```

## High-Risk Actions

- mutating shell commands
- git push or package publishing
- external email/message send
- credential access
- database writes
- cloud deploys
- MCP calls with side effects
- browser form submissions
- procurement, payment, or vendor actions

## Demo

Scenario: Hermes receives a cleanup task and proposes:

```bash
rm -rf ./dist ./node_modules ./secrets
```

Expected HELM result:

- verdict: `DENY`
- reason: forbidden path
- dispatch: false
- receipt: `receipts/samples/hermes-dangerous-shell-deny.json`
- EvidencePack: `evidencepacks/samples/hermes-dangerous-shell-deny.tar`

## Local Commands

```bash
python3 scripts/generate_samples.py
python3 scripts/verify_samples.py
cat receipts/samples/hermes-dangerous-shell-deny.json
```

## Maintainer Framing

This example should be submitted upstream only as an optional security example:

```text
This PR adds an optional HELM AI Kernel example for routing high-risk Hermes
side effects through a local fail-closed execution boundary and attaching
receipt metadata to task handoffs.
```
