# HELM LangGraph Evaluator Optimizer Demo

This sample models a LangGraph evaluator-optimizer loop that proposes connector
certification evidence. HELM escalates the result for human review and records
sample EvidencePack closure.

This is a HELM-compatible example, not upstream certification or HELM
conformance.

## Upstream

- Repository: https://github.com/langchain-ai/langgraph
- Pinned ref checked on 2026-06-22:
  `711b31550286585b3793857b2a99c8dafd98b785`

## Scenario

| Intent | Expected verdict | Reason | Dispatch |
| --- | --- | --- | --- |
| Propose connector certification from evaluator output | `ESCALATE` | `LANGGRAPH_CONNECTOR_CERTIFICATION_ESCALATE` | `false` |

## Run

```bash
./demos/helm-langgraph-loop-demo/run.sh --safe
python3 scripts/verify_samples.py
```

The safe harness does not require LangGraph dependencies.
