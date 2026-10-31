---
name: helm-boundary
description: Gets a HELM AI Kernel verdict and receipt before a Hermes tool call runs. Use when a Hermes action has a high-risk side effect, such as a file-mutating command, push, publish, external send, payment or deploy.
version: 0.2.0
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

A high-risk action runs only after HELM AI Kernel returns `ALLOW` with a receipt. In every other case the side effect does not happen.

High-risk: shell commands that mutate files, git push, package publishing, outbound email or messages, credential access, database writes, cloud deploys, MCP tool calls with side effects, browser form submissions, and procurement, payment or vendor actions. Reading, searching and local drafting need no evaluation.

Evaluate with `POST /api/v1/evaluate` (kernel at `http://127.0.0.1:7714` unless configured; the key comes from `HELM_ADMIN_API_KEY`). Send the action URN (`tool.hermes.<tool>`, for example `tool.hermes.terminal`), the exact arguments you intend to run, and the session id. Principal, tenant, risk class and effect class come from the HELM configuration, never from the proposal, so do not supply them.

Act on the verdict:

- `ALLOW`: run exactly the evaluated action, and only if the response carries a `receipt_id`. Attach the verdict, `decision_id` and `receipt_id` to the Kanban task. Changed arguments need a new evaluation.
- `DENY`: do not run it. Attach the verdict, `reason_code` and receipt to the task, say which side effect was blocked, and propose a safe alternative, evaluating it too if it is high-risk.
- `ESCALATE`: do not run it. Ask a human to approve, showing the receipt preview. Approval does not replace `ALLOW`: run only after HELM returns `ALLOW` for the action.

An unreachable kernel, an error, a missing or unknown verdict, or an `ALLOW` without a receipt counts as `DENY`.
