# HELM × kubectl-ai — governed cluster operations demo

> **Sample-only integration demo.** Not HELM conformance, not a certified
> connector, not a production trust anchor. The Kernel remains the source of
> truth for verdicts, receipts, and EvidencePack semantics.

[`kubectl-ai`](https://github.com/GoogleCloudPlatform/kubectl-ai) turns natural
language into live `kubectl` invocations. Its `kubectl` tool executes commands
through a shell, which means **PATH resolution decides what `kubectl` runs**.
This demo places a HELM-governed shim at that seam so every LLM-proposed
cluster operation crosses the Kernel boundary *before* dispatch:

```text
kubectl-ai agent loop
    └─ "kubectl scale deploy/nginx --replicas=3"          (LLM-proposed)
        └─ PATH → kubectl-guard (this shim)
            ├─ parse + classify → read_only | mutating | destructive | exec_channel
            ├─ POST /api/v1/evaluate → ALLOW | DENY | ESCALATE (+ signed receipt)
            ├─ ALLOW      → exec real kubectl, receipt mirrored to JSONL
            ├─ ESCALATE   → block (exit 2) until HELM_APPROVAL_REF is supplied
            ├─ DENY       → block (exit 1), receipt recorded
            └─ no verdict → block (fail-closed) in enforce mode
```

## Command classes

| Class | Verbs | Demo policy verdict |
| --- | --- | --- |
| `read_only` | get, describe, logs, top, api-resources, version, explain, diff, wait, rollout status/history, config view, auth can-i | `ALLOW` |
| `mutating` | apply, create, patch, replace, scale, annotate, label, set, expose, autoscale, run, taint, cordon, rollout restart/undo, certificate approve | `ESCALATE` (approval required) |
| `exec_channel` | exec, cp, attach, port-forward, proxy, debug | `ESCALATE` (approval required) |
| `destructive` | delete, drain | `DENY` |

Unknown verbs are treated as `mutating` (fail-safe). `--dry-run=client|server`
downgrades a mutation to `read_only`. The policy lives in
[`policies/policy.kubectl.governed.toml`](../../policies/policy.kubectl.governed.toml)
with its reference pack in
[`policies/reference/policy.kubectl.governed.json`](../../policies/reference/policy.kubectl.governed.json);
these are the demo defaults, not a recommended production posture — a real
deployment typically DENY-gates destructive verbs per namespace/context rather
than globally.

## Quickstart (local, no cluster required for the fixture run)

```bash
# 1. Offline fixture check + shim unit tests (this is what CI runs)
./run.sh --safe

# 2. Live boundary walkthrough
cd ../../../helm-ai-kernel && make build
HELM_ADMIN_API_KEY=local-admin-key \
HELM_RUNTIME_TENANT_ID=local-demo \
HELM_RUNTIME_PRINCIPAL_ID=kubectl-ai-agent \
  ./bin/helm-ai-kernel serve \
  --policy <this-repo>/policies/policy.kubectl.governed.toml
```

Terminal 2 — install the shim and run commands through it:

```bash
mkdir -p ~/.local/helm-guard/bin
ln -sf "$(pwd)/kubectl_guard.py" ~/.local/helm-guard/bin/kubectl
export PATH="$HOME/.local/helm-guard/bin:$PATH"
export HELM_API_KEY=local-admin-key

kubectl get pods                      # ALLOW + receipt, dispatched
kubectl apply -f deploy.yaml          # ESCALATE, exit 2, approval instructions
kubectl delete namespace prod         # DENY, exit 1, receipt recorded
```

Approving a held mutation:

```bash
# Complete the approval ceremony for the printed decision id with your HELM
# operator flow, then re-run with the approval reference:
HELM_APPROVAL_REF=<approval-id> kubectl apply -f deploy.yaml
```

Receipts mirror to `~/.helm/kubectl-guard/receipts.jsonl`
(`HELM_KUBECTL_GUARD_RECEIPTS` overrides).

## With kubectl-ai

```bash
export PATH="$HOME/.local/helm-guard/bin:$PATH"   # shim first
export HELM_API_KEY=local-admin-key
export GEMINI_API_KEY=...
kubectl-ai --quiet "how is nginx doing in my cluster"   # reads flow through, receipts recorded
kubectl-ai "scale nginx to 3 replicas"                  # ESCALATE blocks the apply
```

The same shim governs any tool that shells out to `kubectl` (kubectl-ai's
`kubectl` *and* `bash` tools, Claude Code, Cursor, ad-hoc scripts) — PATH is
the chokepoint. Tools that talk to the API server through client-go instead of
the kubectl binary are **not** covered by this shim; they need an SDK-level
boundary (see the TypeScript/Python `withHelmBoundary` wrappers).

## Modes and failure behavior

- `HELM_KUBECTL_GUARD_MODE=enforce` (default): fail-closed. Kernel
  unreachable, HTTP error, timeout, or malformed verdict → command blocked.
- `HELM_KUBECTL_GUARD_MODE=observe`: shadow mode for rollout — logs the
  would-be verdict path and dispatches anyway. Use only while tuning policies.

## What this demo does not do

- It does not parse or lint manifests (`-f` contents are not inspected).
- It does not replace RBAC; it adds a pre-dispatch authority layer in front of it.
- It does not cover `kubectl-ai`'s MCP-client tools or non-kubectl tools.
- It is not a certification of kubectl-ai. Third-party review of kubectl-ai
  itself is a separate estate pipeline.
