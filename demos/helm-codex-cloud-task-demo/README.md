# HELM Codex Cloud Task Demo

This sample models a Codex cloud task as a bounded build-test-fix loop. The
fixture emits Agent Run Receipt v2 loop metadata and a deterministic
EvidencePack without running a live cloud task.

This is a HELM-compatible example, not upstream certification or HELM
conformance.

## Upstream

- Repository: https://github.com/openai/codex
- Pinned ref checked on 2026-06-22:
  `5f129a4703ceaf843e1cb6996bbf4a4f21225198`

## Scenario

| Intent | Expected verdict | Reason | Dispatch |
| --- | --- | --- | --- |
| Complete a build-test-fix loop as a reviewable patch | `ALLOW` | `CODEX_BUILD_TEST_FIX_ALLOW` | `false` |
| Attempt a protected-path mutation outside reviewable patch scope | `DENY` | `CODEX_PROTECTED_PATH_DENY` | `false` |

## Run

```bash
./demos/helm-codex-cloud-task-demo/run.sh --safe
python3 scripts/verify_samples.py
```

The safe harness does not require an OpenAI API key.
