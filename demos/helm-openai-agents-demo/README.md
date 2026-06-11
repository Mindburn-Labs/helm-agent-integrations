# HELM OpenAI Agents Demo

This demo models the OpenAI Agents SDK with tool calling routed through a HELM
proxy. The fixture demonstrates a mutating cloud tool call denied before the
tool function runs.

This is an integration fixture, not HELM conformance or upstream
certification.

## Upstream

- Repository: https://github.com/openai/openai-agents-python
- Pinned ref checked on 2026-06-11:
  `d8068d96a97dc3b42294a8c832072b16a5cb7f23`

## Scenario

| Intent | Expected verdict | Reason | Dispatch |
| --- | --- | --- | --- |
| Agent tool call requests an unapproved cloud delete | `DENY` | `CLOUD_MUTATION_NOT_WHITELISTED` | `false` |

## Run

```bash
./demos/helm-openai-agents-demo/run.sh --safe
python3 scripts/verify_samples.py
```

The safe harness does not require an OpenAI API key.
