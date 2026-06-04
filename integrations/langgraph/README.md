# LangGraph + HELM

LangGraph can keep durable orchestration and human-in-the-loop behavior while
HELM governs side-effectful tool nodes before execution.

Recommended first example:

```text
LangGraph agent proposes DROP TABLE customers.
HELM returns DENY.
The SQL tool is not dispatched.
```

Sample receipt:

```text
receipts/samples/langgraph-drop-table-deny.json
```
