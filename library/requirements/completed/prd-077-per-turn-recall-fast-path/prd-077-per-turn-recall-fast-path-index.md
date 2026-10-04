# PRD-077: Per-Turn Recall Fast Path

> **Status:** Backlog
> **Priority:** P0 (the always-on memory-injection surface shipped in PRD-076a is currently **inert in every session**: live `~/.honeycomb/recall-sessions/<id>.json` records show `injectedRefs: []` across all sessions, and `request_log` shows `/api/memories/recall` p50 ≈ 40s / max ≈ 25min against a per-turn renderer timeout of 2.5s. The renderer aborts before recall answers on every qualifying turn, so the highest-value memory surface delivers zero context — the exact regression PRD-076a's latency budget was meant to prevent. This is the top functional defect from the 2026-07-09 investigation, BUG-17.)
> **Effort:** M (~1-2d)
> **Schema changes:** None. No catalog columns, no DDL. New content-inline read-only SQL variants over the existing recall tables (a content-returning `<#>` arm builder), a new fast recall entrypoint reusing the existing `StorageClient` + arm builders + `fuseHits`, a dedicated concurrency lane, server-side deadlines, and a per-turn timeout bump. No writer, ranker, or embedding changes.

---

## Overview

PRD-076a wired always-on, query-aware recall onto `UserPromptSubmit`: `recall-renderer.ts` POSTs the user's prompt to the daemon's `POST /api/memories/recall` on every qualifying turn and injects the top hits as `additionalContext`. It shipped with a deliberately tight budget — `DEFAULT_RECALL_TIMEOUT_MS = 2_500` (`src/hooks/shared/recall-renderer.ts:55`) — on the correct premise that a per-turn round-trip must be fast or it must fail soft.

The premise held; the latency did not. The 2026-07-09 live investigation measured the daemon recall path at **min 2,299ms, avg 40,343ms, max 1,539,771ms** (`request_log`, `/api/memories/recall`, status 200). The renderer's `AbortController` fires at 2.5s and fails soft to `""` on every turn, so `runUserPromptRecall` sees zero hits and takes the reminder-nudge branch (`src/hooks/shared/user-prompt-recall.ts:122-126`); the persisted `injectedRefs` set stays empty in every session. **Memory injection — the core value proposition — is delivered on zero turns**, even though the corpus is healthy (direct Deep Lake: 2,107 project memories, 2,002 embedded with distinct 768-dim vectors) and the raw vector query returns relevant hits in **under 1 second**.

### Why the daemon recall is ~40s (measured, not guessed)

The recall engine (`recallMemories`, `src/daemon/runtime/memories/recall.ts`) is a high-quality, multi-arm, multi-stage pipeline tuned for the **dashboard search** surface, where a human waits and wants the best possible ranking. On a per-turn hot path it is the wrong tool, for structural reasons the investigation isolated:

- **A single Deep Lake round-trip is ~1.5s** — the workspace is cloud-hosted at `api.deeplake.ai`; server-side execution is ~30ms, so ~1.47s per query is network/TLS/gateway. This is the unit cost of *every* statement.
- **One recall issues ~10-15 round-trips.** Recall fans out over up to four tables — `memories`, `memory`, `sessions`, `hive_graph_versions` — each with a semantic arm (`buildVectorSearchSql` returns **IDs + score only**, then a **separate** `buildSemanticHydrateSql` query fetches the text) plus a lexical arm, followed by a dedup candidate-embedding fetch (`fetchCandidateEmbeddings`, `recall.ts:1222`) and the optional rerank / recency / activation / staleness / conflict / calibration stages. That is two round-trips per semantic arm before any post-processing.
- **A process-wide shared `Semaphore(6)` throttles all of it.** `sharedRecallPool` (`recall.ts:115-122`) caps in-flight Deep Lake queries across **every** concurrent recall. Under real load — the dashboard polls several endpoints every ~1-2s *and* a recall fires on every harness turn — the six slots saturate, an unbounded queue forms, and per-recall latency balloons from a quiet-box ~5-8s to the measured ~40s average. The 25-minute tail is that backlog compounded (per-query retries are bounded: `RETRY_ATTEMPTS = 4`, backoff ≤1s, `client.ts:157-163`).
- **Wasted work every turn.** Recall queries `memory.summary_embedding` (0 embedded rows in this corpus) and `sessions.message_embedding` (only 18 embedded rows) on every call, and pays the IDs-then-hydrate two-hop even for the one table that matters.

### The fix: a deterministic, single-round-trip fast path for the hot lane

The dashboard search and the per-turn injector have opposite needs — one waits for maximum quality, the other has a 2.5s budget and wants "good, relevant memories, now." PRD-076a routed both through the same heavy engine. This PRD splits them:

- **Sub-PRD A — the fast recall path.** A per-turn recall that runs the **same arms as the heavy engine** (`memories` semantic + lexical, `memory`, `sessions` semantic + lexical, `hive_graph_versions`), but with every **semantic** arm returning `content` + `created_at` **inline** (no hydrate hop) and **all arms issued concurrently** in the fast lane, scoped to the session project, then fused with the existing **in-memory RRF (`fuseHits`) + recency dampening**. The fast/heavy difference is NOT the arm set — it is that the fast path drops the **hydrate hop, the dedup embedding fetch, the (off-in-prod) rerank, and the dormant lifecycle stages**, and runs in an isolated lane. So RRF, recency, and cross-table breadth are all preserved. Parallel arms ≈ ~1.5s wall-clock. Recall drops from ~40s to ~1.5s — inside the budget, full breadth + RRF intact.
- **Sub-PRD B — isolation and resilience.** A dedicated concurrency lane for the per-turn fast recall so a burst of dashboard traffic cannot starve it; a **server-side deadline** so a recall that cannot finish frees its slot instead of running to 25 minutes past a client that already aborted; **queue-depth load-shedding** so a saturated pool fast-fails a per-turn recall (inject nothing this turn) rather than queuing for minutes; and a modest per-turn timeout bump to give the ~1.5s fast query real headroom.

The floor from PRD-076a becomes reliable; this PRD makes it *fit*. It changes no ranking on the dashboard path, adds no schema, and reuses the existing embed daemon, storage client, and cosine operator verbatim.

### First-class design constraints (not afterthoughts)

- **Quality trade is explicit and bounded.** The fast path trades multi-arm fusion + rerank + lifecycle re-ranking for latency: `memories`-only, RRF-light, no rerank. For per-turn injection this is the correct trade — relevant memories *now* beats perfect memories at 40s (i.e. never). The dashboard search keeps the full-quality `recallMemories` path unchanged. This split is a design decision, recorded here, not a silent regression.
- **Fail-soft is preserved end to end.** The renderer already fails soft to `""`; the fast path and the server-side deadline must also degrade to "no injection," never a thrown hook or a blocked turn — byte-for-byte the PRD-076a posture.
- **No behavior change to the dashboard search or the store path.** `recallMemories` and its callers on the dashboard surface are untouched; only the per-turn renderer is rerouted to the fast entrypoint.

---

## Goals

- **Per-turn recall fits its budget.** On a qualifying `UserPromptSubmit`, the fast recall returns relevant, project-scoped hits within the renderer timeout on a normally-loaded daemon, so `runUserPromptRecall` injects real memories and `injectedRefs` is non-empty after a session with memory-relevant prompts.
- **One wall-clock round-trip, full breadth + RRF preserved.** The per-turn recall runs the heavy path's arms (all tables, semantic + lexical) in parallel with `content` inline, then fuses them in-memory (existing `fuseHits` RRF + recency) — eliminating the IDs-then-hydrate hop, the dedup embedding fetch, the off-in-prod rerank, and the dormant lifecycle I/O, while KEEPING every arm, RRF, and recency (all in-memory, free).
- **The hot lane cannot be starved or run away.** The per-turn fast recall has its own concurrency lane, a server-side deadline that frees its slot, and queue-depth load-shedding that fast-fails rather than queues under saturation. The 25-minute tail is structurally impossible.
- **The dashboard search is untouched.** `recallMemories` (RRF over `<#>` + `ILIKE`, all arms, rerank, dedup, lifecycle) remains the surface for the Memories page and any non-per-turn caller. No ranking, weighting, or arm change there.
- **No schema, no writer, no embedding change.** Pure read-path work over the existing `memories` table, the existing `content_embedding` column, and the existing embed daemon.
- **The fix is verifiable from live signal.** Success is measured the way the defect was found: non-empty `injectedRefs` in `recall-sessions/<id>.json`, and `/api/memories/recall` (fast path) p95 under the per-turn budget in `request_log`.

## Non-Goals

- **No change to the dashboard search / heavy recall *ranking*.** `recallMemories`, its four arms, RRF fusion, Cohere rerank, dedup, and the recency/activation/staleness/conflict/calibration stages are reused verbatim for the dashboard surface — no re-rank, re-weight, or arm change. The heavy path DOES gain a **generous server-side deadline** (a safety bound to cap the 25-minute runaway tail, per decision D-4); that bounds worst-case latency without touching what it returns on the happy path.
- **No new recall quality features.** No new ranker, no new arm, no new lifecycle stage, no query-shaping. The fast path is a *subset* of existing behavior, not new behavior.
- **No local ANN index (deferred, see Open Questions).** Maintaining an in-daemon vector index over project memories to make per-turn recall sub-10ms and fully cloud-independent is the "right" long-term architecture but is a larger change (index build + sync lifecycle); it is called out as a future direction, not built here.
- **No embedding-model, dimension, or `content_embedding` write-path change.** The embed daemon (`:3851`), the 768-dim `nomic-embed-text-v1.5` vectors, and the store-time embedding path are untouched.
- **No PRD-076b/c change.** The MCP tool surface, the bundled skill, and the slash commands are unaffected; this PRD is the per-turn injection latency fix only.
- **No dashboard connection-pool / poll-cadence fix.** The dashboard's aggressive polling that saturates the browser connection pool (investigation BUG-19) is a hive concern; this PRD relieves it indirectly by making the shared daemon path faster but does not change the hive client.

---

## Code-grounded current state

| # | Fact | Code / evidence |
|---|---|---|
| 1 | The per-turn renderer POSTs the prompt to `/api/memories/recall` on every qualifying `UserPromptSubmit`, bounded by a 2.5s `AbortController`, fail-soft to `""`. | `src/hooks/shared/recall-renderer.ts:47-55` (`RECALL_PATH`, `DEFAULT_RECALL_TIMEOUT_MS = 2_500`), `:39-40` ("TIGHT AbortController budget, tighter than the 5s prime budget") |
| 2 | When recall returns zero hits, `runUserPromptRecall` injects nothing and fires the throttled nudge; the persisted `injectedRefs` stays empty. | `src/hooks/shared/user-prompt-recall.ts:109-130` (dedupe + inject), `:122-126` (0-hits → nudge, `lastNudgeTurn := turns`) |
| 3 | Live: every session's recall record shows zero injections. | `~/.honeycomb/recall-sessions/<id>.json` = `{ injectedRefs: [], turns: N, lastNudgeTurn: N }` across all recent sessions (2026-07-09) |
| 4 | Live: the daemon recall is far slower than the budget. | `request_log` (`~/.apiary/honeycomb/.daemon/logs.db`), `/api/memories/recall` status 200, n=123: **min 2,299ms · avg 40,343ms · max 1,539,771ms** |
| 5 | The semantic arm returns IDs+score only, then a **separate** hydrate statement fetches text — two round-trips per semantic arm. | `src/daemon/storage/vector.ts:228-249` (`buildVectorSearchSql` → `SELECT id, score`), `src/daemon/runtime/memories/recall.ts:1017-1089` (`buildSemanticHydrateSql` + `runArm(hydrate…)`) |
| 6 | Recall fans out over up to four tables (memories/memory/sessions/hive_graph_versions), each semantic + lexical, then dedup + lifecycle. | `recall.ts:1150` (`Promise.all` of arm entries), `:1222-1258` (`fetchCandidateEmbeddings` dedup fetch), arm builders `:320-467` |
| 7 | A process-wide shared `Semaphore(6)` caps in-flight Deep Lake queries across ALL concurrent recalls. | `recall.ts:115-122` (`sharedRecallPool`, `amplificationConfig().recallMaxConcurrency`, default 6), `:944-950` (`runArm` acquires a slot) |
| 8 | A single Deep Lake statement is ~1.5s (remote round-trip; server exec ~30ms). Embedding the query is ~13ms. | Investigation profile 2026-07-09: memories `<#>` 1,776ms, sessions `<#>` 1,473ms, lexical ~1.3-1.6s; `:3851/embed` 13ms |
| 9 | The raw content-inline vector query over `memories` scoped to the project returns distinct, relevant hits in <1s. | Investigation: `SELECT id, content, ((1+(content_embedding <#> ARRAY[…]))/2) AS score FROM "memories" WHERE ARRAY_LENGTH(content_embedding,1)>0 AND (project_id=… OR project_id='') ORDER BY score DESC LIMIT k` → 0.81-0.85 hits, sub-second |
| 10 | The corpus is healthy: embeddings present and distinct, project-scoped. | Direct Deep Lake: `memories` 2,108 rows, `content_embedding` populated 2,002, `project_id` the-apiary 2,107 / __unsorted__ 1; sampled vectors distinct |
| 11 | Per-query retries are bounded, so the 25-min tail is a queue backlog, not a single slow statement. | `src/daemon/storage/client.ts:154-163` (`TRANSIENT_STATUSES`, `RETRY_ATTEMPTS = 4`, `RETRY_BASE_MS = 50`, `RETRY_MAX_MS = 1_000`) |
| 12 | The transport issues one request with the org/session/auth headers; it is the single network call site — where a keep-alive agent would live. | `src/daemon/storage/transport.ts:74-113` (`HttpDeepLakeTransport.query`, bare `fetch`) |
| 13 | `/api/memories/recall` accepts `{ query, limit?, tokenBudget?, recency?, cwd? }` behind the session-group middleware; the handler resolves scope and calls `recallMemories`. | `src/daemon/runtime/memories/api.ts:303-323` (`RecallBodySchema`), `:588` (route), `:633` (`recallMemories`) |
| 14 | The sibling recall tables are currently STARVED — but for their arms, not by design, and NOT this PRD's concern to fix: `memory` (summaries) = 1 row (summary worker not producing off the stalled `memory_jobs` queue, `assemble.ts:2412`); `sessions` = 3,517 raw turns but only ~18 `message_embedding` populated (PRD-005b embed-attach is default-on `assemble.ts:1275`, `capture-handler.ts:577`, but not running — same pipeline as BUG-03/04); `hive_graph_versions` = 384 rows but `describe_status` 381 `pending` / 3 `described` (nectar brooding idle — OPS-03). The **lexical** `sessions` arm still searches all 3,517 raw turns. The fast path runs all these arms regardless (they return few rows while starved), so it is correct now and auto-benefits when the separately-tracked BUG-03/04 + OPS-03 populate them. | Direct Deep Lake (2026-07-09): `memory` 1; `sessions` 3,517 / ~18 embedded; `hive_graph_versions` 384 (381 pending, 3 described) |

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-077a-single-round-trip-fast-recall`](./prd-077a-single-round-trip-fast-recall.md) | A per-turn fast recall entrypoint that runs the heavy path's arms (all tables, semantic + lexical) as **content-inline** statements **in parallel**, project-scoped, then fuses with the in-memory `fuseHits` RRF + recency — skipping only the IDs-then-hydrate hop, the dedup embedding fetch, and the lifecycle/rerank stages. Wire `recall-renderer.ts` to it via `fast: true` on `/api/memories/recall` (D-1). RRF, recency, and full breadth preserved; one wall-clock round-trip. | Draft |
| [`prd-077b-hot-lane-isolation-and-load-shedding`](./prd-077b-hot-lane-isolation-and-load-shedding.md) | A dedicated concurrency lane for the per-turn fast recall (so dashboard bursts can't starve it), a **server-side deadline** that aborts and frees the slot independent of the client abort, **queue-depth load-shedding** that fast-fails a per-turn recall under pool saturation, and a per-turn timeout bump (`DEFAULT_RECALL_TIMEOUT_MS` → ~4s). Makes the 25-minute tail structurally impossible. | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| m-AC-1 | On a qualifying `UserPromptSubmit` against a normally-loaded daemon, the fast recall returns the top project-scoped `memories` hits (content + score) within the per-turn budget, and `runUserPromptRecall` injects them: after a session with memory-relevant prompts, the persisted `recall-sessions/<id>.json` `injectedRefs` is **non-empty**. A test drives a recording daemon stub that returns hits within budget and asserts they are rendered into the turn and tracked in `injectedRefs`. |
| m-AC-2 | The fast recall issues the heavy path's arms as **content-inline** statements run in PARALLEL (one wall-clock round-trip): every semantic arm returns `content` inline (no separate hydrate query), and NO dedup embedding fetch, rerank, or lifecycle-source query is issued. A test with a counting/timing storage stub asserts the arms are issued concurrently and content-inline, and that the round-trip count = the arm count (no hydrate/dedup extra calls). |
| m-AC-3 | RRF + recency + full breadth are preserved: the fast path's ranked output equals the heavy path **minus** the dedup, rerank, and dormant-lifecycle stages — same arms, same `fuseHits` RRF, same recency — for the same query + scope. A parity test asserts the fast path's top-k order matches the heavy path with dedup/rerank/lifecycle disabled over a fixed fixture. |
| m-AC-4 | The dashboard search path's ranking is unchanged: `recallMemories` and its callers still run all four arms, rerank, dedup, and lifecycle, and return the same happy-path results. A test asserts the heavy path's query plan and sub-deadline result shape are unchanged (the fast path is additive; the only heavy-path addition is the D-4 deadline bound). |
| m-AC-5 | The fast recall fails soft: on timeout, non-200, malformed body, or a shed request, the renderer injects nothing and the turn proceeds — never a thrown hook, never a blocked turn. A test drives the stub to hang/error/shed and asserts the turn completes with no injection. |
| m-AC-6 | The per-turn fast recall runs in a dedicated concurrency lane and is not blocked by a saturated shared/dashboard pool. A test saturates the shared pool and asserts a concurrent fast recall still acquires a slot and completes within budget. |
| m-AC-7 | A server-side deadline bounds the fast recall independent of the client: a query that exceeds the deadline is aborted daemon-side and its slot released, and the handler returns a fail-soft empty result (not a 25-minute hang). A test with a hanging storage stub asserts the handler returns within the deadline and the slot is freed. |
| m-AC-8 | Under pool saturation past a configured queue-depth threshold, a per-turn fast recall is shed (fast-fail → empty result) rather than queued. A test asserts a shed request returns promptly with a degraded/empty signal and does not enqueue. |
| m-AC-9 | The per-turn renderer timeout is raised to give the fast query headroom (`DEFAULT_RECALL_TIMEOUT_MS` → ~4s) while remaining fail-soft. A test asserts the renderer's `AbortController` budget matches the constant and still degrades to `""` past it. |
| m-AC-10 | Live acceptance (manual/dogfood, recorded in the QA report): after the fix, one harness session with memory-relevant prompts shows non-empty `injectedRefs`, and `request_log` `/api/memories/recall` fast-path p95 is under the per-turn budget on a normally-loaded daemon. |
| m-AC-11 | (D-4) The dashboard/heavy `recallMemories` path is bounded by a generous server-side deadline: a heavy recall that exceeds it is aborted daemon-side and returns a partial-or-empty `degraded` result (never a 25-minute hang, never a 500), while a sub-deadline heavy recall is unaffected. A test asserts the heavy handler returns by the deadline on a hanging arm and is unchanged otherwise. |

---

## Resolved design decisions (2026-07-09, product owner)

| # | Decision |
|---|---|
| D-1 | **Fast-path selector = a flag on the existing route.** A `fast: true` field on `RecallBodySchema` behind `POST /api/memories/recall`, reusing the session-group middleware + tenancy header contract (least surface). NOT a sibling route. (077a) |
| D-2 | **Fast query = the heavy path's full arm set, content-inline + parallel, RRF + recency fused in-memory, MINUS the I/O-heavy refinements.** The fast path runs the SAME arms as `recallMemories` — `memories` (semantic `<#>` + lexical), `memory`, `sessions` (semantic + lexical), `hive_graph_versions` — but each **semantic** arm returns `content` + `created_at` **inline** (no IDs-then-hydrate hop, the lexical arms already do), all arms run **concurrently** in the fast lane, then fuse with the existing in-memory `fuseHits` RRF **and** recency dampening. So **RRF, recency, and full cross-table breadth are all preserved** — only the **dedup embedding fetch**, the **Cohere rerank** (OFF in prod — Portkey disabled), and the **dormant lifecycle** stages (activation/staleness/conflict/calibration) are dropped. ~1.5s wall-clock (parallel arms). **Future-proof:** the sibling tables are currently starved (`memory` 1 row, `sessions` 18 embedded, `hive_graph_versions` 3 `described` / 381 `pending`) *only* because their populating pipelines are broken/disabled (BUG-03/04 capture-embed, OPS-03 nectar — tracked separately); the fast path already runs their arms, so it auto-benefits the moment those populate. NOT memories-only; NOT a single cosine statement; NOT the native `deeplake_hybrid_record` op for v1. (077a) |
| D-3 | **Local ANN index = DEFERRED.** Ship the fast path first; only build the local in-daemon vector index if per-turn latency still isn't comfortably sub-budget under load. Recorded as a future direction, not this PRD. |
| D-4 | **Server-side deadline + load-shedding applies to BOTH lanes.** The per-turn fast lane gets a tight deadline; the dashboard/heavy `recallMemories` path ALSO gets a generous server-side deadline so the 25-minute runaway tail is structurally impossible everywhere. The heavy path's ranking/arms/quality are unchanged — only a safety bound is added. (077b) |

## Open questions

- **Lexical floor tokenization (077a).** The heavy `memories` arm matches the WHOLE query as one `ILIKE '%…%'` substring (`recall.ts:320-338`), which matches ≈nothing for multi-word queries. Since the fast path leads with the semantic `<#>` arm (which works) and folds a lexical `OR` (D-2), the lexical floor is a secondary safety net; decide whether to tokenize it (per-token `OR`) in 077a or defer. It does not gate the latency fix.
- **Server-side deadline values + queue-depth threshold (077b).** Pick the fast-lane deadline (e.g. ~3s, comfortably above the ~1.5s fast query, below the ~4s client budget), the **heavy-path deadline** (generous — e.g. ~10-15s — since a human waits but the 25-min tail must be capped, per D-4), and the pool queue-depth at which per-turn recalls shed. All config-backed (`amplificationConfig` neighborhood) and tuned from `request_log` latency, not hard-guessed. 077b sets defaults and the knobs.
- **Does the transport reuse connections? (077b / stretch).** If the ~1.4s-per-query overhead is a fresh TLS handshake (`transport.ts` uses bare `fetch`), a keep-alive undici `Agent` could roughly halve even the single-query latency. Confirm the current connection-reuse behavior before deciding whether to add a pooled agent; it is a cheap potential win but not required for the budget fit.

---

## Out of scope, explicitly

- **The dashboard search / heavy `recallMemories` engine** — reused verbatim; only a sibling fast entrypoint is added.
- **New recall quality (rankers, arms, lifecycle stages, query shaping)** — the fast path is a subset of existing behavior.
- **A local ANN index** — future direction, not built here.
- **Embedding model / dimension / `content_embedding` write path** — untouched.
- **PRD-076b/c (MCP tools, skill, slash commands)** — unaffected.
- **The hive dashboard poll-cadence / connection-pool fix (BUG-19)** — a hive concern; relieved indirectly, not changed here.
- **Capture, store, prime (`/api/memories/prime`) content or scoping** — untouched (though the prime path's own latency, investigation BUG-17 note on `/prime` 404×57, is a candidate sibling follow-up, not this PRD).

---

## Prior art

- **PRD-076 (`prd-076-always-on-recall-and-plugin-packaging`)**, sub-PRD 076a — built the per-turn `UserPromptSubmit` recall renderer and its 2.5s budget (`recall-renderer.ts`), on the explicit premise (076a Open Questions, "Latency budget") that a per-turn round-trip must be tight and fail-soft. This PRD is the follow-up that makes the daemon side actually meet that budget; the renderer's fail-soft contract and the `runUserPromptRecall` dedupe/nudge loop are reused unchanged.
- **PRD-047 (`prd-047-retrieval-quality-upgrades`)** — the heavy `recallMemories` engine (RRF over `<#>` + `ILIKE`, the arms, hydrate, rerank, dedup, recency). This PRD deliberately *bypasses* that pipeline on the hot lane and keeps it verbatim on the dashboard lane; 047's `<#>` cosine arm, score normalization (`vector.ts:228-249`), RRF `fuseHits`, and recency stage are what the fast path's content-inline arms reuse verbatim — 077 keeps 047's ranking, only shedding its I/O-heavy refinements on the hot lane.
- **PRD-062 (`prd-062-deeplake-compute-cost-reduction`)**, sub-PRD 062d — the process-wide shared recall `Semaphore` and `amplificationConfig().recallMaxConcurrency`, plus the `query-meter` `recall-arm` attribution. 077b adds a dedicated lane and load-shedding in this same concurrency layer.
- **PRD-046 (`prd-046-session-memory-priming`)** + `prime-renderer.ts` — the `AbortController` + fail-soft loopback pattern the recall renderer clones; the per-turn budget bump in 077b keeps the same posture (prime uses 5s).
- **Investigation `library/qa/investigation/2026-07-09-confirmed-bugs-and-fixes.md` (BUG-17)** in the-apiary superproject — the live measurements, the profile, and the root-cause analysis this PRD operationalizes. BUG-19 (dashboard fragility under this same daemon latency) is the downstream symptom this PRD indirectly relieves.
