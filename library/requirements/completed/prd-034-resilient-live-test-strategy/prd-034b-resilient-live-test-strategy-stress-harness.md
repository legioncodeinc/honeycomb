# PRD-034b: On-Demand DeepLake Stress Harness + Metrics Report

> **Parent:** [PRD-034](./prd-034-resilient-live-test-strategy-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M (3-8h)

## Scope

Build a deliberate, parameterized DeepLake load generator that keeps the strict, hammering, concurrent patterns the IRL-faithful suite (PRD-034a) sheds — and turns them into a diagnostic instrument that EMITS A METRICS REPORT rather than a pass/fail build status. It runs ONLY on demand (`npm run deeplake:stress` + a `workflow_dispatch` CI job), never on push, and never gates. Its purpose is to reproduce the backend's slowness/error behavior on command and produce a clean, reproducible artifact to bring to the DeepLake vendor.

## Goals

- Reproduce, on demand, the load that surfaces DeepLake's latency/error behavior (sequential append bursts, immediate read-backs, exact-count compaction, concurrent writers).
- Emit a METRICS REPORT — human summary + machine-readable JSON — quantifying latency, error rates, eventual-consistency convergence time, and throughput.
- Make it parameterized (concurrency, table-size/iteration dials) and reproducible (fixed seed) so the vendor can re-run it.
- Keep it strictly out of the merge path: on-demand only, never gates.

## Non-Goals

- The IRL-faithful gating suite (PRD-034a).
- Any product/runtime code change, schema change, or daemon API change.
- A long-running soak/endurance mode (single bounded run only in v1; duration/soak can be a later dial).
- Fixing DeepLake — this measures + documents the backend; the fix is the vendor's.

## User stories

- As an engineer, I want to run one command and get DeepLake latency/error metrics against our endpoint, so I can decide whether the backend is the problem.
- As a maintainer escalating to the vendor, I want a reproducible script + a metrics report (p99 latency, 502 rate at concurrency N, write→read convergence time), so my complaint is evidence, not anecdote.
- As a developer, I want to dial concurrency/table-size, so I can find where the error rate climbs.

## Functional requirements

- **FR-1 Load generator.** A harness (suggest `src/eval/deeplake-stress.ts` + helpers, mirroring the `src/eval/` recall-eval pattern) that drives configurable workloads through the storage client against a throwaway namespaced table (`ci_stress_<runId>`), DROP-on-teardown: sequential append bursts, immediate read-backs, compaction (seed N versions → compact → verify), and concurrent writers.
- **FR-2 Metrics — latency.** Record per-statement-kind (INSERT / SELECT / DELETE / UPDATE) latency and report p50/p95/p99/max (+ mean, count).
- **FR-3 Metrics — error rate by status.** Count outcomes broken down by HTTP status / error class (ok, 429, 500, 502, 503, 504, timeout, connection) and by statement kind; report rates.
- **FR-4 Metrics — eventual-consistency convergence time.** After a write returns ok, poll-read the same key and record the time until the read reflects the write; report the convergence-time distribution (p50/p95/p99/max). This is the headline vendor metric.
- **FR-5 Metrics — throughput + concurrency scaling.** Report ops/sec; run at multiple concurrency levels (the dial) and report how error rate + latency scale with concurrency.
- **FR-6 Tuning dials.** Accept parameters — concurrency level(s), table size / iteration count, statement-mix — via CLI flags/env, with sane defaults. A fixed seed makes a run reproducible.
- **FR-7 Report output.** Emit BOTH a readable human summary (table to stdout) AND a machine-readable JSON artifact (to a gitignored local path for `npm run`, and uploaded via `actions/upload-artifact` for the CI job). The report carries NO secret (token/endpoint/full-org redacted — reuse the client redaction).
- **FR-8 On-demand only, never gates.** Wired as `npm run deeplake:stress` + a `workflow_dispatch` CI job (token-gated, skip-safe). It is NEVER triggered on push/PR and NEVER part of the merge gate. Its "failure" (a saturated backend) is data, not a broken build — the job surfaces the report regardless of pass/fail.

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | Given `npm run deeplake:stress` with creds, when it runs, then it drives the configured load against a throwaway table and DROPs it on teardown (no pollution of real tables). |
| b-AC-2 | Given a completed stress run, when the report is produced, then it includes per-statement-kind latency p50/p95/p99/max. |
| b-AC-3 | Given a completed stress run, then the report includes error rate broken down by HTTP status (429/5xx/timeout/connection) and by statement kind. |
| b-AC-4 | Given writes during the run, then the report includes the eventual-consistency convergence-time distribution (time from write-ok to read-reflects-write). |
| b-AC-5 | Given concurrency + table-size parameters, when passed, then the harness honors them and reports throughput + how the error rate scales with concurrency; a fixed seed makes the run reproducible. |
| b-AC-6 | Given the harness, when CI runs on push/PR, then it NEVER executes and NEVER gates; it runs only via `workflow_dispatch` (or `npm run` locally) and emits the JSON + human report as an artifact. |
| b-AC-7 | Given any report, when inspected, then it carries no token, endpoint credential, or full org GUID (redaction proven). |

## Implementation notes

- Mirror the `src/eval/` harness shape from PRD-027 (loader + runner + a metrics module of pure functions) so percentile/distribution math is unit-testable with hand-computed fixtures (no live backend needed for the metric-math tests).
- Drive load through the SAME storage client the product uses (so the measured latency/errors reflect real code paths, including the retry layer) — but record RAW per-attempt outcomes for the report (so the report shows the backend's true error rate, not just the post-retry success rate). Capture both: raw attempts and post-retry effective rate.
- Reuse the throwaway-table + DROP convention and `describe.skipIf`/token-gating discipline from the live itests; the harness itself is a script, not a vitest gate.
- The `workflow_dispatch` job passes the four `HONEYCOMB_DEEPLAKE_*` secrets via `env:` exactly like the existing `integration` job, and uploads the JSON report via `actions/upload-artifact`.
- Unit tests cover the metrics math (percentiles, convergence-time bucketing, error-rate-by-status) deterministically; the live run is the on-demand proof.

## Dependencies

- PRD-027 `src/eval/` metrics-harness pattern (loader/runner/pure-metrics shape).
- The storage client + its transient classification (to record raw vs post-retry outcomes).
- The `ci.yaml` secret-gate (`gate`→`has_token`) + the `HONEYCOMB_DEEPLAKE_*` secrets for the `workflow_dispatch` job.

## Related

- [parent index](./prd-034-resilient-live-test-strategy-index.md)
- [PRD-027 Recall ranking & eval](../../in-work/prd-027-recall-ranking-and-eval/prd-027-recall-ranking-and-eval-index.md)
- [PRD-028 Storage read-consistency](../../in-work/prd-028-storage-read-consistency/prd-028-storage-read-consistency-index.md)
