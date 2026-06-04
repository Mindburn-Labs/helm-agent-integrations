# Tool Wrapper Demo

This demo is the generic SDK path for framework tools, functions, actions, and
skills.

```text
Framework tool call
  -> withHelmBoundary / with_helm_boundary
  -> POST /api/v1/evaluate
  -> dispatch only on ALLOW
  -> return output plus decision/receipt metadata
```

## TypeScript

```bash
cd packages/js/helm-tool-wrapper
npm install
npm test
```

## Python

```bash
python3 -m unittest discover packages/python/helm_tool_wrapper/tests
```

## Integration Scenario

Generated sample:

```bash
cat receipts/samples/wrapper-email-escalate.json
```

Expected result:

- proposed Gmail send is classified as high-risk external send
- HELM verdict is `ESCALATE`
- wrapped function is not dispatched
