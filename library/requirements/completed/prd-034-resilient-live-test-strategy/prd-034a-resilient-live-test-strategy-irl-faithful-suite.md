# PRD-034a: IRL-Faithful Live Suite + CI Re-Wiring

> **Parent:** [PRD-034](./prd-034-resilient-live-test-strategy-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M (3-8h)

## Scope

Rewrite the gated live itests so they assert what a real user depends on (correctness, tenancy isolation, idempotency, no-data-loss-when-healthy, graceful degradation) rather than impatient timing/exact-count invariants, classify a pure-infra outage as a NEUTRAL outcome, and re-wire `ci.yaml` so a push to main gates ONLY on the deterministic suite while the live suite runs nightly + as a non-blocking push check. This sub-PRD does NOT add the stress harness (PRD-034b) and does NOT change product/runtime code.

## Goals

- Keep every CORRECTNESS assertion; relax/remove every IMMEDIACY assertion.
- Stop the merge gate from red-ing on DeepLake weather (decouple push gating from the live backend).
- Preserve the live suite's regression-catching teeth on a healthy backend.
- Make a sustained backend outage resolve to a neutral "infra-unavailable" outcome, never a false green or a hard red.

## Non-Goals

- The stress harness + metrics report (PRD-034b).
- Any change to `src/` product code, the storage client, schema, or daemon API.
- Re-authoring the deterministic plain-CI assembled tests (PRD-031) — they remain the gate unchanged.

## User stories

- As a developer merging a PR, I want a green gate to mean "my code is correct," not "DeepLake happened to be healthy this minute," so I trust red main.
- As a maintainer, I want the nightly live run to still catch a genuine backend or wiring regression, so decoupling from the gate doesn't blind us.
- As an on-call dev, I want a backend outage to show as "infra-unavailable (skipped)" rather than a red attributed to our code, so I don't chase a non-bug.

## Functional requirements

- **FR-1 Correctness-vs-immediacy split.** Audit each live itest and tag every assertion as CORRECTNESS (right value, tenancy isolation, idempotency, no-data-loss-when-healthy, graceful degradation) or IMMEDIACY (exact-count-now, sub-second visibility, fixed tight per-test timeout). Keep correctness assertions strict; convert immediacy assertions to eventually-style via `readConverged` with generous budgets, or move them to PRD-034b.
- **FR-2 Realistic pacing.** Replace synthetic hammering (e.g. compaction's 50 sequential appends asserted to settle under a tight budget) with realistic volumes/pacing that still prove the invariant. Where a large volume is intrinsic to the proof, give it a generous budget and treat budget-exhaustion-under-degradation as FR-4 infra-skip, not failure.
- **FR-3 Generous/removed per-test deadlines.** Raise or remove the impatient per-test timeouts (60s/180s) that fire under backend latency; the suite proves "eventually correct," not "fast."
- **FR-4 Infra-outage → neutral skip.** Provide a run-level signal: when a run is dominated by transient infra failures (sustained 502/timeout after the bounded retries), the suite/workflow resolves to a NEUTRAL outcome ("infra-unavailable"), not a hard red and not a false green. A partial outage skips only the affected class where feasible; the healthy classes still assert.
- **FR-5 CI re-wiring — push gates deterministic only.** `ci.yaml`: the `integration` (live) job no longer runs on (or no longer gates) `push`. The merge gate is the deterministic jobs (`quality-gate` = typecheck + unit + assembled-with-fakes + dup + audit:sql, `windows-smoke`, plus build/audit:openclaw/pack-check). Preserve the `gate`→`has_token` skip-safe guard.
- **FR-6 Live runs nightly + push-soft.** The live job runs on the nightly `schedule` (regression canary) and, if kept on push at all, only as a NON-BLOCKING/soft check (e.g. its conclusion does not fail the required gate). Keep `workflow_dispatch` for manual runs.
- **FR-7 No-weakening guard.** A genuine wiring/correctness regression (wrong value, broken tenancy isolation, lost write on a healthy backend) must still FAIL the live suite — prove with a deliberately-broken control in the test design / review.

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | Given the live itests, when reviewed, then every assertion is classified correctness-vs-immediacy; correctness ones stay strict, immediacy ones are converted to eventually-style (generous `readConverged` budget) or moved to PRD-034b. |
| a-AC-2 | Given a HEALTHY backend, when the IRL-faithful live suite runs, then it passes; given a deliberately-introduced wiring regression (wrong value / broken tenancy isolation), it FAILS (teeth preserved). |
| a-AC-3 | Given a sustained 502/timeout window, when the suite runs, then it resolves to a neutral "infra-unavailable" outcome — not a hard red, not a false green. |
| a-AC-4 | Given `ci.yaml`, when a push to main runs, then the required merge gate is the deterministic suite only; the live job does not block the merge (nightly `schedule` + optional push-soft + `workflow_dispatch` only). |
| a-AC-5 | Given the `gate`→`has_token` guard, when a no-token run happens (fork/secret unset), then the live job still skips cleanly and the workflow stays green (skip-safe preserved). |
| a-AC-6 | Given the deterministic gate, when it runs, then `npm run ci`/`build`/`audit:sql`/`audit:openclaw`/smoke stay green and unit-count-stable. |

## Implementation notes

- The infra-outage signal can reuse the storage layer's existing transient classification (the same `isTransientResult` classes the retry uses): if after the bounded retries a run's failures are all transient-class, emit a run-level sentinel the workflow maps to a neutral conclusion (per the parent's open question — suite self-classifies, workflow maps).
- Compaction's AC-1/AC-4 are the prime example: keep "highest read is byte-identical" + "row count is bounded + non-increasing after settling" (correctness/invariant), but the exact "≤K within budget on a fixed deadline" becomes an eventually-style assertion or a stress-harness metric. The over-strict `settleDurablyAtOrUnder` budget that traded an over-count flap for a timeout flap is the thing to relax here.
- Reuse `readConverged` (PRD-028) for all "eventually" assertions — do not hand-roll new poll loops (jscpd-clean, one home).
- Keep throwaway `ci_*_<runId>` table isolation + DROP teardown; keep `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)`.

## Dependencies

- PRD-031 (the deterministic plain-CI assembled tests that become the sole push gate) + the `ci.yaml` `gate`→`has_token` structure.
- PRD-028 `readConverged` for eventually-style assertions.
- The storage transient classification (PRD-028 #50 + the idempotent-write retry) for the infra-outage signal.

## Related

- [parent index](./prd-034-resilient-live-test-strategy-index.md)
- [PRD-031 Live-integration test net](../../in-work/prd-031-live-integration-test-net/prd-031-live-integration-test-net-index.md)
- [PRD-028 Storage read-consistency](../prd-028-storage-read-consistency/prd-028-storage-read-consistency-index.md)
