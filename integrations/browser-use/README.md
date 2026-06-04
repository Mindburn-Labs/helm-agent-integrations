# Browser Use + HELM

Browser agents should preflight irreversible browser actions before dispatch:

- form submit
- checkout
- login
- file upload
- email or message send
- payment
- admin mutation
- CRM update
- calendar booking

Use `fromBrowserUseAction(...)` plus `withHelmBoundary(...)` to normalize and
gate the action.

Sample receipt:

```text
receipts/samples/browser-submit-escalate.json
```
