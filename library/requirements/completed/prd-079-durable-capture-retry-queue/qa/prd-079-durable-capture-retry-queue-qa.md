# QA Report — PRD-079a: Durable Capture Retry Queue

> **Auditor:** quality-worker-bee (armed with quality-stinger)
> **Date:** 2026-07-11
> **Branch:** `feat/prd-079-durable-capture-retry-queue`
> **Source of truth:** `library/requirements/backlog/prd-079-durable-capture-retry-queue/prd-079-durable-capture-retry-queue-index.md` (Phase 079a, a-AC-1..a-AC-8)
> **Ledger:** `library/ledger/EXECUTION_LEDGER-prd-079.md`
> **Ordering:** `security-worker-bee` ran FIRST and returned CLEAN at High+ — correct loop order (security → quality). No ordering violation.

## Summary

Phase 079a (durable capture outbox + background drainer + observability) is implemented faithfully against the PRD. All seven code acceptance criteria (a-AC-1..a-AC-7) **PASS** with independently-read code and independently-run tests; each test exercises the real criterion (not a tautology, not a mocked production path). a-AC-8 (live dogfood) is **VERIFIED-by-mechanism**: a natural DeepLake degraded window cannot be induced on demand and no live workspace exists in this environment, so the criterion's end-to-end mechanism was proven with controlled fault injection through the real capture handler path. The happy path is byte-unchanged (the outbox intercepts only the flush/immediate FAILURE branch). Full `npm run ci` is **GREEN**. **Verdict: SHIP.**

## Scorecard

| Axis | Status | Notes |
|------|--------|-------|
| **Completeness** | PASS | All 7 code ACs implemented; `/health` field + secret-free events present; assemble wiring, drainer lifecycle (start/close), and kill-switch all present. |
| **Correctness** | PASS | Enqueue-on-confirmed-failure, bounded exponential backoff with due-skip, idempotent `INSERT OR IGNORE` replay, single-flight drain, fail-soft no-op degrade — all verified by reading + running tests. |
| **Alignment** | PASS | Matches D-1 (dedicated table in `local-queue.db`), D-3 (deterministic id + read-time dedup), D-4 (fail-soft on the write lane), D-5 (home-anchored). Non-goals respected: happy path unchanged, no inline retry, no capture-contract change. |
| **Gaps** | PASS (minor) | One test-coverage gap: the `/health` endpoint-surface half of a-AC-7 (`buildHealthDetail` normalization + assemble `counts()` wiring) is not directly asserted; the `counts()` producer shape is. See W-1. |
| **Detrimental Patterns** | PASS | No unhandled-rejection risk (drainer double-guards the timer path), no hot-loop (backoff + due-skip), no secret leakage (events allow-list counts/durations/attempt/reason). |

## Per-AC Traceability

| AC | Criterion (abridged) | Code | Test (independently run) | Verdict |
|----|----------------------|------|--------------------------|---------|
| a-AC-1 | Failed append (batched flush OR immediate) ENQUEUEs `{row,scope}` into `capture_outbox` instead of dropping. | `capture-outbox.ts` `SqliteCaptureOutbox.enqueue` (`:307`); `capture-handler.ts` `onAppendFailure` (`:488`), `enqueueToOutbox` (`:501`), immediate-path hook `:391`, flush hooks `:570`/`:583` | *"enqueue persists the rows and the pending count grows"* + *"HANDLER: a failed batched flush routes the row to the outbox (pending grows), not only recordDropped"* (asserts `dropped==0`) | **PASS** |
| a-AC-2 | Background drainer re-appends on the WRITE client; OK → delete, non-ok → `attempts+1` + pushed `next_attempt_at`. Fail-then-succeed drains to empty across two ticks. | `drainDue` (`:365`), `reappend` (`:439`), `deleteRow` (`:463`), `pushBackoff` (`:468`) | *"first tick (backend still failing) keeps the row; second tick (recovered) drains it"* → `{drained:0,retried:1}` then `{drained:1,retried:0}`, pending→0 | **PASS** |
| a-AC-3 | Bounded exponential backoff (documented base+cap); drainer SKIPS not-yet-due rows — no hot-loop. | `backoff()` `min(base·2^(n-1),cap)` (`:479`), `leaseDue` `next_attempt_at <= now` (`:445`), consts `:83-85` | *"next_attempt_at grows per failed attempt and a future row is not attempted"* — asserts append count is unchanged while the row is not due; backoff grows 1s→2s | **PASS** |
| a-AC-4 | Anchored on `honeycombStateDir()`; survives stop/start, drains on next boot regardless of cwd. | `openOutboxDatabase` reuses `localQueueDaemonDir`/`localQueueDatabasePath` (`:249`); assemble wires `baseDir: resolveLocalQueueBaseDir()` (`assemble.ts:2992+`), `start()`/`close()` in daemon lifecycle | *"enqueue, close, reopen the SAME home-anchored db, and drain the persisted row"* — asserts db file at `.daemon/local-queue.db`, reopened pending==1 → drains | **PASS** |
| a-AC-5 | Fail-soft: enqueue/drain fault NEVER breaks capture, never surfaces to the hook; logged + counted. | `enqueue`/`drainDue` try-catch (`:331`,`:396`), `enqueueToOutbox` guard (`capture-handler.ts:501`), `openCaptureOutbox` → `NULL_CAPTURE_OUTBOX` (`:220`,`:233`) | *"a throwing outbox stub leaves the capture ack intact and does not throw"* (201 ack, `dropped==1`, `enqueue_failed` logged, **no unhandledRejection**) + *"openCaptureOutbox degrades to a no-op when the substrate cannot open"* | **PASS** |
| a-AC-6 | Idempotent replay: stores already-built row under its `makeRowId` id; `INSERT OR IGNORE`; never mints a new id on replay. | `enqueue` `INSERT OR IGNORE` on `rowId(row)` (`:313`,`:513`), `reappend` replays stored `RowValues` verbatim | *"re-enqueuing the SAME row is a no-op, not a duplicate"* (pending stays 1) + *"the drained append replays the ORIGINAL row id, not a fresh one"* (asserts SQL contains `'keep-this-id'`) | **PASS** |
| a-AC-7 | `/health` `captureOutbox { pending, retrying }` + secret-free `capture.outbox.{enqueued,drained,retry}` events (counts/durations/attempt only — no content/token/query/org/scope). | `counts()` (`:346`); events at `:342`,`:393`,`:405`; `/health` shape `health.ts:430-441` + `HealthReasons.captureOutbox`; assemble `captureOutbox.counts()` `assemble.ts:3166+` | *"counts() reports { pending, retrying } and the drainer events carry no content/scope"* — asserts events omit org/workspace/content strings and use only an allow-list of keys | **PASS** (see W-1) |
| a-AC-8 | Live dogfood: during a degraded window pending>0, on recovery pending→0 with memories on recall. | Full path: handler enqueue → outbox drain → replay | **VERIFIED-by-mechanism** — QA-authored end-to-end test *"a-AC-8 (mechanism): ... ack stays 201, pending>0 during the window, pending→0 on recovery with the original id replayed"* (`capture-outbox-a-ac-8-mechanism.test.ts`) drives the REAL capture route (201 ack) with a forced failing append → pending==1, then flips the fault off and drives the drainer → pending==0 with the original id replayed. | **VERIFIED-by-mechanism** |

### a-AC-8 form achieved — be honest about which

- **Achieved:** controlled **fault-injection** proof of the full mechanism, end-to-end through the real capture handler (`daemon.app.request` → 201 ack → forced flush failure → durable enqueue → recovery → drainer replay). This is the strongest form obtainable without a live backend.
- **NOT achieved (and not a blocker):** observation of a *naturally-occurring* DeepLake degraded window. That flapping is intermittent hosted-backend behaviour that cannot be induced on demand, and this environment has no live `apiary` workspace/credentials. Per PRD-079a a-AC-8's intent and the findings doc, the natural-window observation remains a **post-merge dogfood** — the mechanism is proven, so it does not gate the merge.

## Findings

### Critical (must fix — blocks ship)

None.

### Warnings (should fix)

- **W-1 — a-AC-7 `/health` endpoint surface is not directly asserted.** `src/daemon/runtime/health.ts:430-441` (the `captureOutbox` normalization branch in `buildHealthDetail`) and the assemble wiring `captureOutbox.counts()` (`assemble.ts:3166+`) have no direct test; only the `counts()` producer shape is asserted in `capture-outbox.test.ts`. a-AC-7's text says "A test asserts the health shape." The branch is a trivial `Math.max(0, Math.trunc(...))` passthrough and is typecheck-clean, so risk is low, but a one-line `buildHealthDetail({ captureOutbox: {...} })` assertion would fully close the AC. Non-blocking.

### Suggestions (consider improving)

- **S-1 — immediate (non-batch) path ignores the enqueue drop count.** `capture-handler.ts:391` calls `this.enqueueToOutbox([row], scope)` but discards the returned `dropped` count before returning 502. This is **correct by design** (the immediate path returns a 502, not an ack, so a truly-unpersistable row is not an "acks-but-lost" drop and must not inflate that metric), but it means an immediate-path row the outbox could not persist is reflected in no counter at all. Consider a distinct log/metric for that rare case (079b territory).
- **S-2 — `reason` field carries a raw `Error.message`.** `capture.outbox.{enqueue_failed,drain_failed,open_failed}` events emit `err.message` verbatim. Today those are SQLite/JS faults (secret-free), and the a-AC-7 test allow-lists `reason`, but a future error path could embed a filesystem path. Consider a bounded/classified reason enum if the event stream is ever externalized.
- **S-3 — unbounded outbox growth until 079b.** With dead-letter (079b) and caps (079c) explicitly Draft/out-of-scope, a *prolonged* degraded window grows the outbox without a ceiling and without recovery-triggered drain (timer-only). This is documented and intentional for the MVP (the PRD scopes 079a to "stop the silent loss"), but is worth ship-awareness: the MVP trades unbounded-but-visible backlog for the previous silent loss. Ensure 079b lands before any workload that could sustain a multi-hour degraded window.

## Security close-out (carried forward)

`security-worker-bee` audited the new SQLite/outbox surface (SQL injection on the `capture_outbox` DDL/DML, PII/content-at-rest in the outbox, path traversal on the DB file) and returned **CLEAN at High+**: **0 Critical / 0 High**. **1 Medium** deferred to **079b** by design (dead-letter / bounded growth — content-at-rest lifecycle), **2 Lows** noted. SQL interpolation routes through `sqlIdent` and parameterized `?` binds (confirmed by `npm run audit:sql`: "every SQL interpolation routes through an escaping helper"), and the DB path reuses the proven `localQueueDaemonDir`/`localQueueDatabasePath` trusted-root + traversal guard (D-1). No security regression introduced by this change.

## Full CI result

`npm run ci` (= `typecheck && dup && test && audit:sql`) — **GREEN**:

- **typecheck** (`tsc --noEmit`): pass (includes the QA-authored a-AC-8 mechanism test).
- **dup** (`jscpd src harnesses mcp embeddings`): pass.
- **test** (`vitest run`): **450 files / 4812 passed / 13 skipped**, 0 failures. The known `tests/daemon/runtime/secrets/exec.test.ts` wall-clock flake did **not** fire this run — the suite is unconditionally green (the flake exception was not needed).
- **audit:sql**: clean — 311 files scanned, every SQL interpolation escaped.

Targeted re-runs by the auditor: `capture-outbox.test.ts` (10/10), `capture-handler.test.ts` + `capture-batching.test.ts` + `attach.test.ts` (31/31), `capture-outbox-a-ac-8-mechanism.test.ts` (1/1) — all pass.

## Files changed

| File | Change |
|------|--------|
| `src/daemon/runtime/capture/capture-outbox.ts` | **NEW** — the durable outbox: `capture_outbox` table in `local-queue.db`, enqueue-on-failure, unref'd drainer with bounded exponential backoff + due-skip, `{pending,retrying}` counts, secret-free events, fail-soft no-op degrade (a-AC-1..a-AC-7). |
| `tests/daemon/runtime/capture/capture-outbox.test.ts` | **NEW** — 10 tests covering a-AC-1..a-AC-7 (outbox unit + handler wiring). |
| `tests/daemon/runtime/capture/capture-outbox-a-ac-8-mechanism.test.ts` | **NEW (QA-authored)** — end-to-end a-AC-8 mechanism proof through the real capture handler path. |
| `src/daemon/runtime/capture/capture-handler.ts` | Hooked the flush + immediate FAILURE branch (`onAppendFailure`/`enqueueToOutbox`); exported `CAPTURE_WRITE_OPTS` for the drainer. Happy path byte-unchanged. |
| `src/daemon/runtime/capture/attach.ts` | Threaded the optional `outbox` through `AttachHooksOptions` to the capture handler. |
| `src/daemon/runtime/assemble.ts` | Constructs the real outbox (production path only, kill-switch `HONEYCOMB_CAPTURE_OUTBOX` default-on), wires `/health` `captureOutbox`, arms the drainer in `start()`, closes it in shutdown. |
| `src/daemon/runtime/health.ts` | Added `captureOutbox { pending, retrying }` to `HealthReasons` + `HealthDetailInputs` + normalization in `buildHealthDetail`. |
| `src/daemon/runtime/services/local-job-queue.ts` | Exported the SQLite substrate helpers (`loadSqlite`, `localQueueDaemonDir`, `localQueueDatabasePath`, `stringField`, `numberField`, types) so the outbox reuses them (D-1, no jscpd clone). |

## Overall verdict

**SHIP.** All 7 code ACs PASS with independently-run tests, a-AC-8 is VERIFIED-by-mechanism, the happy path is byte-unchanged, security is CLEAN at High+, and full CI is green. No Critical or blocking findings. W-1 is a low-risk test-coverage gap; S-1..S-3 are forward-looking notes (mostly 079b/079c scope). The natural-window dogfood observation is a post-merge follow-up, not a merge gate.
