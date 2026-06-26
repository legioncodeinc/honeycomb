# PRD-062a: Query-Cost Instrumentation & Idle-Baseline Measurement

> **Parent:** [PRD-062: DeepLake Compute Cost Reduction](./prd-062-deeplake-compute-cost-reduction-index.md)
> **Status:** Backlog, draft (2026-06-26). Foundational, measure-first. Gates every later "we cut X%" claim.
> **Priority:** P0
> **Effort:** S–M
> **Schema changes:** Optional, additive (reuse existing `telemetry_counters` tenant group; default is log + in-memory only).

---

## Goals

Make the DeepLake compute cost **attributable**. Today the daemon issues reads and writes from many call sites (poll lease, reaper, capture write, fan-out enqueue, controlled write, recall arms, embedding) and nothing labels or counts them, so the cost split across PRD-062's three drivers is inferred from the cost curve, not measured. This sub-PRD adds a thin query meter at the DeepLake API call site that tags each operation with a `source` label and counts it, plus an **idle-baseline harness** that runs a daemon with an empty queue and no user activity and records reads/min. The output is the **before** number every later sub-PRD measures its **after** against.

This is the cost-anomaly playbook's step-1 (isolate and count) and step-3 (quantify blast radius) made into a reusable daemon facility rather than a one-off log grep.

## Non-Goals

- **No dashboard UI.** This is internal daemon telemetry for the incident, not a `/` page. PRD-060 owns user-facing cost.
- **No change to query behavior.** The meter only observes; it never reorders, batches, or suppresses a query. Those are 062b/c/d.
- **No always-on heavy persistence.** Default posture is in-memory counters + structured log lines; persisting to `telemetry_counters` is behind its own flag so the meter does not itself become a write-cost driver.

---

## User Stories

### US-62a.1 — Attribute every DeepLake query to a source

**As an** operator chasing the cost spike, **I want** every DeepLake read/write tagged with a `source` label and counted, **so that** I can say "idle baseline is X reads/min/daemon, of which Y% is polling" as a fact.

**Acceptance criteria:**
- AC-62a.1.1 Every DeepLake read/write passes through a meter that records a `source` ∈ `{poll-lease, poll-reaper, capture-write, fan-out-enqueue, controlled-write, recall-arm, embedding, other}` and increments a per-source counter.
- AC-62a.1.2 The meter adds negligible overhead (a counter increment + optional label), and adds **zero** additional DeepLake queries when in default log/in-memory mode.
- AC-62a.1.3 A diagnostic surface (log line on an interval and/or an existing diagnostics read-model field) exposes the current per-source counts for inspection.

### US-62a.2 — Establish an idle baseline

**As an** operator, **I want** a repeatable harness that measures a daemon's DeepLake reads/min with an empty queue and no user activity, **so that** the idle-poll baseline is a measured number and 062b's fix is provable.

**Acceptance criteria:**
- AC-62a.2.1 A documented procedure (or test harness) boots a daemon, leaves `memory_jobs` empty, generates no capture/recall, and records reads/min/daemon over a fixed window, broken down by `source`.
- AC-62a.2.2 The baseline run produces a short report (`reports/`-style) stating the idle reads/min and the polling share, which becomes the PRD-062 "before" figure.

---

## Technical Considerations

- **Single choke point.** Wrap the DeepLake API call site in the storage layer ([`src/daemon/storage/`](../../../../src/daemon/storage/)) so every read/write is metered in one place rather than instrumenting N call sites. The `source` label is threaded from the caller (cheap: a string passed through the existing call options) or inferred from a small call-context.
- **Counter shape.** In-memory `Map<source, {reads, writes}>` with periodic flush to a structured log; optional additive persistence as one `telemetry_counters` row per `(source, period)` via the existing tenant group ([`tenancy.ts`](../../../../src/daemon/storage/catalog/tenancy.ts)) behind `HONEYCOMB_QUERY_METER_PERSIST`.
- **No new egress, no new table.** Persistence reuses an existing group via additive schema healing; default is log-only.
- **Feeds, does not duplicate, PRD-060d.** If PRD-060 pollination metering wants these counts, expose them through the same counter, do not build a parallel meter.

## Files Touched

- **New:** a `query-meter.ts` (or equivalent) in [`src/daemon/storage/`](../../../../src/daemon/storage/); a baseline harness under `tests/` or `scripts/`.
- **Modified:** the DeepLake API wrapper / call site to invoke the meter; callers (lease, reaper, capture, fan-out, controlled-write, recall arms) to pass their `source` label; optionally [`tenancy.ts`](../../../../src/daemon/storage/catalog/tenancy.ts) for the additive counter columns; config provider for `HONEYCOMB_QUERY_METER_PERSIST`.

## Test Plan

- Unit: meter increments the right `source` counter for reads vs writes; default mode adds no DeepLake query.
- Harness: idle-baseline run records non-zero `poll-lease`/`poll-reaper` counts and ~zero capture/recall on an idle daemon.
- Vitest parity: metering is a pass-through; a metered query returns the same result as an unmetered one.

## Risks and Open Questions

- **Risk:** threading a `source` label through every call site is invasive. **Mitigation:** prefer a small call-context default of `other` so un-threaded sites still compile and are visibly "unlabeled" until labeled.
- **Open question:** persist to `telemetry_counters` (fleet rollup, small write cost) or log-only (zero cost, no rollup)? Default log-only; flag the persist. (Parent open question.)
- **Open question:** does this feed PRD-060d, or stay incident-internal? Expose the counter either way; the wiring to PRD-060 is a follow-up.
