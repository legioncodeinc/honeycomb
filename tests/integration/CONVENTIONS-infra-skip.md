# Live-Integration Suite — INFRA-DEGRADED → NEUTRAL Sentinel Contract

> **PRD-034a** (D-2 / FR-4 / a-AC-3). This file is the **verbatim contract** between the
> live-integration suite (Wave 1, owned by `deeplake-dataset-worker-bee`) and the
> `ci.yaml` `integration` job (Wave 2, owned by `ci-release-worker-bee`). The Wave-2 job
> consumes the signals defined here **as written** — do not rename a path or prefix without
> updating both sides.

## Why this exists

The live suite asserts what a **real user** depends on: correctness, tenancy isolation,
idempotency, no-data-loss-when-healthy, graceful degradation. It deliberately does **not**
assert that DeepLake answered fast this minute (those immediacy bars are now eventually-style
via `readConverged`).

But a **sustained backend outage** — every attempt returning a transient flap
(502 / 503 / 504 / 429 / timeout / connection-drop) **after** the storage client's own bounded
transient-retry has already given up — is **not a bug in our code**. The faithful outcome is:

- **NEVER a hard red** attributed to our code (the backend is down, not us).
- **NEVER a false green** (a correctness assertion that never ran is UNKNOWN, not PASS).
- A **NEUTRAL** "infra-unavailable" outcome — an explicit skip.

## The two signals (read by `ci.yaml`)

### 1. Sentinel marker FILE

- **Path:** `${HONEYCOMB_INFRA_SKIP_DIR:-./.infra-skip}/infra-degraded.json`
  - Default directory: `./.infra-skip/` (relative to repo root; **gitignored**).
  - Override the directory with the `HONEYCOMB_INFRA_SKIP_DIR` env var so the workflow can
    point it at a known/uploadable path. The **filename is fixed**: `infra-degraded.json`.
- **Presence semantics:** the file **exists after the run ⇒ the run is INFRA-DEGRADED (NEUTRAL)**.
  It is created the **first** time any test classifies its operation as sustained-transient.
  Absent file ⇒ a normal pass/fail run; the suite's exit code is authoritative.
- **Contents** (redaction-safe — no token, no org, no SQL body):

  ```json
  {
    "outcome": "infra-unavailable",
    "firstSeenIn": "<test/operation label>",
    "reason": "<statement kind + http status, e.g. \"query_error status=503\">",
    "transientFailures": 3,
    "at": "2026-06-21T12:00:00.000Z"
  }
  ```

### 2. Console LINE (transport-agnostic fallback)

A single line on **stdout**, beginning with the fixed prefix:

```
##honeycomb-infra-degraded## {"outcome":"infra-unavailable","firstSeenIn":"...","reason":"...","transientFailures":3,"at":"..."}
```

- Emitted by each test that classifies the run as degraded, **and once more at run end** by the
  Vitest reporter in `vitest.integration.config.ts` as `##honeycomb-infra-degraded## (run-final) <json>`.
- The workflow may grep for the prefix `##honeycomb-infra-degraded##` as a fallback if the
  filesystem artifact is unavailable.

## How `ci.yaml` (Wave 2) should consume it

After running `npm run test:integration` in the live `integration` job:

```yaml
# Pseudocode for the Wave-2 ci.yaml step — owned by ci-release-worker-bee.
- name: Run live integration suite
  id: itest
  run: npm run test:integration
  continue-on-error: true        # the suite's own exit code never hard-reds the gate

- name: Map sustained outage to NEUTRAL
  if: always()
  run: |
    if [ -f "./.infra-skip/infra-degraded.json" ]; then
      echo "infra-unavailable: live backend degraded — neutral, not a code red"
      # mark the job/check conclusion NEUTRAL (e.g. exit 0 + a neutral status,
      # or skip the required-check requirement). Do NOT fail the merge gate on it.
    elif [ "${{ steps.itest.outcome }}" != "success" ]; then
      exit 1                     # a genuine correctness/wiring red — surface it
    fi
```

The merge gate is the **deterministic** suite only (PRD-031 plain-CI + typecheck/unit/build/
audit). The live `integration` job runs nightly (`schedule`) + non-blocking on push +
`workflow_dispatch`, and maps this sentinel to NEUTRAL. Those wiring decisions live in
`ci.yaml` and are **out of scope for Wave 1** — this file only documents the contract Wave 2
reads.

## Invariants (do not weaken)

- **Infra-degraded is decided by the storage layer's own transient classification**
  (`isTransientResult`: 429 / 500 / 502 / 503 / 504 / timeout / connection-drop). A
  non-transient `query_error` (42P01 missing-table, a 400 syntax, a 401/403 permission) is a
  **real defect** — it is **never** neutralized; the suite must still go RED.
- **Only IMMEDIACY yields to the backend, never CORRECTNESS.** A test neutralizes itself only
  when its operation is *dominated* by transient failures (every attempt flapped after the
  client's retry). A single isolated blip does not neutralize a run that can still assert.
- **No secret in the sentinel.** Counts + a redacted reason (statement kind + HTTP status) +
  the test label only. Never a token, org, workspace, or SQL body.

## Source of truth

- Helper: [`tests/integration/_infra-skip.ts`](./_infra-skip.ts) — `neutralizeIfInfraDegraded`,
  `markRunInfraDegraded`, `isInfraTransient`, the path/prefix constants.
- Reporter: [`vitest.integration.config.ts`](../../vitest.integration.config.ts) — the
  `InfraDegradedReporter` that emits the run-final line.
