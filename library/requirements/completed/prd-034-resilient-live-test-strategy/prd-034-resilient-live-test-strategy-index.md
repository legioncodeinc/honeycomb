# PRD-034: Resilient Live-Test Strategy

> **Status:** Completed
> **Priority:** P1
> **Effort:** L (1-3d)
> **Schema changes:** None

---

## Overview

The live-integration suite runs ~25 real-round-trip itests against a shared external DeepLake backend on every push to main, with tight per-test timeouts and exact-count / sub-second-visibility assertions. That conflates two jobs that should be separate: *"does the product work for a user?"* and *"is the DeepLake backend healthy / where are its limits?"*. The second keeps poisoning the first — main reds whenever DeepLake has a slow or 502-heavy window (a property no PR can control), which trains the team to ignore red main and lets real regressions hide in the noise. Meanwhile the product is fine IRL because the daemon is fail-soft and humans impose no millisecond deadlines.

This PRD splits the strategy by PURPOSE: (a) an **IRL-faithful live suite** that asserts the invariants a real user depends on — correctness, tenancy isolation, no-data-loss-when-healthy, graceful degradation — with generous/absent immediacy bounds and an infra-outage→neutral-skip policy, so it never reds the merge gate on backend weather; and (b) an **on-demand DeepLake stress harness** that keeps the strict, hammering, concurrent patterns and turns them into a parameterized load generator that EMITS A METRICS REPORT (latency percentiles, HTTP-status error rates, eventual-consistency convergence time, throughput-vs-concurrency) — a reproducible artifact to bring to the DeepLake vendor.

The deterministic suite (typecheck + unit + assembled-with-fakes tests from PRD-031, all backend-independent) remains the hard gate on every push. This PRD does not change product code behavior; it changes WHAT the test layer asserts and WHERE/HOW each suite runs.

---

## Goals

- Make a green merge-gate mean *"the product works"* — gate `push` to main on the deterministic suite only (backend-independent), so main never reds on DeepLake weather.
- Rewrite the live itests to be IRL-faithful: keep every CORRECTNESS assertion (right value, tenancy isolation, idempotency, no-data-loss-when-healthy, graceful degradation), relax or remove IMMEDIACY assertions (exact-count-now, sub-second visibility, tight per-test timeouts), and classify a pure-infra outage (sustained 502 / timeout window) as a NEUTRAL SKIP, not a failure.
- Run the IRL-faithful live suite nightly (regression canary) and as a non-blocking (soft) check on push — informative, never merge-blocking.
- Build an on-demand DeepLake stress harness (`npm run deeplake:stress` + a `workflow_dispatch` CI job) that reproduces the strict load on demand and emits a metrics report: per-statement-kind latency p50/p95/p99/max, error rate by HTTP status (429/500/502/503/504), eventual-consistency convergence-time distribution, throughput (ops/sec), and how error rate scales with concurrency — with concurrency and table-size tuning dials and a fixed seed for vendor-reproducibility.

## Non-Goals

- Changing product/runtime behavior. The retry/poll-convergence/fail-soft mechanics already shipped (PRD-028 read retry, the idempotent-write retry, `readConverged`) are not re-litigated here; this PRD consumes them.
- Making the live suite immune to a total backend outage. A sustained DeepLake outage will still mean "we could not verify live behavior" — that resolves to a neutral skip, never a false green and never a hard red.
- Provisioning larger CI runners (separate infra decision; the bottleneck here is backend latency, not CI CPU).
- Authoring the deterministic plain-CI assembled tests — those already exist (PRD-031) and are reused as the gate unchanged.
- Any change to the DeepLake schema, the storage client, or the daemon API surface.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-034a-resilient-live-test-strategy-irl-faithful-suite`](./prd-034a-resilient-live-test-strategy-irl-faithful-suite.md) | Rewrite live itests to assert correctness-not-immediacy + infra-outage→neutral-skip; re-wire `ci.yaml` so push gates on the deterministic suite only and the live suite runs nightly + push-soft. | Draft |
| [`prd-034b-resilient-live-test-strategy-stress-harness`](./prd-034b-resilient-live-test-strategy-stress-harness.md) | On-demand DeepLake stress harness: parameterized load generator + metrics report (latency percentiles, status-code error rates, convergence-time, throughput-vs-concurrency) behind `npm run deeplake:stress` + a `workflow_dispatch` job. | Draft |

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a push to main while the DeepLake backend is slow or 502-heavy, when CI runs, then the merge-gating result is determined ONLY by the deterministic suite (typecheck + unit + assembled-with-fakes + build + audits); the live suite does not block the merge. |
| AC-2 | Given the IRL-faithful live suite on a HEALTHY backend, when it runs, then it asserts and passes every correctness invariant (right value, tenancy isolation, idempotency, no-data-loss); a deliberately-introduced wiring regression makes it FAIL (it still has teeth). |
| AC-3 | Given a sustained backend outage (all attempts dominated by 502/timeout), when the IRL-faithful live suite runs, then the run resolves to a NEUTRAL SKIP/“infra-unavailable” outcome — never a false green and never a hard red attributed to our code. |
| AC-4 | Given the live suite is wired, when triggers fire, then it runs on the nightly `schedule` and as a NON-BLOCKING check on push; it is removed as a required merge gate. |
| AC-5 | Given `npm run deeplake:stress` (or the `workflow_dispatch` job) with creds, when it runs, then it emits a metrics report covering per-statement-kind latency p50/p95/p99/max, error rate by HTTP status, eventual-consistency convergence-time distribution, and throughput — as a human summary AND a machine-readable JSON artifact. |
| AC-6 | Given the stress harness, when invoked with concurrency and table-size parameters, then it honors them (a fixed seed makes a run reproducible) and reports how the error rate scales with concurrency — usable as a repro to hand the DeepLake vendor. |
| AC-7 | Given the whole change, when the deterministic gate runs, then it stays green + unit-count-stable, and `npm run ci`/`build`/`audit:sql`/`audit:openclaw` remain green; the stress harness never runs on push and never gates. |

---

## API changes

None. No daemon endpoints added or changed. New developer entry points only: an `npm run deeplake:stress` script and a `workflow_dispatch` CI job.

---

## Open questions

- [ ] Where does the stress-harness JSON artifact live for sharing — uploaded as a CI `actions/upload-artifact` only, or also written to a gitignored local path for the `npm run` invocation? (Lean: both — CI artifact + gitignored local `./.stress-report/`.)
- [ ] For AC-3's "neutral skip", is GitHub's job-level `if`/outcome enough, or do we need the suite to self-classify (emit a sentinel exit code the workflow maps to neutral) so a *partial* outage still skips only the affected classes? (Lean: suite self-classifies a run-level "infra-degraded" signal; the workflow maps it to a non-failing conclusion.)

---

## Related

- [PRD-031 Live-integration test net](../in-work/prd-031-live-integration-test-net/prd-031-live-integration-test-net-index.md) — the plain-CI assembled tests + scheduled-live architecture this builds on.
- [PRD-028 Storage read-consistency](../prd-028-storage-read-consistency/prd-028-storage-read-consistency-index.md) — `readConverged`, reused for the "eventually" assertions.
- [PRD-027 Recall ranking & eval](../in-work/prd-027-recall-ranking-and-eval/prd-027-recall-ranking-and-eval-index.md) — the `src/eval/` harness + metrics pattern the stress report mirrors.
- [DeepLake eventual-consistency poll reads](../../../.claude/projects/) — every live read-back polls to convergence (project memory).
