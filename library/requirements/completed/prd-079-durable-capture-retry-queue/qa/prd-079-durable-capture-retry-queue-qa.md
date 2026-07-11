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
| **Gaps** | PASS | W-1 (the `/health` half of a-AC-7) is now closed: `buildHealthDetail` normalization is directly tested in `health.test.ts` (which uncovered + fixed a real `NaN`→`null`-on-wire defect via `nonNegativeInt()`), and the `/health` endpoint wiring (`captureOutbox.counts()`) is asserted in-process. See W-1 (resolved). |
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

### Warnings

- **W-1 — a-AC-7 `/health` endpoint surface — RESOLVED.** Originally the `captureOutbox` normalization branch in `buildHealthDetail` (`health.ts`) and the assemble wiring `captureOutbox.counts()` had no direct test; only the `counts()` producer shape was asserted. Closing this gap was worthwhile, not cosmetic: adding the `buildHealthDetail` normalization test in `tests/daemon/runtime/health.test.ts` **uncovered a real defect** — the passthrough was `Math.max(0, Math.trunc(x))`, which returns `NaN` for a `NaN` input (serializing to `null` on the wire) instead of clamping to `0`; fixed with a `nonNegativeInt()` finiteness guard. The `/health` endpoint wiring (that the daemon feeds `captureOutbox.counts()` into the real response) is now asserted in-process as well. a-AC-7 fully closed.

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

---

# QA Report — Phase 079b + 079c: dead-letter, recovery-triggered drain, caps + coalescing + back-pressure

> **Auditor:** quality-worker-bee (armed with quality-stinger)
> **Date:** 2026-07-11
> **Branch:** `feat/prd-079bc-outbox-deadletter-scale` (off `main` @ b0713ae, post PR #287)
> **Source of truth:** `prd-079-durable-capture-retry-queue-index.md` — "Acceptance criteria (Phase 079b …)" (b-AC-1..b-AC-5) + "(Phase 079c …)" (c-AC-1..c-AC-4)
> **Ledger:** `library/ledger/EXECUTION_LEDGER-prd-079bc.md`
> **Ordering:** `security-worker-bee` ran FIRST and returned CLEAN at High+ (0 Critical / 0 High; 2 Lows; route-authz PASS) — correct loop order (security → quality). No ordering violation.

## Summary

Phases 079b (dead-letter + recovery-triggered drain + operator CLI) and 079c (active-backlog cap + coalesced drain + back-pressure) are implemented faithfully against the PRD. **All nine code acceptance criteria (b-AC-1..b-AC-5, c-AC-1..c-AC-4) PASS** with independently-read code and independently-run tests; each test exercises the real criterion through the real code path (the storage seam is stubbed at the `StorageQuery` boundary — the legitimate injection point — while the append primitive `appendOnlyInsertMany`, the grouping/coalescing, the SQLite store, and the drain accounting are all the production code). The four trickiest guarantees the invoker flagged were each verified as genuine (see the per-AC table + notes). The 079a happy path and its a-AC accounting are non-regressed (the a-AC-1..a-AC-8 suite is intact; the only change is the additive `deadLettered` field on `counts()`/`drainDue()` shapes). Full `npm run ci` is **GREEN** modulo a single wall-clock timeout flake that passes in isolation. **Verdict: SHIP.**

## Scorecard

| Axis | Status | Notes |
|------|--------|-------|
| **Completeness** | PASS | All 9 code ACs implemented: dead status + `maxAttempts`/`maxAgeMs` bounds, secret-free `dead_lettered` event + `/health` `deadLettered`, recovery kick on both append-success branches + `deeplake.woke` resume-kick, `honeycomb capture drain` CLI + `POST /api/diagnostics/capture-drain` route, active-backlog cap + oldest-first shed, scope+column-signature coalescing, unified `maxDrainPerInterval` back-pressure cap. |
| **Correctness** | PASS | Per-member independent dead-letter/backoff on a failed coalesced group (no row lost/double-counted), age-trigger dead-letter distinct from attempts-trigger, single authoritative per-pass lease cap, `INSERT OR IGNORE` idempotency preserved, single-flight drain guard shared by timer/kick/route. Verified by reading + running. |
| **Alignment** | PASS | Matches b-AC-1..5 / c-AC-1..4 and the resolved decisions: D-1 (dedicated table), D-4 (fail-soft on the write lane; bounded growth via dead-letter + cap), amplification-config-style env knobs. Non-goals respected: happy path unchanged, no inline retry, no capture-contract change. |
| **Gaps** | PASS | No gap between spec and code. The `deeplake.woke` "or" arm is wired via the hibernation `Pausable` `resume()` (a clean log-only-transition callback does not exist), which is a faithful realization of the criterion, with the successful-append kick as the primary trigger. |
| **Detrimental Patterns** | PASS | No unhandled-rejection risk (kick + timer both `.catch()` the fire-and-forget drain; CLI + route + kick all fail-soft), no hot-loop (a failed/throwing group backs off every member — the FIX-1 hardening test proves the pass is never aborted by a throw), no secret leakage (every new event allow-lists count/attempt/ageMs/durationMs/reason; route + CLI bodies scanned secret-free). |

## Per-AC Traceability

| AC | Criterion (abridged) | Code | Test (independently run) | Verdict |
|----|----------------------|------|--------------------------|---------|
| b-AC-1 | Row hitting `maxAttempts` OR `maxAgeMs` → terminal `dead` (retained, never re-leased); env-overridable config (def 10 / 24h). | `deadLetter()` `capture-outbox.ts:640` (checks `attempt >= maxAttempts` OR `ageMs >= maxAgeMs`), `markDead()` `:772` (`status = dead`, retained), `leaseDue` `status = pending` filter `:744`; config `resolveCaptureOutboxLimits()` `:170` + `clampIntKnob` `:157`, threaded `assemble.ts:3011` | *"a row that fails maxAttempts re-appends transitions pending → dead (retained, not re-leased)"* + *"a row older than maxAgeMs dead-letters on its next failed attempt (age trigger, not attempts)"* — the age test uses `maxAttempts:1000` so AGE is the sole trigger; the dead row is never re-appended (append count frozen) | **PASS** |
| b-AC-2 | Secret-free `dead_lettered` event (attempt/ageMs/count only) + `/health` `deadLettered`; `counts()` → `{pending,retrying,deadLettered}`, dead excluded from active. | event `deadLetter()` `:656`; `counts()` single-pass partition `:532` (dead excluded from pending/retrying); `/health` `buildHealthDetail` `health.ts:442` + `HealthReasons.captureOutbox.deadLettered` `:213`, fed `assemble.ts:3177` (`captureOutbox.counts()`) | *"dead-lettering emits a secret-free event and excludes dead from pending/retrying"* (asserts exact key set `{attempt,ageMs,count}`, no content/org/ws) + health.test.ts *"captureOutbox { pending, retrying, deadLettered } surfaces on /health…"* (incl. legacy-input-normalizes-to-0 + neg/NaN/float clamps) | **PASS** |
| b-AC-3 | Recovery-triggered drain kicked on next successful append and/or `deeplake.woke`; single-flighted + fail-soft. | `kick()` single-flighted via `draining` guard + `.catch()` `:627`; `kickOutboxDrain()` on BOTH success branches — immediate `capture-handler.ts:394`, batched flush `:598`; `deeplake.woke` arm = hibernation `Pausable` `resume()` re-arm+kick `assemble.ts:4122` | *"a queued row drains via the recovery kick, without arming/awaiting the 30s interval"* — the drain interval is NEVER started, so the kick is the ONLY path to pending→0; asserts pending→0 after a landing capture | **PASS** |
| b-AC-4 | `honeycomb capture drain` forces a pass + prints drained/retried/deadLettered; read-through fail-soft. | route `mountCaptureDrainApi` `capture-drain-api.ts:75` (`POST /api/diagnostics/capture-drain`, protected group, fail-soft 200), mounted `assemble.ts:3388`; CLI `runCaptureVerb` `commands/capture.ts:53`, verb in `VERB_TABLE` `contracts.ts:132`, dispatched `dispatch.ts:220` | route: *"forces exactly one drainDue pass and returns { ok, drained, retried, deadLettered }"* + *"a throwing drainDue degrades to a zero-count 200"* + secret-free body; CLI: *"POSTs … and renders the counts"*, *"non-2xx exits 1"*, *"daemon-down (send rejects) reports cleanly and never throws"*, dispatcher-wiring | **PASS** |
| b-AC-5 | Fail-soft + non-regression: dead-letter/kick/CLI never break capture, never leak, 079a happy path + accounting unchanged. | kick fail-soft `capture-handler.ts:521` (`kick_failed`, ack unaffected); `deadLetter` guards `markDead` — a fault leaves the row pending `:649`; 079a shapes additive-only (`deadLettered` added to `counts()`/`drainDue()`) | *"a throwing recovery kick leaves the capture ack intact and escapes no rejection"* (201 ack, `kick_failed` logged, no unhandledRejection) + the whole a-AC-1..a-AC-8 suite still green (additive field only) | **PASS** |
| c-AC-1 | `maxRows` cap (def 10k): shed oldest-first over the cap, each shed counted via `capture.outbox.shed`; dead excluded. | `shedToCap()` `:504` (COUNT pending; if overflow, one targeted DELETE of oldest `overflow` by `created_at ASC, id ASC`), called from `enqueue` after insert `:493`; `capture.outbox.shed {count}` `:523`, fail-soft `shed_failed` `:526`; dead excluded by `status = pending` filter | *"enqueuing past maxRows sheds the OLDEST pending rows, bounds pending at maxRows, logs the shed count"* (proves oldest-first: survivors r3/r4/r5 replayed, r1/r2 never) + *"dead rows do NOT count toward the active cap and are never shed"* | **PASS** |
| c-AC-2 | Coalesced drain: same scope+column-signature → one append; heterogeneous split; a failed group backs off/dead-letters EACH member independently, never lost. | `groupDue()` `:696` + `groupKey()` scope + NUL-joined column-name signature `:843`; one `reappendMany()` per group `:727` → `appendOnlyInsertMany`; on group OK delete every member `:582`; on group non-ok/throw per-member `deadLetter`-else-`pushBackoff` `:591` (each uses `member.lease.attempts`) | *"N same-scope/same-shape rows drain in ONE multi-row append"*, *"heterogeneous shapes split into SEPARATE appends"*, *"different scope splits"*, *"a FAILED group backs off EVERY member independently (no row lost, no hot-loop)"*, and the decisive **per-member** case *"a failed group dead-letters ONLY the member that hit maxAttempts; its sibling backs off"* (A→attempt2==max→dead, B→attempt1→backoff in ONE shared failed group) | **PASS** |
| c-AC-3 | Back-pressure `maxDrainPerInterval` (def 200): a pass attempts at most N rows; remainder left due; reconciled to ONE authoritative cap. | `leaseDue` `LIMIT` binds `this.maxDrainPerInterval` `:752` (the SINGLE per-pass cap that replaced the 079a `drainBatch`); old `DEFAULT_OUTBOX_DRAIN_BATCH` retained only as a `@deprecated` alias `= DEFAULT_OUTBOX_MAX_DRAIN_PER_INTERVAL` `:115`; the `drainBatch` construction option is gone, replaced by `maxDrainPerInterval` `:308` | *"a backlog larger than the cap attempts at most maxDrainPerInterval rows in one pass"* (`maxDrainPerInterval:2`, 5 queued → 2 drained/pass, tupleCount==2, remainder stays pending) | **PASS** |
| c-AC-4 | Fail-soft + honest observability across cap/coalesce/back-pressure; `/health` honest under load. | shed try/catch `:504`; `reappendMany` catches a throw → `false` → per-member backoff `:731`; `clampIntKnob` never throws `:157`; `counts()` shape unchanged; new events secret-free | *"resolveCaptureOutboxLimits documents defaults + clamps a fat-fingered knob (never throws)"*, *"a coalesced-drain fault degrades to per-member backoff and escapes no rejection"* (no unhandledRejection), *"the shed + coalesce + back-pressure events carry NO content/org/workspace"*, *"/health counts stay honest under a bounded, failing backlog (pending never lies)"* | **PASS** |

### Notes on the four flagged guarantees (independently confirmed, not tautological)

- **(a) c-AC-2 per-row dead-letter accounting on a FAILED coalesced group** — CONFIRMED genuine. On a group non-ok/throw, `drainDue` (`:591`) iterates `group.members` and calls `deadLetter(member.lease)` **per member**, and `deadLetter` computes `attempt = member.lease.attempts + 1` from that member's own persisted `attempts`. So within one failed group, a member at attempt N-1 dead-letters while its sibling at attempt 0 backs off — proven by *"a failed group dead-letters ONLY the member that hit maxAttempts; its sibling backs off"* → `{drained:0, retried:1, deadLettered:1}`. On a group OK, every member is deleted individually (`drained += 1` each). No row is lost, skipped, or double-counted.
- **(b) b-AC-1 the `maxAgeMs` path** — CONFIRMED genuine and distinct from the attempts path. `deadLetter` computes `ageMs` from the persisted `createdAt` and dead-letters on `ageMs >= maxAgeMs` independently of `overAttempts`. The age test sets `maxAttempts:1000` so ATTEMPTS cannot be the trigger, ages the row 60,001ms past a 60,000ms bound, and asserts `deadLettered:1` on the first failed attempt.
- **(c) c-AC-3 the back-pressure cap and its reconciliation with the old `drainBatch`** — CONFIRMED there is exactly ONE authoritative per-pass cap. `leaseDue`'s `LIMIT` binds `this.maxDrainPerInterval`; the old `drainBatch` construction option was removed (replaced by `maxDrainPerInterval`), and `DEFAULT_OUTBOX_DRAIN_BATCH` survives only as a `@deprecated` alias pointing at the new constant (import-compat, no second knob). Back-pressure is enforced at the lease (before grouping), so coalescing can only reduce append ops further, never exceed the cap.
- **(d) 079a + 079b non-regression** — CONFIRMED. The a-AC-1..a-AC-8 tests all still pass; the only cross-phase change is the **additive** `deadLettered` field on the `counts()` / `drainDue()` result shapes and the `/health` `captureOutbox` reason (legacy `{pending,retrying}` inputs normalize `deadLettered` to 0). The FIX-1 079a-hardening test was *strengthened* (now uses two column shapes so coalescing yields two groups → two appends), preserving the "a throw never aborts the pass / never hot-loops" guarantee.

## Findings

### Critical (must fix — blocks ship)

None.

### Warnings (should fix)

None.

### Suggestions (consider improving)

- **S-4 — `capture.outbox.shed` fires once per over-cap enqueue, not per shed row.** `shedToCap` emits `shed { count }` with the batch count, which is correct and secret-free. Under a sustained flood each enqueue re-runs the COUNT+DELETE; this is bounded and fail-soft, but on an extreme burst the shed-event rate tracks the enqueue rate. Consider a coalesced/rate-limited shed log if the event stream is ever externalized (same spirit as S-2). Non-blocking.
- **S-5 — `maxDrainPerInterval` default rose from the 079a `drainBatch` 50 to 200.** The unification is deliberate and documented (one authoritative cap), but the per-pass attempt ceiling is now 4× the pre-079c value against the same write `Semaphore(3)`. This is intentional throughput tuning and env-overridable; flagged only for ship-awareness so a future write-lane-pressure investigation knows the knob moved. Non-blocking.
- **S-1..S-3 (carried from 079a)** — S-1 (immediate-path drop count) and S-3 (unbounded growth) are now materially addressed by 079b/079c (dead-letter bound + `maxRows` cap + recovery-triggered drain). S-2 (raw `Error.message` in `reason`) still stands for the new `shed_failed` / `kick_failed` events (secret-free today; bounded-enum if externalized).

## Security close-out (folded in)

`security-worker-bee` ran FIRST on this branch and returned **CLEAN at High+**: **0 Critical / 0 High**, **2 Lows** noted. **Route-authz: PASS** — the new `POST /api/diagnostics/capture-drain` attaches to the already-mounted `/api/diagnostics` group, confirmed `protect: true, session: false` (`server.ts:91`), so it inherits the same middleware as its diagnostics siblings (open in `local` mode, gated in team/hybrid). The shed/coalesce/CLI surface was audited for injection (all SQL routes through `sqlIdent` + parameterized `?` binds — `audit:sql` clean), DoS/shed-abuse (bounded by the cap + fail-soft + single targeted DELETE), and secret-free events (allow-listed count/attempt/ageMs). No security regression introduced. Ordering is correct (security → quality).

## Full CI result

`npm run ci` (= `typecheck && dup && test && audit:sql`) — **GREEN (effectively)**:

- **typecheck** (`tsc --noEmit`): pass.
- **dup** (`jscpd`): pass (0.65% ≪ 7% threshold).
- **test** (`vitest run`): 453 files, **4843 passed / 13 skipped / 1 failed**. The single failure is `tests/daemon/runtime/assemble.test.ts > "PRD-022 (local) a store with a session but NO org falls back to the daemon's default tenant"` — a **wall-clock TIMEOUT** (`Test timed out in 5000ms`), not an assertion failure, under the loaded parallel run (the 42-test file took 6085ms there). **Re-run in isolation: 42/42 pass in 320ms.** This is the same class of environment-load flake the invoker pre-noted for `secrets/exec.test.ts` (it surfaced in `assemble.test.ts` this run); it is unrelated to the 079b/079c changes, so CI is treated GREEN.
- **audit:sql**: clean.

Auditor targeted re-runs (all pass): `tests/daemon/runtime/capture/` + `tests/commands/capture.test.ts` + `tests/daemon/runtime/health.test.ts` = **230/230**; `assemble.test.ts` isolated = **42/42**.

## Files changed (079b + 079c)

| File | Change |
|------|--------|
| `src/daemon/runtime/capture/capture-outbox.ts` | Core surface: `dead` status + `deadLetter()`/`markDead()` + `maxAttempts`/`maxAgeMs`; `resolveCaptureOutboxLimits()` + `clampIntKnob` env config; `counts()` 3-way partition; `kick()` single-flighted recovery drain; `shedToCap()` cap + oldest-first shed; `groupDue()`/`groupKey()`/`reappendMany()` coalesced drain; `maxDrainPerInterval` unified back-pressure cap (deprecated `drainBatch` alias). |
| `src/daemon/runtime/capture/capture-drain-api.ts` | **NEW** — `mountCaptureDrainApi` → `POST /api/diagnostics/capture-drain`, fail-soft 200, protected-group attach. |
| `src/commands/capture.ts` | **NEW** — `runCaptureVerb` thin-client `honeycomb capture drain` (read-through fail-soft). |
| `src/commands/contracts.ts` / `dispatch.ts` / `index.ts` | Wire the `capture` verb into `VERB_TABLE` + dispatcher + exports. |
| `src/daemon/runtime/capture/capture-handler.ts` | `kickOutboxDrain()` on both append-success branches (immediate + batched flush), fail-soft. |
| `src/daemon/runtime/assemble.ts` | Thread `resolveCaptureOutboxLimits()` into the outbox; mount the drain route (fail-soft); add the `deeplake.woke` resume-kick `Pausable`. |
| `src/daemon/runtime/health.ts` | `deadLettered` added to `HealthReasons.captureOutbox` + `HealthDetailInputs` + `buildHealthDetail` (legacy input → 0, `nonNegativeInt` normalization). |
| `tests/daemon/runtime/capture/capture-outbox.test.ts` | +b-AC-1..5 / c-AC-1..4 blocks; FIX-1 hardening test strengthened to heterogeneous shapes. |
| `tests/daemon/runtime/capture/capture-drain-api.test.ts` | **NEW** — route: forces one pass, fail-soft 200, secret-free body. |
| `tests/commands/capture.test.ts` | **NEW** — CLI verb + dispatcher wiring + read-through fail-soft. |
| `tests/daemon/runtime/health.test.ts` | Updated `captureOutbox` assertions for the additive `deadLettered`. |
| `tests/daemon/runtime/capture/capture-outbox-a-ac-8-mechanism.test.ts` | Updated drain-result assertion for the additive `deadLettered: 0` (non-regression). |

## Overall verdict (079b + 079c)

**SHIP.** All nine code ACs (b-AC-1..5, c-AC-1..4) PASS with independently-read code and independently-run tests; the four trickiest guarantees (per-member dead-letter on a failed coalesced group, the maxAgeMs path, the single authoritative per-pass cap, and 079a/079b non-regression) are each confirmed genuine. Security is CLEAN at High+ with route-authz PASS, and full CI is green apart from one load-induced wall-clock timeout that passes in isolation. No Critical or Warning findings; S-4/S-5 are forward-looking, non-blocking notes.
