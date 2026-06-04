---
name: helm-boundary
description: Route high-risk Hermes tool use through HELM AI Kernel before execution and attach receipts to Kanban tasks.
version: 0.1.0
metadata:
  hermes:
    requires_toolsets:
      - terminal
      - file
      - web
      - kanban
      - memory
---

# HELM Boundary for Hermes

Before executing a high-risk action, create an action proposal and submit it to
HELM AI Kernel.

High-risk actions:

- shell commands that mutate files
- git push
- package publishing
- external email or message send
- credential access
- database writes
- cloud deploys
- MCP tool calls with side effects
- browser form submissions
- procurement, payment, or vendor actions

Process:

1. Classify the proposed action.
2. Build a HELM preflight payload.
3. Submit it to `POST /api/v1/evaluate`.
4. Respect `ALLOW`, `DENY`, and `ESCALATE`.
5. Dispatch only on `ALLOW`.
6. Attach decision and receipt metadata to the Hermes task.
7. If `DENY`, explain the blocked side effect and propose a safe alternative.
8. If `ESCALATE`, request human approval with the receipt preview.
