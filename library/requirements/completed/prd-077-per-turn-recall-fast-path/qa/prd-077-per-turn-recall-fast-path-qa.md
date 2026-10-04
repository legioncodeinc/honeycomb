# QA Report — PRD-077 Per-Turn Recall Fast Path

> **Auditor:** quality-worker-bee (independent grader)
> **Date:** 2026-07-09
> **Branch:** `feat/prd-077-per-turn-recall-fast-path` (honeycomb submodule, working tree UNCOMMITTED)
> **Source plan:** [`prd-077-per-turn-recall-fast-path-index.md`](../prd-077-per-turn-recall-fast-path-index.md) + `prd-077a` + `prd-077b`
> **Ledger:** `library/ledger/EXECUTION_LEDGER-prd-077.md` (read-only; not edited)
> **Order:** ran AFTER `security-worker-bee` (L-S1 DONE, clean at High+). Correct sequence — no ordering violation.
> **Grader changed no production code** — verification only. Working tree = the 6 implementer-modified `src/` files + 6 new test files + the ledger, unchanged.

---

## 1. Summary

The implementation is **faithful, well-scoped, and genuinely tested**. All 26 unit-provable acceptance criteria (m-AC-1..9, m-AC-11, a-AC-1..9, b-AC-1..8) **PASS** against the actual code and tests — I read the concurrency, parity, spy, deadline-frees-slot, and shed-secrecy assertions and confirmed each proves the AC's real claim rather than a weaker stand-in. **m-AC-10 (live dogfood) is BLOCKED** by design — it requires a rebuilt daemon + a live harness session and cannot be closed with unit tests; manual close-out steps are given in §5. No stubs stand in for real behavior, no mocked seam launders a claim, and the fast/heavy split matches D-1/D-2/D-4 exactly. **VERDICT: SHIP** (pending the m-AC-10 dogfood sign-off, which is a post-merge live check, not a code gate).

Gate: full `npm run ci` is **GREEN** on a clean run (4736 passed / 0 failed / 13 skipped; jscpd 0 clones over threshold; typecheck 0 errors; `audit:sql` OK/309 files). One earlier run showed a single **environmental flake** — a 5000ms test-timeout in `assemble.test.ts` (PRD-022 tenancy, unrelated to PRD-077's changed files) under parallel resource contention; it passes 40/40 in 341ms in isolation and did not recur. See §4.

---

## 2. Scorecard (five-axis)

| Axis | Status | Notes |
|---|---|---|
| **Completeness** | PASS | Every planned artifact present: `buildFastSemanticArmSql`, `recallFast`, `fast` flag + engine-select, dedicated `fastRecallPool` lane, `QueryOptions.signal` threading, fast + heavy `AbortSignal.timeout` deadlines, queue-depth shed + `recall.shed` event, 4 config knobs, `DEFAULT_RECALL_TIMEOUT_MS`→4000. |
| **Correctness** | PASS | Fast path runs 7 arms in one `Promise.all`, content-inline, no hydrate/dedup; RRF+recency reused verbatim; degrade/shed/deadline all fail soft to `{hits:[],sources:[],degraded:true}`. Verified by reading, not assumed. |
| **Alignment** | PASS | Matches D-1 (flag on route), D-2 (all arms content-inline + parallel, minus I/O refinements), D-4 (both lanes bounded; heavy ranking untouched). Ledger default rulings R2/R3/R4/R5 (3000/15000/8/8) implemented as written. |
| **Gaps** | PASS (1 Note) | No functional gap. One AC (m-AC-1) has its `injectedRefs`-tracking half covered by the unchanged PRD-076a loop rather than a new fast-path unit assertion — see W1. |
| **Detrimental patterns** | PASS | No scope creep, no hand-quoted SQL (audit:sql green), no leaked Semaphore permit, no query text in `recall.shed`, heavy path additive-only. Security (L-S1) already confirmed clean. |

---

## 3. Per-AC verification table

Legend: **PASS** = code implements it AND a real test proves it · **BLOCKED** = cannot be closed by unit test (live/dogfood).

| AC | Verdict | Code (file · symbol) | Test (file · name) | Notes |
|---|---|---|---|---|
| **m-AC-1** / a-AC-6 (L-A8) | PASS | `recall-renderer.ts:126` `fast:true` in body; `:59` timeout; render→`{ref,text}` | `recall-renderer-fast.test.ts` "the renderer POSTs fast:true with the session/tenancy headers intact" | Renderer posts `fast:true`, headers intact, hits coerce to refs. `injectedRefs` **population** is the unchanged `runUserPromptRecall` loop (PRD-076a) — proven end-to-end only at m-AC-10 dogfood. See W1. |
| **m-AC-2** / a-AC-1 (L-A1) | PASS | `recallFast` `recall.ts` — single `Promise.all(allSqls...)`, 3 semantic + 4 lexical, no hydrate/dedup | `recall-fast.test.ts` "fires exactly 7 arms concurrently (peak in-flight == 7)..." | **Genuine peak-in-flight**: test parks all queries and asserts `gates.length===7` BEFORE any resolves, `peak===7`, `seen.length===7`, and `kinds` excludes `hydrate`/`vectorIds`/`embedFetch`/`confidence`. Round-trip count == arm count. Not a mere call-count. |
| **m-AC-3** / a-AC-3 (L-A3) | PASS | `recallFast` reuses `fuseHits` + `applyRecencyActivation` over all arms | `recall-fast.test.ts` "the fast path's hits equal the heavy path's over the same fixture" | **Real parity**: runs BOTH `recallFast` and `recallMemories` (rerank `none`, dedup off) over one shared 3-row fixture (m1/m2/s1 with distinct timestamps); asserts `fast.hits`/`fast.sources` deep-equal heavy AND that ancient m2 is demoted below fresh s1 (recency genuinely participates). Not trivial. |
| **m-AC-4** / a-AC-7 (L-A9) | PASS | Heavy `recallMemories` unchanged except additive `heavySignal` threading; `api.ts:668` engine-select is additive | `recall-fast.test.ts` "the heavy path issues a hydrate (IN-list) query AND a dedup embedding fetch"; `recall-hot-lane.test.ts` "recallMemories caps in-flight at ...(6)..." | Heavy still runs two-hop semantic (`vectorIds`+`hydrate`) + dedup (`embedFetch`) + shared pool @6. Lifecycle stages unchanged **by construction** (diff only threads a non-firing signal) + existing `recall.test.ts` coverage. See W2. |
| **m-AC-5** / a-AC-4 / b-AC-7 (L-A5, L-B7) | PASS | `recallFast` degrade/deadline/shed all return `{hits:[],sources:[],degraded:true}`; per-arm `runArm`→`[]` on non-ok | `recall-fast.test.ts` (null/throwing/wrong-dim embed) + `recall-hot-lane.test.ts` "every fast-path failure degrades..." (deadline/shed/transport-error) | Every error branch → no injection, never throws. Renderer hang → `[]` (`recall-renderer-fast.test.ts`). Fail-soft end-to-end confirmed. |
| **m-AC-6** / b-AC-1 (L-B1) | PASS | `fastRecallPool`/`resolveFastRecallPool` `recall.ts:134`; `recallFast` uses `deps.recallPool ?? resolveFastRecallPool()` | `recall-hot-lane.test.ts` "completes on the dedicated fast lane while a control routed through the saturated pool blocks forever" | Saturated shared `Semaphore(1)` (held, never released); control fast recall forced onto it parks forever (`controlDone===false`), REAL fast recall on dedicated lane completes; `shared.inFlight` stays 1. Proves true lane independence. |
| **m-AC-7** / b-AC-2 (L-B2) | PASS | fast-lane `AbortSignal.timeout(recallFastDeadlineMs)` threaded via `runArm`→`storage.query({signal})`; on `deadline.aborted` return empty degraded | `recall-hot-lane.test.ts` "a hanging storage stub is aborted daemon-side at the deadline..." | **Slot genuinely freed**: deadline 50ms, hanging storage; asserts elapsed <1000ms, `pool.inFlight===0`, `pool.waiting===0`, **and a subsequent `pool.acquire()` succeeds** (no leaked permit). Returns within deadline, not empty-eventually. |
| **m-AC-8** / b-AC-3 (L-B3) | PASS | shed guard `if (fastPool.waiting > config.recallFastShedQueueDepth)` → emit `onShed` + return empty; `RecallShedEvent` = `{lane,depth,threshold}` only | `recall-hot-lane.test.ts` "sheds promptly (query stub NOT called)... emits recall.shed with NO query text" | **Query stub `.not.toHaveBeenCalled()`** (no Deep Lake enqueue), event `{lane:'fast',depth:3,threshold:2}`, and `JSON.stringify(payload)` asserted to NOT contain the query text `super-secret`/`widget` (D-5 secret-free). |
| **m-AC-9** / b-AC-4 (L-B4) | PASS | `recall-renderer.ts:59` `DEFAULT_RECALL_TIMEOUT_MS = 4_000` | `recall-renderer-timeout.test.ts` "DEFAULT_RECALL_TIMEOUT_MS is 4000ms" + "AbortController budget matches the constant and a hang degrades to []" | Constant asserted == 4000 AND fake-timer hang past the budget degrades to `[]`. Fail-soft preserved. |
| **m-AC-10** (L-LIVE) | **BLOCKED** | n/a — requires rebuilt daemon + live session | n/a — not unit-provable | Live dogfood: non-empty `injectedRefs` in `recall-sessions/<id>.json` + fast-path p95 < budget in `request_log`. Manual steps in §5. **Does not block ship.** |
| **m-AC-11** / b-AC-8 (L-B8) | PASS | `recallMemories` wrapped in `heavySignal = AbortSignal.timeout(recallHeavyDeadlineMs)`, threaded into all arms; expiry → partial degraded via per-arm `[]` tolerance | `recall-hot-lane.test.ts` "a hanging arm is aborted at the heavy deadline; ...returns the partial set (degraded) and frees its slots" + "a sub-deadline heavy recall is unaffected" | Heavy deadline 50ms, one hanging + one completing arm; asserts elapsed <1000ms, returns partial (`m1`), `degraded:true`, `pool.inFlight===0`. Sub-deadline recall unchanged. Never 500/hang. |
| **a-AC-2** (L-A2) | PASS | `buildFastSemanticArmSql` SELECTs `content::text AS text, created_at::text AS created_at`; `projectClause` ANDed into every arm | `recall-fast.test.ts` "the memories semantic SQL SELECTs content::text... every arm carries the 049b segment" | Semantic arm content-inline (not ids-only); exact `buildProjectScopeConjunct` segment present in all 7 arms. |
| **a-AC-5** (L-A7) | PASS | `sqlIdent`/`sLiteral`/`serializeFloat4Array`/`buildProjectScopeConjunct` all inline in `buildFastSemanticArmSql`; no hand-quoting | `recall-fast.test.ts` "the vector rides serializeFloat4Array, the source is sLiteral-quoted..." + **`npm run audit:sql` green (309 files)** | Independently re-ran `audit:sql`: "every SQL interpolation routes through an escaping helper." Security L-S1 confirmed it's a true data-flow pass, not a laundered local. |
| **a-AC-8** (L-A4) | PASS | `recallFast` never calls `fetchCandidateEmbeddings`, rerank, or any lifecycle source | `recall-fast.test.ts` "none of fetchCandidateEmbeddings / rerank / activation / staleness / conflict / calibration fire" | **Real spies**: `cohereRerank.rerank`, `activationSource.load`, `stalenessSource.load`, `conflictSuppression.loadSuppressed`, `recordRecallAccess` all fully wired+enabled, each asserted `.not.toHaveBeenCalled()`; no `embedFetch`/`confidence` SQL. Output non-empty + `degraded:false`. |
| **a-AC-9** (L-A6) | PASS | per-arm `runArm`→`isOk?rows:[]` tolerance | `recall-fast.test.ts` "missing memory + hive_graph siblings do not fail the recall..." | Two siblings return `relation ... does not exist`; recall still fuses `memories`+`sessions` (`['m1','sess/1']`), `degraded:true`. |
| **b-AC-5** (L-B5) | PASS | Heavy path keeps shared pool (no fast lane, no shed) | `recall-hot-lane.test.ts` "recallMemories caps in-flight at DEFAULT_RECALL_MAX_CONCURRENCY (6)..." | Heavy peaks at 6 (shared); fast lane peaks at 7 (width 8, distinct). Heavy never shed. |
| **b-AC-6** (L-B6) | PASS | 4 knobs in `amplification-config.ts` via `clampedIntKnob`; env-mapped in `envAmplificationConfigProvider` | `amplification-config-hot-lane.test.ts` (defaults 8/3000/8/15000, override, clamp) + behavioral env override in `recall-hot-lane.test.ts` (real `process.env.HONEYCOMB_RECALL_FAST_DEADLINE_MS=50` drives the deadline) | Defaults, explicit override, and floor-clamp all asserted; env override proven **behaviorally** (not just parsed) in the hot-lane suite. |
| **b-AC-2/b-AC-8 signal plumbing** | PASS | `QueryOptions.signal` `client.ts:57`; folds external abort into statement controller `client.ts:544`; stops retry on abort `:488`; `vector.ts:325` threads signal | `client-external-signal.test.ts` "a slow query is aborted (timeout result) the instant the caller's signal fires, not after delayMs" | External `AbortSignal.timeout(30)` aborts a 10s fake transport response → `kind==='timeout'`, elapsed <1000ms, request reached transport. The daemon-side abort seam is real. |

**Tally: 26 PASS · 0 FAIL · 1 BLOCKED (m-AC-10, deferred to dogfood).**

---

## 4. Gate result

| Check | Result |
|---|---|
| `npm run ci` (clean run) | **GREEN** — `CI_EXIT=0` |
| Test Files | **444 passed / 444** |
| Tests | **4736 passed · 13 skipped · 0 failed** |
| Typecheck (`tsc --noEmit`) | 0 errors |
| Duplication (`jscpd`, threshold 7) | 0 clones over threshold |
| `npm run audit:sql` | OK — every SQL interpolation routes through an escaping helper (309 files) |
| PRD-077 six suites in isolation | **29 passed / 29** (recall-fast 10, recall-hot-lane 10, amplification-config-hot-lane 4, client-external-signal 1, recall-renderer-fast 2, recall-renderer-timeout 2) |

**Flake observed (not a PRD-077 defect):** the FIRST full `npm run ci` run reported 1 failed test — `tests/daemon/runtime/assemble.test.ts > d-AC-5 ... PRD-022 (local) a store with a session but NO org falls back to the daemon's default tenant`. The failure was **"Test timed out in 5000ms"** (a timeout, not an assertion), on a suite **unrelated to PRD-077's changed files**, under heavy parallel collection load (`collect 263.69s`). In isolation the suite passes **40/40 in 341ms**, and a second full `npm run ci` was clean (0 failed). Root cause: the default 5000ms per-test timeout is tight for this suite when the box is saturated by parallel workers. Filed here as a CI-stability observation (S2) so the smoker does not misread a red gate as a 077 regression. **The PRD-077 gate is green.**

---

## 5. m-AC-10 — BLOCKED (manual dogfood close-out)

m-AC-10 is live acceptance; it cannot be satisfied by unit tests. To close it, a human runs:

1. **Rebuild the daemon from the branch:** in `honeycomb/`, `npm run build` (or the harness's daemon-rebuild path), then restart the Honeycomb daemon so the `recallFast` route + fast lane are live.
2. **Run one memory-relevant harness session:** in a repo with a healthy corpus (e.g. the-apiary, 2k+ embedded memories), submit several `UserPromptSubmit` turns whose prompts match stored memories (e.g. "what did we decide about X").
3. **Confirm non-empty injection:** open `~/.honeycomb/recall-sessions/<session-id>.json` and verify `injectedRefs` is **non-empty** (the defect state was `injectedRefs: []` on every session).
4. **Confirm the latency budget:** query `request_log` (`~/.apiary/honeycomb/.daemon/logs.db`) for `/api/memories/recall` fast-path rows and verify **p95 < the per-turn budget** (client 4000ms; fast-lane server deadline 3000ms) on a normally-loaded daemon — versus the pre-fix avg 40,343ms / max 1,539,771ms.
5. Record the numbers in the ledger's L-LIVE row and flip it DONE.

Until then, L-LIVE stays BLOCKED. **This does not block merge** — the code path, its budget, and its fail-soft posture are all unit-proven; m-AC-10 is the live confirmation that the corpus + daemon deliver it end to end.

---

## 6. Findings (severity-classified)

No **Critical** issues. No **Warning** issues. The items below are Notes/Suggestions — none block ship.

### W1 — Note: `injectedRefs` tracking (m-AC-1) is proven via the unchanged loop, not a new fast-path assertion
The AC text says hits are "rendered into the turn and **tracked in `injectedRefs`**." The new `recall-renderer-fast.test.ts` proves the fast-path POST (`fast:true`) and that hits render to `{ref,text}`, but the actual `injectedRefs` set population lives in `runUserPromptRecall` (`src/hooks/shared/user-prompt-recall.ts`), which PRD-077 does **not** touch — so it is covered by pre-existing PRD-076a tests and confirmed end-to-end only at the m-AC-10 dogfood. This is sound (the fast path returns the identical `MemoryRecallResult` shape the tracking loop already consumes), but it is the one place where the AC's second clause is inferred rather than newly unit-asserted. *Optional:* add one integration test wiring the fast renderer output through `runUserPromptRecall` to assert a non-empty `injectedRefs`. Not required for ship.

### W2 — Note: heavy-path lifecycle stages not re-asserted as "still run"
m-AC-4 requires the heavy path still run "all four arms, rerank, dedup, **and lifecycle**." The new L-A9 test asserts hydrate + dedup fire; it does not re-assert the activation/staleness/conflict/calibration stages. This is acceptable because the `recallMemories` diff is **additive-only** (it threads a non-firing `heavySignal` into existing arms and wraps a deadline) and the existing `recall.test.ts` suite already covers lifecycle — but the "lifecycle unchanged" clause rests on diff review + prior coverage, not a new assertion. Confirmed by reading the diff. Not required for ship.

### S1 — Suggestion: no upper clamp on the config knobs
`clampedIntKnob` clamps a floor (deadline ≥ 1ms, width ≥ 1) but no ceiling — a fat-fingered `HONEYCOMB_RECALL_HEAVY_DEADLINE_MS=1500000` would restore a 25-minute-class bound. Security L-S1 already noted this as informational/non-attacker-reachable. Consider a documented upper clamp. Cosmetic.

### S2 — Suggestion: CI per-test timeout is flake-prone under parallel load
The `assemble.test.ts` PRD-022 case timed out at 5000ms during a saturated full run (see §4). Consider raising the default `testTimeout` for the daemon-assembly suites or reducing full-run worker parallelism on constrained machines, so the gate is deterministic. Out of PRD-077 scope; flagged so the red-then-green gate is not misattributed to this branch.

---

## 7. Files changed (implementer diff — grader modified none)

| File | Change |
|---|---|
| `src/daemon/runtime/memories/recall.ts` | +`buildFastSemanticArmSql` (content-inline `<#>` sibling), +`recallFast` (7 arms, one `Promise.all`, reuses `fuseHits`+`applyRecencyActivation`, skips hydrate/dedup/rerank/lifecycle), +`fastRecallPool`/`resolveFastRecallPool`/`resetFastRecallPool`, +`RecallShedEvent`/`onShed`, +`signal` threaded through `runArm`/`runSemanticArm(s)`, +heavy-path `heavySignal` deadline (D-4). |
| `src/daemon/runtime/memories/api.ts` | +`fast` on `RecallBodySchema`, +engine-select (`recallFast` vs `recallMemories`), +`RECALL_SHED_EVENT`/`logRecallShed`, +`onShed` wiring (fast+logger only). |
| `src/daemon/runtime/memories/amplification-config.ts` | +4 knobs (`recallFastMaxConcurrency`/`recallFastDeadlineMs`/`recallFastShedQueueDepth`/`recallHeavyDeadlineMs`) via shared `clampedIntKnob`, defaults 8/3000/8/15000, env-overridable. |
| `src/daemon/storage/client.ts` | +`QueryOptions.signal`, folds external abort into the statement controller, stops retry once aborted. |
| `src/daemon/storage/vector.ts` | +optional `signal` param threaded into both `<#>` and lexical-fallback statements. |
| `src/hooks/shared/recall-renderer.ts` | `DEFAULT_RECALL_TIMEOUT_MS` 2500→4000; `fast:true` in request body. |
| `tests/daemon/runtime/memories/recall-fast.test.ts` (new) | L-A1..A7, L-A9 — 10 tests. |
| `tests/daemon/runtime/memories/recall-hot-lane.test.ts` (new) | L-B1..B3, L-B5, L-B7, L-B8 — 10 tests. |
| `tests/daemon/runtime/memories/amplification-config-hot-lane.test.ts` (new) | L-B6 — 4 tests. |
| `tests/daemon/storage/client-external-signal.test.ts` (new) | signal plumbing — 1 test. |
| `tests/hooks/shared/recall-renderer-fast.test.ts` (new) | L-A8 — 2 tests. |
| `tests/hooks/shared/recall-renderer-timeout.test.ts` (new) | L-B4 — 2 tests. |

---

## 8. Overall verdict

**SHIP.** The PRD-077 implementation meets every unit-verifiable acceptance criterion with tests that prove the real claim (peak-in-flight concurrency, RRF+recency parity over a genuine fixture, spies asserting zero refinement calls, deadline-frees-the-slot with a follow-up acquire, shed-without-query-and-without-query-text, heavy-path additive-only). SQL safety is a true pass, the fail-soft posture holds on every error branch, and the gate is green on a clean run. Security ran first and was clean. The only open item is **m-AC-10 (live dogfood, BLOCKED)** — a post-merge live confirmation with the manual steps in §5 — which by design does not gate the code. No Critical or Warning findings; two Notes (W1/W2) and two Suggestions (S1/S2) are non-blocking.
