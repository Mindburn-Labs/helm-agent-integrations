# Mastra + HELM

Mastra tools can use `@mindburn/helm-tool-wrapper` or a small Mastra-specific
helper built on the same direct preflight contract.

The gap this repo closes first is intent normalization:

```ts
import { fromMastraToolCall } from "@mindburn/helm-tool-wrapper";
```
