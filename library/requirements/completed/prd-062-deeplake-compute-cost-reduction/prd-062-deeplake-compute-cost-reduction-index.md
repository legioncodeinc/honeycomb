# PRD-062: DeepLake Compute Cost Reduction

> **Status:** Backlog, draft (2026-06-26). 4 sub-PRDs, not started. **P0 incident response.**
> **Priority:** P0 (active user exodus; DeepLake compute cost is rising faster than install count and is attributed by users to the new Honeycomb version)
> **Effort:** L (a measure-first instrumentation pass, an idle-baseline poll fix, a capture write-path rework, and a fan-out/recall amplification fix; spans the daemon job queue, capture intake, pipeline, and recall, but no schema-of-record change)
> **Schema changes:** Additive only, and minimal. No new table. Optional additive telemetry counters reuse the existing `telemetry_counters` tenant group (062a). Capture envelope trimming (062c) changes *what we write into an existing column*, not the column set.

---

## Overview

The new version of Honeycomb is burning DeepLake compute at a rate that tracks **install count, not usage**, and users are leaving over the bill. The compute-hours curve is flat through the pre-rollout window and then ramps steadily as the fleet grows, which is the signature of a **fixed per-daemon cost that every running install pays whether or not the user does anything**. The CTO's read ("it does periodic polling from the jobs table, you can just throttle it") is correct about the mechanism; this PRD treats throttling as the **largest** lever but not the **only** one, and it refuses to ship a blind throttle without first measuring where the queries actually go.

The cost decomposes into three application-layer drivers, in descending order of suspected blast radius:

```
DeepLake compute ≈ idle-poll baseline (CONSTANT per daemon)
                 + capture write cost   (scales with user activity)
                 + fan-out + recall amp (scales with user activity, multiplicatively)
```

> **Driver 1, the idle-poll baseline (CONSTANT, the prime suspect).** Two independent workers each poll the DeepLake-backed `memory_jobs` queue on a hardcoded **1000ms** timer: the pipeline stage worker ([`stage-worker.ts:158`](../../../../src/daemon/runtime/pipeline/stage-worker.ts), `DEFAULT_POLL_INTERVAL_MS = 1_000`) and the pollinating worker ([`pollinating/worker.ts:151`](../../../../src/daemon/runtime/pollinating/worker.ts)). Worse, a single `lease()` is **not one query**: the queue is append-only, so lease/reaper discovery does a **UNION-ALL scan polled `DISCOVERY_SCAN_POLLS` times** with `version DESC` resolution to defeat DeepLake's stale-segment flapping ([`services/job-queue.ts:34,231,240`](../../../../src/daemon/runtime/services/job-queue.ts), and the eventual-consistency convergence posture this repo already documents). So each 1Hz tick fans into **several physical DeepLake reads**, on **every running daemon, forever, at zero user activity**. This is the curve in the cost chart.
>
> **Driver 2, the capture write cost (scales with activity).** Every captured hook event writes **one append-only row** to the `sessions` table whose `message` column is the **full normalized envelope**, `JSON.stringify({ event, metadata })` ([`capture-handler.ts:285`](../../../../src/daemon/runtime/capture/capture-handler.ts)), including, for tool calls, the **entire serialized tool input and response**. Writes are **one row per event, never batched** ([`capture-handler.ts:218`](../../../../src/daemon/runtime/capture/capture-handler.ts)), and each carries metadata that is largely identical turn to turn. This is the "insane amount of extra JSON metadata" the operator observed.
>
> **Driver 3, fan-out + recall amplification (scales multiplicatively).** One captured event enqueues one extraction job, which fans to one decision job, which fans to **N controlled-write jobs, one per extracted fact** ([`pipeline/fan-out.ts:137`](../../../../src/daemon/runtime/pipeline/fan-out.ts)). Every one of those jobs is another `memory_jobs` row write *and* more work for the 1Hz pollers to discover. Separately, every recall fires **4+ concurrent arms** (semantic + 3 lexical) with **no semaphore** ([`memories/recall.ts:1905`](../../../../src/daemon/runtime/memories/recall.ts)), and semantic arms fan out further, so a burst of recalls multiplies query load with no ceiling.

The honesty discipline of this PRD is **measure before you cut**. The cost-anomaly playbook this work follows ([`.claude/skills/cost-anomaly-diagnosis`](../../../../.claude/skills/cost-anomaly-diagnosis/SKILL.md)) is explicit: cost storms are almost always application-layer concurrent dispatch, and you quantify the blast radius before you design the fix. So **062a instruments query counts by source** (poll vs capture vs fan-out vs recall) and establishes an idle baseline, and every later sub-PRD states its win as a **measured before/after**, not a hope.

Three product decisions are **locked** by the operator going in:

> **Locked 1, idle daemons must go quiet.** A daemon with an empty queue and an idle user must not poll DeepLake at a flat 1Hz. The target steady-state idle cadence is on the order of **once every 30s**, reached by exponential backoff that **resets to fast on the first real job**, so active-session latency is unchanged.
> **Locked 2, no behavior regressions to recall or memory quality.** This is a cost fix, not a capability cut. Recall results, memory extraction, and skillify output must be unchanged within tolerance; the only user-visible deltas are (a) a slightly longer worst-case pickup latency for a job enqueued into a fully-idle daemon, bounded by the backoff cap, and (b) nothing else.
> **Locked 3, ship the cheapest high-leverage fix first, behind a flag, measured live.** 062b (the poll backoff + single-lease consolidation) is the highest-leverage, lowest-risk change and ships first behind an env flag with the 062a telemetry proving the drop, before the write-path and amplification work.

The four sub-PRDs cover: query-cost instrumentation and idle-baseline measurement (062a, foundational), adaptive poll backoff + single-lease consolidation (062b, the dominant idle fix), capture write batching + envelope trimming (062c, the metadata-bloat fix), and pipeline fan-out coalescing + recall concurrency caps (062d, the amplification fix).

---

## Goals

- **Measure the cost split first.** A daemon-side query meter (062a) attributes DeepLake reads/writes to a `source` label (`poll-lease` / `poll-reaper` / `capture-write` / `fan-out-enqueue` / `controlled-write` / `recall-arm` / `embedding`), so the team can state "idle baseline is X reads/min/daemon, of which Y% is polling" as **fact**, not inference, and can prove each later fix landed.
- **Collapse the idle-poll baseline by 1–2 orders of magnitude** (062b) via exponential poll backoff (fast → ~30s cap, reset-on-job) **and** consolidation of the two independent 1Hz pollers into a single lease pass over `memory_jobs`, with **no change to active-session job pickup latency**.
- **Cut per-event write cost** (062c) by batching capture inserts over a short window into multi-row appends and by **trimming the persisted envelope** (cap oversized tool I/O, drop redundant per-row metadata), without losing any field the extractor or recall actually consumes.
- **Cap the amplification** (062d): coalesce the per-fact controlled-write fan-out where safe, and put a bounded-concurrency semaphore in front of the recall arms so a recall burst cannot issue unbounded concurrent DeepLake queries.
- **Every cut is flagged and reversible.** Each behavior change lands behind an env flag with a documented default, so the fleet can roll forward conservatively and a regression can be turned off without a redeploy.
- **No memory-quality regression.** Recall/extraction/skillify parity is an acceptance criterion, asserted by the live integration net, not assumed.

## Non-Goals

- **Re-architecting the queue off DeepLake.** Moving `memory_jobs` to a real message broker (Redis, SQS, NATS) or to a local SQLite WAL would end polling entirely, but it is a **much larger** change with its own schema, ops, and tenancy story. This PRD makes the **existing** DeepLake-backed queue cheap to poll; a broker migration is a separate, later proposal and is explicitly out of scope here.
- **Turning off embeddings or changing the embedding model.** The embeddings runtime ([embeddings-runtime](../../../knowledge/private/ai/embeddings-runtime.md) territory) is its own cost lever owned elsewhere; this PRD does not touch the embed daemon, model, or dimension.
- **Reducing what memory we *keep*.** Compaction/retention of stored memories (PRD-030) is a different axis. 062c trims the *capture envelope at write time*; it does not retro-compact or delete existing rows.
- **A new dashboard surface for cost.** The ROI Tracker ([PRD-060](../prd-060-roi-tracker/prd-060-roi-tracker-index.md)) is the user-facing cost-and-savings ledger. 062a's meter is **internal daemon telemetry for this incident**, not a new `/` page; it may *feed* PRD-060d (pollination cost metering) but does not build UI.
- **Changing the per-statement query timeout or storage retry policy.** `HONEYCOMB_QUERY_TIMEOUT_MS` ([`storage/config.ts:23`](../../../../src/daemon/storage/config.ts)) and the Semaphore(5)/retry posture in the storage layer are load-bearing safety rails and stay as-is unless 062a's data says otherwise.
- **A blind global throttle.** "Just make the interval bigger" without backoff would add latency to *active* sessions for no idle benefit. The fix is **adaptive** (idle-aware), not a flat slower constant.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-062a-…-query-cost-instrumentation`](./prd-062a-deeplake-compute-cost-reduction-query-cost-instrumentation.md) | **Foundational, measure-first.** A daemon-side DeepLake query meter that tags every read/write with a `source` label and counts them, an idle-baseline harness (run a daemon with empty queue + no user activity, record reads/min), and a before/after report scaffold. Optionally persists counts to the existing `telemetry_counters` tenant group for fleet-level visibility. Gates every later claim of "we cut X%". | Backlog |
| [`prd-062b-…-adaptive-poll-backoff`](./prd-062b-deeplake-compute-cost-reduction-adaptive-poll-backoff.md) | **The dominant idle fix.** Replace the two hardcoded 1000ms poll loops with **exponential backoff** (fast floor → ~30s ceiling, reset-to-floor on any leased job) and **consolidate** the pipeline stage worker and pollinating worker so they do **one** combined lease pass over `memory_jobs` instead of two independent scans. Also reduce the per-lease UNION-scan poll count where the consistency budget allows. Env-flagged, default-on after the 062a baseline confirms the drop. | Backlog |
| [`prd-062c-…-capture-write-batching`](./prd-062c-deeplake-compute-cost-reduction-capture-write-batching.md) | **The metadata-bloat fix.** Buffer captured-event inserts over a short flush window (size- or time-bounded) into a **single multi-row append** instead of one INSERT per event, and **trim the persisted envelope**: cap oversized tool input/response payloads to a budget with a truncation marker, and stop persisting per-row metadata that is invariant across a session. Preserve every field the extractor and recall read. | Backlog |
| [`prd-062d-…-fanout-and-recall-amplification`](./prd-062d-deeplake-compute-cost-reduction-fanout-and-recall-amplification.md) | **The amplification fix.** Coalesce the per-fact `memory_controlled_write` fan-out into batched enqueues/writes where ordering allows, and add a **bounded-concurrency semaphore** in front of the recall arms ([`recall.ts:1905`](../../../../src/daemon/runtime/memories/recall.ts)) and the usefulness-grader `Promise.all` ([`usefulness-grader.ts:208`](../../../../src/daemon/runtime/memories/usefulness-grader.ts)) so a recall/grade burst cannot issue unbounded concurrent DeepLake queries. | Backlog |
| [`prd-062e-…-idle-hibernation`](./prd-062e-deeplake-compute-cost-reduction-idle-hibernation.md) | **The follow-on to 062b: idle to zero.** 062b backed the idle poll cadence off to a ~30s ceiling, but a query every ~30s still re-provisions the Activeloop pod, so compute never scales to zero. 062e adds a single **connection-hibernation controller** (`DeepLakeHibernation`) that pauses every Deeplake-touching timer - the kind-workers, the PRD-223 pollinating maintenance tick, the health probe, and the graph-build - after an idle window, so the idle socket closes and the pod scales to zero; any inbound HTTP request wakes it. The summary + skillify workers already run on 062b's shared adaptive loop, so no flat-interval poller remains. Env-flagged (`HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED` / `_IDLE_MS`), default-on, rollback restores 062b's steady cadence. | Consolidated |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| AC-1 | **Cost is attributed before it is cut.** A daemon query meter (062a) labels every DeepLake read/write with a `source`, and a test plus a live idle-baseline run produce a report stating reads/min/daemon at zero user activity and the share attributable to polling. No later sub-PRD's "we cut X%" claim ships without a 062a before/after number behind it. |
| AC-2 | **Idle daemons go quiet.** With an empty `memory_jobs` queue and no user activity, a daemon's steady-state DeepLake poll cadence is **≤ 1 read-pass / 30s** (down from 2 workers × 1/s × UNION-scan amplification), measured by the 062a meter; a test asserts the backoff reaches its ceiling when no jobs are leased. |
| AC-3 | **Active latency is preserved.** When a job is enqueued into an idle (backed-off) daemon, the next lease pass resets the backoff to its fast floor; a test asserts that after any successful lease the interval returns to the floor, so a busy session polls at the original fast cadence and job pickup latency under load is unchanged within tolerance. |
| AC-4 | **One poller, not two.** The pipeline stage worker and pollinating worker no longer run two independent 1Hz scans of `memory_jobs`; a test asserts a single combined lease pass covers both kind sets (pipeline + pollinating) per tick, leaving foreign kinds queued for their owner as today. |
| AC-5 | **Capture writes are batched.** Captured events are flushed to `sessions` as **multi-row appends** over a bounded window (by size or time), not one INSERT per event; a test asserts N events within the window produce 1 append, and that a flush is forced on window close / shutdown so nothing is lost. |
| AC-6 | **The envelope is trimmed, not lossy.** Oversized tool input/response payloads in the persisted `message` envelope are capped to a documented budget with an explicit truncation marker, and invariant per-session metadata is not repeated per row; a test asserts (a) every field the extractor and recall consume is still present and (b) a pathological multi-MB tool response is stored within the budget. |
| AC-7 | **Amplification is bounded.** The per-fact controlled-write fan-out is batched where ordering allows, and recall arms + the usefulness-grader run under a bounded-concurrency semaphore; a test asserts that a recall over many terms never has more than `N` DeepLake queries in flight at once. |
| AC-8 | **No memory-quality regression.** Recall results, extraction output, and skillify decisions are unchanged within tolerance across the changes; the live integration net (PRD-031 / PRD-034) passes, and a parity check on a fixed session corpus shows no recall-quality drop attributable to envelope trimming or batching. |
| AC-9 | **Every change is flagged and reversible.** Poll backoff, write batching, envelope trimming, and the concurrency caps each sit behind a documented env flag with a stated default; a test asserts that with the flags off the daemon reproduces the pre-PRD behavior, so any regression is a config rollback, not a redeploy. |
| AC-10 | **Correctness under append-only convergence is intact.** Reducing the per-lease UNION-scan poll count (062b) does not reintroduce the stale-segment race the convergence scan defends against; a test asserts lease ownership is still single-winner and the reaper still reclaims stale leases, i.e. the cost cut does not trade money for a correctness bug. |

---

## Data model changes

**Additive only, and minimal. No new table of record.**

- **No schema change is required for the core fixes.** Poll backoff (062b), write batching (062c), and concurrency caps (062d) are all runtime/behavior changes over the **existing** `memory_jobs` and `sessions` schema. The `message` envelope trim (062c) changes the *content* written into the existing `sessions.message` column, not the column set.
- **Optional additive telemetry (062a).** If query counts are persisted for fleet-level visibility (rather than logged only), they reuse the **existing** `telemetry_counters` tenant group ([`tenancy.ts`](../../../../src/daemon/storage/catalog/tenancy.ts), `scope: "tenant"`) via additive schema healing, **one counter row per (source, period)**, never a new table. The default posture is **log + in-memory counters**; persistence is behind 062a's own flag so the meter does not itself add meaningful write cost.
- **Envelope-trim is forward-only.** Trimming applies to **newly captured** rows; existing oversized rows are left as-is (retro-compaction is PRD-030 territory, a non-goal here). A `source_tool` / truncation marker, if added, follows the additive-heal posture so a legacy row without it reads as "untrimmed", never throws.

---

## API changes

**No new public surface. No new outbound egress.** Every change is internal to the daemon runtime.

- **Job queue / workers (062b):** the lease/poll cadence and worker wiring change in [`pipeline/stage-worker.ts`](../../../../src/daemon/runtime/pipeline/stage-worker.ts), [`pollinating/worker.ts`](../../../../src/daemon/runtime/pollinating/worker.ts), and [`services/job-queue.ts`](../../../../src/daemon/runtime/services/job-queue.ts). New env knobs (e.g. `HONEYCOMB_POLL_BACKOFF_FLOOR_MS`, `HONEYCOMB_POLL_BACKOFF_CEILING_MS`, a consolidation flag) read through the existing config provider pattern ([`pollinating/config.ts`](../../../../src/daemon/runtime/pollinating/config.ts), [`storage/config.ts`](../../../../src/daemon/storage/config.ts)).
- **Capture (062c):** a flush-buffer is added in front of the existing `appendOnlyInsert` call in [`capture-handler.ts`](../../../../src/daemon/runtime/capture/capture-handler.ts); envelope construction at [`capture-handler.ts:285`](../../../../src/daemon/runtime/capture/capture-handler.ts) gains a budget-capped serializer. The capture contract surface to harnesses is unchanged.
- **Recall / pipeline (062d):** a semaphore wraps the `Promise.all` arms in [`memories/recall.ts`](../../../../src/daemon/runtime/memories/recall.ts) and [`memories/usefulness-grader.ts`](../../../../src/daemon/runtime/memories/usefulness-grader.ts); fan-out enqueue batching changes [`pipeline/fan-out.ts`](../../../../src/daemon/runtime/pipeline/fan-out.ts) and [`pipeline/controlled-writes.ts`](../../../../src/daemon/runtime/pipeline/controlled-writes.ts).
- **Telemetry (062a):** a thin meter wraps the DeepLake API call site ([`storage`](../../../../src/daemon/storage/) layer) to tag and count; it adds no route and no egress.

---

## Open questions

- [ ] **Idle backoff curve and ceiling.** Is ~30s the right idle ceiling, or should it be longer (60s+) for a truly idle daemon, traded against worst-case pickup latency for a freshly enqueued job? Confirm the floor (current 1000ms? faster under active load?) and the doubling schedule. (062b.)
- [ ] **Single-poller consolidation shape.** Do we merge the pollinating worker into the stage worker's loop (one timer, one combined `lease(kinds)` over the union of pipeline + pollinating kinds), or keep two workers but share a single lease pass via a shared scheduler? The first is fewer moving parts; the second preserves the current worker separation. (062b.)
- [ ] **Per-lease UNION-scan poll count vs consistency.** `DISCOVERY_SCAN_POLLS` ([`job-queue.ts:231`](../../../../src/daemon/runtime/services/job-queue.ts)) exists to defeat DeepLake stale-segment flapping. How far can it drop before lease ownership races return? Is there a cheaper convergence read (single read with a staleness tolerance) that holds correctness? This is the AC-10 risk and needs a live test, not a guess. (062b.)
- [ ] **Capture flush window.** Time-bounded (e.g. flush every 1–2s) vs size-bounded (every N events) vs both, and the crash-safety contract: an in-memory buffer loses un-flushed events if the daemon dies. Is a short window's worst-case loss acceptable, or does the buffer need a durable spill? (062c.)
- [ ] **Envelope budget and what is "invariant metadata".** What is the byte budget for a single tool input/response before truncation, and exactly which metadata fields are session-invariant (safe to lift out of the per-row envelope) vs per-event? Does any consumer (extractor, recall, future replay) actually read the full raw tool I/O, or only the text? Trimming the wrong field is a silent capability cut. (062c, needs a consumer audit.)
- [ ] **Recall/grade semaphore width.** What is the right max in-flight query count for recall arms and the usefulness-grader, balancing latency against DeepLake load? Does it reuse the existing storage-layer Semaphore(5) or is it a separate recall-scoped limit? (062d.)
- [ ] **Fan-out coalescing safety.** Can per-fact controlled-write jobs be batched without breaking the version-bump ordering controlled writes depend on ("never an in-place UPDATE; DeepLake coalesces UPDATEs and can drop one", [`controlled-writes.ts`](../../../../src/daemon/runtime/pipeline/controlled-writes.ts))? Batching must preserve per-memory append/version-bump correctness. (062d.)
- [ ] **Telemetry persistence vs log-only.** Does 062a persist per-source counters to `telemetry_counters` (fleet visibility, small added write cost) or stay log + in-memory (zero added cost, no fleet rollup)? And does it feed PRD-060d pollination metering, or stay incident-internal? (062a.)
- [ ] **Default flag posture for the rollout.** Do 062b/062c/062d ship default-on (aggressive cost relief, the incident is P0) or default-off-then-flip after the 062a baseline confirms each drop per-stage? Locked-3 says cheapest-first behind a flag; confirm the per-sub-PRD default. (all.)
- [ ] **Backport vs main-only.** The exodus is happening on the **currently shipped** version. Does the poll-backoff fix (062b) need an expedited patch release ahead of the rest, or do all four land together? (release sequencing, surface to ci-release-worker-bee.)

---

## Related

- **[Cost Anomaly Diagnosis playbook](../../../../.claude/skills/cost-anomaly-diagnosis/SKILL.md)** — the measure-blast-radius-before-you-fix discipline this PRD follows; cost storms are application-layer concurrent dispatch, quantified before the atomic fix.
- [PRD-009: Pollinating Loop](../../completed/prd-009-pollinating-loop/prd-009-pollinating-loop-index.md) · [PRD-026: Pollinating Loop Enablement](../../completed/prd-026-pollinating-loop-enablement/prd-026-pollinating-loop-enablement-index.md) — the pollinating worker whose 1Hz poll (062b) is half the idle baseline.
- [PRD-006: Memory Pipeline](../../completed/prd-006-memory-pipeline/prd-006-memory-pipeline-index.md) — the stage-worker lease→route→run loop (062b) and the extraction→decision→controlled-write fan-out (062d) this PRD makes cheaper.
- [PRD-005: Capture Intake](../../completed/prd-005-capture-intake/prd-005-capture-intake-index.md) — the capture handler and normalized envelope (062c) whose per-event write + metadata bloat is Driver 2.
- [PRD-007: Retrieval](../../completed/prd-007-retrieval/prd-007-retrieval-index.md) · [PRD-027: Recall Ranking and Eval](../../completed/prd-027-recall-ranking-and-eval/prd-027-recall-ranking-and-eval-index.md) — the recall arms (062d) that fan out concurrently with no ceiling, and the eval net that proves AC-8 parity.
- [PRD-028: Storage Read Consistency](../../completed/prd-028-storage-read-consistency/prd-028-storage-read-consistency-index.md) — the eventual-consistency / convergence-read posture the per-lease UNION scan (062b open question, AC-10) must not break.
- [PRD-029: Degradation Observability](../../completed/prd-029-degradation-observability/prd-029-degradation-observability-index.md) — the observability seam the 062a query meter extends.
- [PRD-031: Live Integration Test Net](../../completed/prd-031-live-integration-test-net/prd-031-live-integration-test-net-index.md) · [PRD-034: Resilient Live Test Strategy](../../completed/prd-034-resilient-live-test-strategy/prd-034-resilient-live-test-strategy-index.md) — the live net that asserts AC-8 (no memory-quality regression) and AC-10 (no correctness regression).
- [PRD-030: Memory Compaction](../../completed/prd-030-memory-compaction/prd-030-memory-compaction-index.md) — the retro-compaction axis that 062c's forward-only envelope trim explicitly is **not**.
- [PRD-060: ROI Tracker](../prd-060-roi-tracker/prd-060-roi-tracker-index.md) — the user-facing cost ledger; 062a's internal meter may feed PRD-060d pollination-cost metering but builds no UI.
- **Security + quality handoffs:** per house process, `security-worker-bee` runs **penultimate** and `quality-worker-bee` **last** before merge on each implementing branch. 062a (captured-trace counters) and 062c (envelope trimming touches captured tool I/O, a PII surface) carry security weight; this index *surfaces* those handoffs, it does not author the audits.
- Code touchpoints: [`src/daemon/runtime/pipeline/stage-worker.ts`](../../../../src/daemon/runtime/pipeline/stage-worker.ts) · [`src/daemon/runtime/pollinating/worker.ts`](../../../../src/daemon/runtime/pollinating/worker.ts) · [`src/daemon/runtime/services/job-queue.ts`](../../../../src/daemon/runtime/services/job-queue.ts) · [`src/daemon/runtime/pollinating/config.ts`](../../../../src/daemon/runtime/pollinating/config.ts) · [`src/daemon/runtime/capture/capture-handler.ts`](../../../../src/daemon/runtime/capture/capture-handler.ts) · [`src/daemon/runtime/pipeline/fan-out.ts`](../../../../src/daemon/runtime/pipeline/fan-out.ts) · [`src/daemon/runtime/pipeline/controlled-writes.ts`](../../../../src/daemon/runtime/pipeline/controlled-writes.ts) · [`src/daemon/runtime/memories/recall.ts`](../../../../src/daemon/runtime/memories/recall.ts) · [`src/daemon/runtime/memories/usefulness-grader.ts`](../../../../src/daemon/runtime/memories/usefulness-grader.ts) · [`src/daemon/storage/config.ts`](../../../../src/daemon/storage/config.ts) · [`src/daemon/storage/catalog/tenancy.ts`](../../../../src/daemon/storage/catalog/tenancy.ts).
