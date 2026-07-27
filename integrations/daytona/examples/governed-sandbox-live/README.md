# Daytona Governed Sandbox — Runnable Demo

`run_live_demo.py` proposes three Daytona side effects, preflights each
through the HELM boundary, and dispatches only on ALLOW:

1. sandbox creation with unbounded egress — expected `DENY`, no dispatch
2. sandbox creation with a domain allowlist, lifetime, and resource caps —
   expected `ALLOW`; the verdict's constraints are compiled into Daytona
   create parameters
3. SSH grant into the sandbox — expected `ESCALATE`, no dispatch

## Offline (default)

```bash
python3 run_live_demo.py
```

No network, no accounts. A stub transport answers the evaluate calls with the
reference demo rules, nothing dispatches, and the run self-checks the expected
verdicts (exit code is non-zero on mismatch). Decision records land in
`./out/` as a hash-chained JSONL log.

## Live (opt in)

```bash
export HELM_URL=http://127.0.0.1:7714
export HELM_API_KEY=...      # tenant-scoped evaluate key
export HELM_TENANT_ID=...
export DAYTONA_API_KEY=...   # from the Daytona dashboard
pip install daytona
python3 run_live_demo.py --live
```

In live mode the verdicts come from the running HELM AI Kernel and are
reported, not asserted — the active policy owns the outcome. On ALLOW the
demo creates a real sandbox with the compiled constraints, runs one command,
and deletes the sandbox.

Sample-only demo. Verdict, receipt, and EvidencePack semantics remain owned
by `helm-ai-kernel`; the JSONL written to `./out/` is demo output, not an
EvidencePack.
