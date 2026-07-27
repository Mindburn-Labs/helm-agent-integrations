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

## Verified against the live API (2026-07-27, SDK 0.176.0)

The dispatch path was exercised against a real account. A sandbox created from
the compiled constraints reports them back over the REST API:

```json
{
  "networkAllowList": "10.0.0.0/8,192.168.0.0/16",
  "networkBlockAll": false,
  "autoStopInterval": 15,
  "autoDeleteInterval": 0,
  "labels": {"helm.decision_id": "...", "helm.session_id": "..."}
}
```

Three constraints of the SDK surface shaped `compile_create_params`:

- `create()` takes a `CreateSandboxFromSnapshotParams` object, not keyword
  arguments.
- `network_allow_list` is a comma-separated **CIDR string**. The SDK exposes no
  domain allowlist field, so a domain-scoped permit condition cannot be
  compiled through this path.
- Resource caps live on `Resources`, which only the image-based create path
  accepts; sandboxes created from a snapshot inherit that snapshot's preset.

Sample-only demo. Verdict, receipt, and EvidencePack semantics remain owned
by `helm-ai-kernel`; the JSONL written to `./out/` is demo output, not an
EvidencePack.
