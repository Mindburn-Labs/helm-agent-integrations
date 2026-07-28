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

`policy/` holds a kernel-loadable policy and reference pack for this demo.
Start a kernel with it, then run the demo against it:

```bash
helm serve -policy policy/daytona.governed.toml -port 7714 -data-dir ./data
```

The kernel needs these in its environment: `HELM_ADMIN_API_KEY` (the key the
demo sends), and `HELM_RUNTIME_PRINCIPAL_ID=daytona-demo-agent` to bind the
principal the demo presents. The tenant defaults to `default`.

```bash
export HELM_URL=http://127.0.0.1:7714
export HELM_API_KEY=...       # must match the kernel's HELM_ADMIN_API_KEY
export HELM_TENANT_ID=default
python3 run_live_demo.py --live
```

Verdicts now come from the kernel and are reported, not asserted — the active
policy owns the outcome. Observed against kernel v0.7.5:

```text
unbounded-create: DENY (MISSING_REQUIREMENT)
allowlisted-create: ALLOW
ssh-grant: DENY (PDP_DENY)
```

Dispatch is separate. Export `DAYTONA_API_KEY` and `pip install daytona` to
have an ALLOW create a real sandbox with the compiled constraints, run one
command, and delete it. Without it the verdict is still reported and the
skipped dispatch is recorded — so the gate can be verified with a kernel
alone.

Two things the demo policy makes explicit:

- Policy expressions read the wrapper's normalized fields through
  `input.effect.params.*` — the egress rule is
  `input.effect.params.metadata.network != 'external'`.
- A reference pack grants by action; an action it does not list is denied.
  ESCALATE is not expressible this way, so `ssh_grant` returns DENY here
  rather than the ESCALATE the offline stub returns.

## Verified against the live Daytona API (2026-07-27, SDK 0.176.0)

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
