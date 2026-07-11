# PRD-078: Local ANN Recall Index

> **Status:** Backlog (in-work — Phase 1 dispatched)
> **Priority:** P0 (this is the sole remaining blocker for non-empty per-turn injection; PRD-077 made recall *bounded*, but recall still returns 0 hits because the semantic query can't fit the budget)
> **Effort:** M (~few focused days across phases)
> **Schema changes:** None. Read-path only — an in-daemon vector index derived from the existing `memories.content_embedding`. No DDL, no writer change, no embedding change.
> **Base:** stacked on `feat/prd-077-per-turn-recall-fast-path` (uses `recallFast`/`buildFastSemanticArmSql`).

## Overview

PRD-077 bounded per-turn recall (`recallFast` returns at its deadline instead of hanging), but live dogfooding proved recall still returns **0 hits**: the semantic `<#>` cosine query over `memories.content_embedding` takes **~2.6s server-side** (4.6s wall) and gets deadline-cut at 3s.

The 2026-07-09 investigation (deeplake-dataset-worker-bee, measured live on the `apiary` workspace) established this is **structural, not tunable**: **Deep Lake has no vector-index primitive.** `CREATE INDEX ... USING vector` and `USING hnsw` are hard-rejected (`400 access method does not exist`); `deeplake_index` is BM25/text-only. The catalog has no index concept. So `<#>` is always a **brute-force full-column scan** that re-materializes the ~6MB embedding column each query, is I/O-bound (no warm-cache speedup across repeated runs), and scales **linearly** (2,004 embedded rows = 2.6s today; 100k ≈ 2 minutes).

There is no server-side fix. The only path to fast semantic recall is to move the vector search **into the daemon**: an in-RAM ANN index over the project's embeddings (PRD-077 deferred D-3). Deep Lake remains the durable, fleet-shared store; the local index is a hot read accelerator derived from it.

## Goals

- **Fast semantic recall.** The `memories` semantic arm answers from an in-daemon vector index in **sub-100ms** (flat cosine over the resident vectors) instead of a 2.6s Deep Lake round-trip, so `recallFast` returns real hits within budget and `injectedRefs` becomes non-empty.
- **Cloud-independent hot path.** Per-turn semantic recall does not depend on Deep Lake latency/availability at query time (Deep Lake sleeps + is slow — the whole reason this is needed).
- **Ranking preserved exactly.** Score normalization `((1 + cos) / 2)` (`vector.ts:242`), the 049b project-scope filter, and the `ScoredId[]` output shape are byte-identical, so downstream RRF / recency / hydrate / rerank are unchanged. No ranking regression — only the source of the vector scores changes.
- **Fail-soft to the `<#>` path.** When the index is cold/unavailable/disabled, the semantic arm falls back to the existing `<#>` SQL query (degrade, never fail).
- **Bounded memory, honest scale.** Flat in-RAM Float32 cosine is the v1 engine (viable to ~100k vectors/workspace); HNSW is the documented escape hatch beyond.

## Non-Goals

- **No migration off Deep Lake.** Deep Lake stays the durable/fleet store (write path, cross-daemon sharing, full corpus, all other tables). A pgvector/Qdrant migration is a separate, deliberate evaluation — explicitly out of scope here (owner chose D-3).
- **No `sessions.message_embedding` index in v1.** The raw-dialogue semantic arm has the same problem but a larger/different corpus — decided separately (a later phase or PRD).
- **No embedding-model / dimension / write-path change.** The 768-dim `nomic-embed-text-v1.5` vectors and the store-time embedding path are untouched.
- **No change to the lexical/BM25 arms, RRF, recency, rerank, or lifecycle.** The index only replaces the *semantic vector-search* step.

## Code-grounded current state

| # | Fact | Evidence |
|---|---|---|
| 1 | `<#>` semantic search over `memories` is ~2.6s server exec / 4.6s wall for 2,004 embedded rows; no warm-cache speedup (I/O-bound full-column scan). | Live measure 2026-07-09 (4 clean runs 2591/2432/2370/2414ms); metadata-only COUNT on same predicate ~433ms |
| 2 | Deep Lake exposes NO ANN index; `USING vector`/`USING hnsw` → 400; `deeplake_index` is BM25-only; catalog has no index concept. | Live DDL tests; `catalog/types.ts:80-95`, `schema.ts:110-114`, `pg-transport.ts:12-13` |
| 3 | The `<#>` query builders both re-materialize the column each call. | `buildVectorSearchSql` (`vector.ts:228-250`, score norm `:242`); `buildFastSemanticArmSql` (`recall.ts:~1013`, content-inline) |
| 4 | The semantic arm entry points that would call the local index. | `runSemanticArm` (`recall.ts:1048-1107`) heavy; `buildFastSemanticArmSql` in `recallFast` fast |
| 5 | Corpus is small + project-scoped: 2,110 `memories` rows, 2,004 embedded, ~all one project. Recall filters by `project_id` (049b) on every arm. | Live COUNT; `buildProjectScopeConjunct` on every arm |
| 6 | Embeddings source for the index: the embed daemon (`:3851`, ~13ms) + the stored `content_embedding` FLOAT4[768]. | `services/embed-client.ts`, `catalog/memories.ts:78` |

## Sub-features (phases)

| Phase | Scope | Status |
|---|---|---|
| **078a — index + cold-build + query (MVP)** | In-daemon vector store (`id → Float32Array` + `project_id`, `created_at`, `is_deleted`); cold-build on boot by paging `(id, content_embedding, …)` from Deep Lake; `localVectorSearch(queryVec, projectId, k)` = flat cosine + project scope, returning `ScoredId[]` with the verbatim `((1+cos)/2)` norm; wire into the `memories` semantic arm (fast + heavy) behind a config flag with the `<#>` SQL path as cold/disabled fallback. **This alone delivers fast recall from a boot-built index.** | **Dispatched** |
| **078b — freshness** | Write-through: on every `memories` write, upsert the vector into the index (hot-path cheap). `updated_at` watermark incremental pull so writes from OTHER fleet daemons are picked up. `is_deleted=1` → evict/tombstone. | Draft |
| **078c — scale + eviction** | RAM budget cap; lifecycle/activation eviction (ACT-R / `last_reinforced_at`, 058e) so only the hot working set stays resident; HNSW (`hnswlib-node`) swap-in beyond ~100k vectors. | Draft |

## Acceptance criteria (Phase 078a — MVP)

| ID | Criterion |
|---|---|
| a-AC-1 | An in-daemon vector index module holds `id → Float32Array(768)` + `project_id`/`created_at`/`is_deleted`, built at boot by paging embedded `memories` rows from Deep Lake (off the recall hot path; the cold-build is allowed to exceed the per-turn budget). A test asserts build-from-rows populates the index and skips rows with empty/wrong-dim embeddings. |
| a-AC-2 | `localVectorSearch(queryVec, projectId, k)` returns the top-k `ScoredId[]` by cosine, scored with the VERBATIM `((1 + cos) / 2)` normalization (`vector.ts:242`) and filtered by the 049b project scope (`project_id = P OR '' OR NULL`), ordered by score desc. A parity test asserts its top-k id order + scores match the `<#>` SQL over a fixed fixture (same vectors) within float tolerance. |
| a-AC-3 | The `memories` semantic arm (both the `recallFast` content-inline path and the heavy `runSemanticArm`) queries the local index when enabled + warm, producing the SAME `ScoredId[]`/hit shape so RRF/recency/hydrate/rerank downstream are byte-unchanged. A test asserts the arm returns index-sourced hits and downstream fusion is identical. |
| a-AC-4 | Fail-soft: when the index is disabled (flag off), cold (not yet built), or errors, the semantic arm falls back to the existing `<#>` SQL query — never fails. A test asserts each fallback branch. |
| a-AC-5 | Config flag (`HONEYCOMB_LOCAL_ANN_INDEX`, default decided at rollout) gates the whole path; documented default + env override, `amplificationConfig`-style. A test asserts the flag toggles index-vs-SQL. |
| a-AC-6 | Latency: a test/benchmark asserts `localVectorSearch` over the resident corpus completes in sub-100ms (vs the ~2.6s `<#>`), and no embedding-payload Deep Lake round-trip is issued on the warm query path. |
| a-AC-7 | Live acceptance (dogfood, recorded in the QA report): with the index built + enabled on the `apiary` workspace, one per-turn recall returns non-empty hits within budget and `injectedRefs` becomes non-empty. |

## Resolved decisions

| # | Decision |
|---|---|
| D-1 | **Local ANN over Deep Lake, not a backend migration.** Owner chose D-3 (2026-07-09): keep Deep Lake as the durable/fleet store; add the in-daemon index for reads. pgvector/Qdrant migration is a separate future evaluation. |
| D-2 | **Flat in-RAM Float32 cosine for v1.** 3KB/vector → 2k=6MB, 100k=300MB; flat SIMD-ish cosine over 100k ≈ 10–50ms. HNSW (078c) only past ~100k. Deep Lake has no index, so there is no server-side alternative. |
| D-3 | **Preserve ranking exactly.** Verbatim `((1+cos)/2)` norm, 049b project scope in-process, `ScoredId[]` shape unchanged → downstream RRF/recency/rerank/hydrate byte-identical. |
| D-4 | **`<#>` SQL stays as the cold/disabled fallback** — the index is an accelerator, never a hard dependency; recall degrades to the (slow) SQL path rather than failing. |

## Prior art

- **PRD-077** (per-turn recall fast path) — made recall bounded + fail-soft; its Open Question **D-3 "local ANN index"** is exactly this PRD. `recallFast`, `buildFastSemanticArmSql`, the fast lane, and the deadline race are the base this stacks on.
- **Investigation `library/ledger/EXECUTION_LEDGER-prd-077.md`** (2026-07-09 entries) — the live measurements proving Deep Lake has no vector index and `<#>` is a 2.6s brute-force scan; the deeplake-dataset-worker-bee's scoped D-3 design this PRD operationalizes.
