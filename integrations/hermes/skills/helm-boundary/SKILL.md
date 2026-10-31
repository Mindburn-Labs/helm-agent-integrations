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

Evaluate with `POST /api/v1/evaluate` on the kernel (`http://127.0.0.1:7714` unless configured). The route is tenant-scoped: it answers 401 without the bearer key and 403 without the tenant and principal headers. Take every header value from the integration's configuration, never from the model:

- `Authorization: Bearer <key>`, where the key is the kernel's `HELM_ADMIN_API_KEY`.
- `X-Helm-Tenant-ID` and `X-Helm-Principal-ID`, equal to the kernel's `HELM_RUNTIME_TENANT_ID` and `HELM_RUNTIME_PRINCIPAL_ID`.
- `X-Helm-Workspace-ID`, equal to `HELM_RUNTIME_WORKSPACE_ID`, when the kernel enforces a workspace scope.

Minimal body:

```json
{"action": "EXECUTE_TOOL", "resource": "tool.hermes.terminal", "args": {"command": "git push origin main"}, "session_id": "<Hermes session id>"}
```

`resource` is the action URN `tool.hermes.<tool>`, `args` are the exact arguments you intend to run, and `session_id` has no path separators. Principal and tenant are never body fields: the kernel takes identity from the headers and ignores any in the body. Do not lower the risk or effect class; the wrapper defaults to the conservative T2 and E4. `packages/python/helm_tool_wrapper` in `helm-agent-integrations` (`preflight_action`, `with_helm_boundary`) builds this request and its headers, and applies the rules below; use it when it is available.

Act on the verdict:

- `ALLOW`: run exactly the evaluated action, and only if the response carries a `receipt_id`. Attach the verdict, `decision_id` and `receipt_id` to the Kanban task. Changed arguments need a new evaluation.
- `DENY`: do not run it. Attach the verdict, `reason_code` and receipt to the task, say which side effect was blocked, and propose a safe alternative, evaluating it too if it is high-risk.
- `ESCALATE`: do not run it. Ask a human to approve, showing the receipt preview. Approval does not replace `ALLOW`: run only after HELM returns `ALLOW` for the action.

An unreachable kernel, an error, a missing or unknown verdict, or an `ALLOW` without a receipt counts as `DENY`. A 401 or 403 means the configured credentials or identity are wrong: report that, and do not try other identity values.
