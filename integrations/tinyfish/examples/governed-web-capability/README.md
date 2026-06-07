# Governed Web Capability Example

This example is fixture-only. It does not call TinyFish and does not require a
TinyFish API key.

The sample flow demonstrates four HELM decisions:

1. Search without a governed API key returns `DENY`.
2. Fetch with partial source errors returns `DENY`.
3. Browser credential use returns `ESCALATE`.
4. Agent external action returns `ESCALATE`.

Run local sample checks:

```bash
make verify-samples
```

Regenerate deterministic fixtures after editing scenarios:

```bash
python3 scripts/generate_samples.py
python3 scripts/generate_samples.py --check
```
