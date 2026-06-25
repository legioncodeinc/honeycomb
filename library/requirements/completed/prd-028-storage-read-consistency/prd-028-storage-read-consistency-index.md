# PRD-028 — Storage read-consistency layer (read-your-writes by construction)

> Status: Completed (2026-06-25 — all 5 required ACs verified live; store→recall was always non-AC polish) · Owner: `/the-smoker` · Type: M (feature)
> Goal: make read-your-writes / eventual-consistency handling a PROPERTY OF THE STORAGE LAYER
> (`src/daemon/storage/`), not a poll loop reinvented in every itest and call site.

> **✅ Closed 2026-06-25 — re-validated against current code.** The 2026-06-22 reopen flagged the
> store→recall call site as un-adopted; a 2026-06-25 re-validation (see
> [`../../in-work/2026-06-24-requirements-sotu.md`](../../in-work/2026-06-24-requirements-sotu.md) §0) confirmed that adoption was
> **always explicitly optional / non-AC polish**, never an acceptance criterion. All 5 required ACs (AC-1..AC-5)
> are met in current code: `readConverged` (`src/daemon/storage/converge.ts:273`) is live and consumed by
> asset-sync (`runtime/assets/sync.ts:187`), the dashboard (`runtime/dashboard/sync-api.ts:409`), and 6 live
> itests. Adoption has *grown* since the reopen note. The un-adopted store→recall wiring is tracked as optional
> future polish, not a blocking gap. Moved `in-work/` → `completed/`.
>
> **(Historical) Reopened 2026-06-22 — partial implementation.** A daemon-wiring liveness audit moved this PRD
> back to `in-work/`. See
> [`../prd-045-daemon-wiring-closeout/reports/2026-06-22-daemon-wiring-liveness-audit.md`](../prd-045-daemon-wiring-closeout/reports/2026-06-22-daemon-wiring-liveness-audit.md).

## Why
DeepLake is eventually consistent: it flaps stale segments, so a read issued immediately after a
write can miss the just-written row, then see it a beat later. Today every live itest that does a
write→read-back hand-rolls its own "poll until it shows up" loop (the convergence logic is copied
across `controlled-writes-live`, `graph-persist-live`, `ontology-*-live`, `summary-write-live`,
etc. — the jscpd-duplication trap, and worse, each copy gets the retry budget subtly different).
This is the SAME class as the just-fixed identity-from-env-vs-creds split (PRD-021): state read or
re-derived inconsistently from one call site to the next. A stale read also silently UNDER-reports
— recall returns fewer hits, a counter looks un-incremented, the dashboard KPI lags — and nothing
flags that the read was premature. The convergence guarantee belongs ONCE in the storage seam every
read already flows through (`StorageClient.query`, `src/daemon/storage/client.ts`), not scattered as
test scaffolding.

## Goal
A single seam that converges reads onto freshly-written data with a bounded budget, so the engine is
consistent-by-construction: the write path can hand the read path a watermark, and a read that asks
for convergence either sees the write or exhausts a bounded budget and fails SOFT (never blocks
forever, never invents a row that is not there).

## Scope / What
- A `readConverged()` helper (the seam) layered on the Wave-1 `StorageQuery` contract
  (`src/daemon/storage/client.ts`), returning the SAME closed `QueryResult` union
  (`src/daemon/storage/result.ts`) so callers still branch on `kind`, never on a thrown shape.
- A convergence predicate the caller supplies: "this result is fresh enough" (e.g. row with id X is
  present, or `version >= N`, or row count `>= k`). The seam polls `query` until the predicate holds
  OR the bounded budget is exhausted, then returns the last `QueryResult` either way.
- A read-after-write WATERMARK the controlled-write primitives
  (`appendVersionBumped` / `updateOrInsertByKey`, `src/daemon/storage/controlled-writes.ts`) can
  emit (the just-written id + version), so the read path's predicate is derived from the write, not
  guessed.
- A single bounded retry policy (attempts × backoff, capped wall-clock), reusing the same
  abort/timeout discipline `StorageClient.query` already enforces (`HONEYCOMB_QUERY_TIMEOUT_MS`).
- Migrate the live itests off their hand-rolled poll loops onto this seam (delete the copies).
- NON-goal: changing recall ranking, the schema, or the heal engine (`src/daemon/storage/heal.ts`).

## Decisions
- **D-1 — Poll-converge as the mechanism; watermark as the predicate input.** The seam polls the
  read (DeepLake exposes no read-after-write token at the transport), but the WRITE path supplies the
  watermark (id+version) that makes the predicate exact instead of a fuzzy "wait and hope". Hybrid:
  poll-loop driven by a write-emitted watermark. Pure version-watermark (block the read on a global
  sequence) is rejected — DeepLake gives us no such cursor.
- **D-2 — Opt-in per read, not always-on.** Most reads (recall, dashboard views) are already
  fail-soft and tolerate slight staleness; forcing convergence on every read would tax every request
  for a guarantee only the write→read-back paths need. `query` stays the default; `readConverged` is
  the explicit choice a read-your-writes caller makes (the store→recall loop, the live itests).
- **D-3 — Bounded budget, fail-SOFT, never invent.** Default budget ~2s wall-clock / ~10 attempts
  with backoff (env-overridable, e.g. `HONEYCOMB_READ_CONVERGE_MS`). On exhaustion the seam returns
  the last real `QueryResult` (typically a smaller-than-expected `ok`) — it NEVER fabricates the
  awaited row and NEVER throws past the closed union. A stale read under-reports; it must not lie.
- **D-4 — One home, jscpd-clean.** The convergence logic lives once under `src/daemon/storage/`
  (mirroring `result.ts` / `heal.ts` as the single home of their concern), consumed by call sites and
  by the itest harness. The hand-rolled poll loops in the itests are deleted, not left to drift.
- **D-5 — No secret in any trace.** The seam reuses the client's redaction discipline: convergence
  trace lines (gated by `HONEYCOMB_TRACE_SQL`) summarize the SQL and redact org; no token, ever.

## Acceptance criteria
- **AC-1 — Deterministic converge unit.** A unit test drives `readConverged` against a FAKE flapping
  `StorageQuery` that returns stale (empty / lower-version) rows for the first N calls then the fresh
  row. The seam polls until the predicate holds and returns the fresh `ok` — proven without any live
  backend, with a fake clock so the test is fast and non-flaky.
- **AC-2 — Bounded fail-soft.** With a fake client that NEVER converges, `readConverged` exhausts the
  bounded budget and returns the last real `QueryResult` (not a throw, not a hang, not an invented
  row). A unit test asserts the call returns within the budget and the result is the last real read.
- **AC-3 — No-flake live read-your-writes.** A gated live itest writes a row via the controlled-write
  primitive then reads it back THROUGH `readConverged` and ALWAYS sees the write — run N≥20 times in a
  loop with zero misses (the stale-segment flap is absorbed by the seam, not by luck).
- **AC-4 — Itests stop hand-rolling it.** At least the controlled-writes + graph-persist live itests
  read back through the shared seam (or the harness helper that wraps it); their bespoke poll loops
  are removed. `grep` proves no remaining ad-hoc "retry until row appears" loop in those files.
- **AC-5 — Gates green + no secret.** `npm run ci` / `build` / `audit:sql` / `audit:openclaw` all
  green; a trace-on run shows convergence lines carry no token and no full org (redaction proof).

## Risks / Out of scope
- RISK: a too-tight budget reintroduces flakes; a too-loose one slows the store→recall path. D-3's
  env-override lets the live suite tune it without a code change; AC-3's N≥20 loop is the guard.
- OUT: changing the `query` default to always-converge (D-2); a transport-level read-after-write token
  (DeepLake exposes none, D-1); recall ranking / embeddings / schema changes.

## Dependencies
- Builds on the Wave-1/2 storage layer: `StorageClient.query` + the `QueryResult` union
  (`src/daemon/storage/{client,result}.ts`), the heal engine (`heal.ts`), and the controlled-write
  primitives (`controlled-writes.ts`) that will emit the watermark.
- **PRD-031 (live-integration test net) LEANS ON THIS**: 031's assembled-daemon + live itests use this
  seam to stay fast and non-flaky instead of each re-deriving a poll loop.

## Reference
- Seam home + contract: `src/daemon/storage/client.ts` (`StorageClient.query`, `StorageQuery`),
  `src/daemon/storage/result.ts` (`QueryResult` / `isOk`).
- Write watermark source: `src/daemon/storage/controlled-writes.ts`
  (`appendVersionBumped` / `updateOrInsertByKey`).
- Hand-rolled poll loops to retire: `tests/integration/controlled-writes-live.itest.ts`,
  `tests/integration/graph-persist-live.itest.ts`, `tests/integration/ontology-*-live.itest.ts`.
- Live read-your-writes call site that benefits: the store→recall loop
  (`src/daemon/runtime/memories/{store.ts,recall.ts}`).
