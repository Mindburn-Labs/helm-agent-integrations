# Codex/Claude local Kernel preflight proof

This source-only runner builds a clean local `helm-ai-kernel` checkout and
exercises the real authenticated evaluate, receipt, and EvidencePack export
routes through `@mindburn/helm-tool-wrapper`.

It proves two bounded vectors:

- a normalized Codex `functions.exec_command` proposal receives `DENY` and the
  callback dispatch count remains zero;
- a normalized Claude Code `Read` proposal receives `ALLOW`, returns a durable
  preflight receipt, verifies the authenticated EvidencePack SHA-256, and only
  then invokes one in-process callback exactly once.

Run from this repository with a clean Kernel checkout:

```bash
HELM_KERNEL_ROOT=../helm-ai-kernel \
  ./conformance/helm-76-local-kernel/test.sh
```

The result records the exact Kernel commit and emits only non-secret proof
metadata. Temporary credentials, daemon state, and the compiled binary stay in
a temporary directory and are removed when the runner exits.

## Proof boundary

This is a HELM-compatible local preflight proof, not a HELM conformance
certificate. The allowed callback is deliberately local and inert. The runner
does not execute Codex or Claude providers, perform an external effect, attest
to tool output, reconcile post-effect state, or return a post-effect receipt.
