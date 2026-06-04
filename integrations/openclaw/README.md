# OpenClaw + HELM Safe Mode

OpenClaw-style agents emphasize doing real work: sending email, changing
calendar events, checking in for flights, and operating across logged-in tools.
HELM Safe Mode is an optional execution boundary example for those side effects.

This integration is not an upstream partnership or certification claim.

## Boundary Shape

```text
OpenClaw skill call
  -> classify skill capability
  -> submit HELM preflight via /api/v1/evaluate
  -> dispatch only on ALLOW
  -> surface receipt metadata in the skill result
```

## Skill Manifest Extension

```yaml
name: gmail-send
description: Send email through Gmail
helm:
  action_urn: tool.gmail.send_email
  risk_class: T2
  effect_class: IRREVERSIBLE
  requires_approval: true
  evidence_required: true
```

## Demo

Scenario: user asks OpenClaw to handle an investor follow-up.

Expected HELM result:

- draft may be prepared
- external send escalates
- dispatch is false until approved
- receipt: `receipts/samples/openclaw-email-escalate.json`
- EvidencePack: `evidencepacks/samples/openclaw-email-escalate.tar`

## Maintainer Framing

```text
OpenClaw proved people want agents that do real work.
HELM makes that work governable.
```

Avoid language that attacks OpenClaw or implies upstream endorsement.
