# PRD-077a: Single-Round-Trip Fast Recall

> **Parent:** [PRD-077: Per-Turn Recall Fast Path](./prd-077-per-turn-recall-fast-path-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** S-M (~0.5-1d)
> **Schema changes:** None.

## Overview

The per-turn recall renderer (`recall-renderer.ts`, PRD-076a) needs hits back inside a ~2.5s budget, but the daemon's `recallMemories` engine averages ~40s because it makes ~10-15 Deep Lake round-trips at ~1.5s each. This sub-PRD adds a **fast recall entrypoint** that answers a per-turn query in **one wall-clock round-trip**, and reroutes the renderer to it. The dashboard search keeps the heavy engine.

**RRF, recency, and full arm breadth are preserved.** The ranking signals that carry real quality — cross-arm reciprocal-rank fusion and recency dampening — are pure **in-memory** operations over the arm result rows (`fuseHits` + `applyRecencyActivation`), so keeping them costs no extra I/O. And running an arm is one parallel statement, so keeping *all* the heavy path's arms costs no extra wall-clock (only lane concurrency). The fast path therefore runs the **same arms as `recallMemories`** — `memories` (semantic `<#>` + lexical `ILIKE`), `memory`, `sessions` (semantic + lexical), and `hive_graph_versions` — concurrently, each content-inline (a content-returning `<#>` variant for the semantic arms; the lexical arms already return `content`), and fuses them exactly as the heavy path does. The fast/heavy difference is NOT which arms run — it is that the fast path drops the hydrate hop, the dedup embedding fetch, the (off-in-prod) rerank, and the dormant lifecycle stages, and runs in an isolated lane.

**On the currently-starved siblings.** `memory` (1 row), `sessions` (18 embedded of 3,517), and `hive_graph_versions` (3 `described` of 384; 381 `pending`) are near-empty today *only* because their populating pipelines are broken/disabled — the capture→embed pipeline (BUG-03/04) and nectar brooding (OPS-03), tracked separately. Running their arms now costs almost nothing (they return few rows), and it makes the fast path **future-proof**: the moment those pipelines are fixed, per-turn recall gains raw-dialogue and code-graph recall with zero re-work. The `memories` arms below are the representative example; the sibling arms follow the same content-inline + parallel shape.

Semantic arm (`<#>` cosine, `content` inline — no separate hydrate query):

```sql
SELECT id, content::text AS text, created_at::text AS created_at,
       ((1 + (content_embedding <#> ARRAY[/* 768 floats */]::float4[])) / 2) AS score
FROM "memories"
WHERE ARRAY_LENGTH(content_embedding, 1) > 0 AND is_deleted = 0
  AND (project_id = '<proj>' OR project_id = '')     -- 049b project segment
ORDER BY score DESC LIMIT <k>
```

Lexical arm (`ILIKE`, `content` inline — the existing `buildMemoriesArmSql` shape, `recall.ts:320-338`):

```sql
SELECT 'memories' AS source, id, content::text AS text, created_at::text AS created_at
FROM "memories"
WHERE content::text ILIKE '%<term>%' AND is_deleted = 0
  AND (project_id = '<proj>' OR project_id = '')
LIMIT <k>
```

All arm statements are issued in **parallel** (`Promise.all`) in the fast lane, so wall-clock ≈ one ~1.5s round-trip regardless of arm count (bounded by the lane's concurrency, which 077b sizes to fit the arm set). Then the **existing in-memory `fuseHits`** performs RRF over the arms' ranked lists (`score = Σ weight/(RRF_K + rank)`, `RRF_K = 60`, arm-class weights — distilled `memory` 1.0, raw `session` 0.4 — `recall.ts:496-557`), and the **existing recency dampening** applies the age decay from the inline `created_at`. The `<#>` cosine normalization (`vector.ts:242`), `fuseHits`, and the recency stage are all reused verbatim. No hydrate hop, no dedup embedding fetch, no rerank, no lifecycle I/O.

## Goals

- Add a fast recall path that runs the **heavy path's arms** (all tables — `memories`/`memory`/`sessions`/`hive_graph_versions`, semantic + lexical) **in parallel**, each returning `content` + `created_at` inline, project-scoped, then fuses them with the existing in-memory RRF + recency — **one wall-clock round-trip (~1.5s)**.
- **Preserve ranking quality AND breadth:** the arm set, RRF fusion (`fuseHits`), and recency dampening are all reused verbatim (fusion + recency are in-memory, zero extra I/O), so cross-arm corroboration, cross-table breadth, and freshness are intact. No cosine-only regression, no dropped-table regression.
- **Future-proof:** because the sibling arms run now (returning few rows while starved), the fast path auto-gains raw-dialogue + code-graph recall the moment BUG-03/04 + OPS-03 populate those tables — no re-work.
- Reuse the existing embed seam (`:3851/embed`, ~13ms), the `StorageClient`, the `sqlIdent`/`sqlLike`/`sLiteral` guards, the `<#>` operator + score normalization, the 049b project conjunct, the arm builders, `fuseHits`, and the recency stage. No new ranking engine.
- Reroute `recall-renderer.ts` to the fast path via the `fast: true` selector on `/api/memories/recall` (D-1), preserving its `AbortController` + fail-soft `""` contract and the `runUserPromptRecall` dedupe/nudge loop.
- Skip, on the fast path only: the semantic **hydrate** second hop (content is inline), the **dedup** candidate-embedding fetch (extra I/O), the **Cohere rerank** (off in prod — Portkey disabled), and the **dormant lifecycle** stages (activation/staleness/conflict/calibration, posture-gated to inert). The arm set, RRF, and recency are NOT skipped.

## Non-Goals

- No change to `recallMemories` for the dashboard/heavy path.
- No new arm, ranker, or lifecycle stage; the fast path is a strict subset of existing behavior.
- No `content_embedding` write-path or embedding-model change.
- No local ANN index (parent Open Question / future).

## User stories

- *As a Claude Code user*, when I submit a memory-relevant prompt, relevant memories are injected into the turn (not dropped because recall timed out).
- *As a daemon operator*, a per-turn recall costs one Deep Lake round-trip, not fifteen, so the shared compute + the per-turn latency both drop.

## Implementation notes

- **Entrypoint.** Add `recallFast(request, deps)` in `src/daemon/runtime/memories/recall.ts` that: embeds the query (existing `EmbedClient`; a null/unavailable embed drops the semantic arms and runs the lexical arms alone with `degraded: true`, mirroring the heavy path's honesty); builds the heavy path's arms in **content-inline** form — a new content-returning `<#>` variant (`buildFastSemanticArmSql`, a sibling of `buildVectorSearchSql` that SELECTs `content` + `created_at` inline instead of IDs-only, so no hydrate hop) for each embedding-bearing table (`memories`, `sessions`), plus the existing lexical arm builders (`buildMemoriesArmSql`, `buildMemoryArmSql`, `buildSessionsArmSql`, `buildHiveGraphVersionsArmSql`, which already return `content`); runs ALL arms through `runArm` inside a single `Promise.all` in the fast lane (077b sizes its concurrency to the arm count); then feeds the ranked arms into the EXISTING `fuseHits` (RRF, `recall.ts:496-557`) and the EXISTING recency-activation stage (`applyRecencyActivation`), returning a `MemoryRecallResult` with the surfaced `sources` and honest `degraded`. It does NOT call `fetchCandidateEmbeddings` (dedup), the rerank seam, or any lifecycle source. The `MemoryRecallResult` shape is unchanged, so the renderer/consumer needs no change.
- **SQL safety.** Every identifier through `sqlIdent`, the term through `sqlLike`, the 768-float literal through the existing `serializeFloat4Array` (`vector.ts:87-97`), the project segment through `buildProjectScopeConjunct`. No hand-quoting (the `audit:sql` scan must stay green).
- **Route.** Thread the `fast` selector through `RecallBodySchema` (`api.ts:303-323`) and the handler (`api.ts:588-633`) to call `recallFast` instead of `recallMemories`. Keep the session-group middleware + tenancy header contract identical.
- **Renderer.** Point `recall-renderer.ts` at the fast selector. No change to its header stamp, its `AbortController`, or its fail-soft `""`; only the request body/route gains `fast`.
- **Result parity.** The fast path returns the standard `MemoryRecallResult` — `hits` (each with `id`, `text`, `score`, `kind` [`memory`/`session` per arm-class], `createdAt`, `secondary`), the surfaced `sources`, and an honest `degraded` — identical in shape to `recallMemories`, so `runUserPromptRecall` and `renderContext` need no change.

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | `recallFast` issues the heavy path's arms as content-inline statements run in PARALLEL (one wall-clock round-trip), plus the local embed call: the round-trip count equals the arm count, with NO hydrate second hop and NO dedup call. A counting/timing storage-stub test asserts the arms are issued concurrently and there is no hydrate/dedup extra `storage.query`. |
| a-AC-2 | Every semantic arm returns `content` + `created_at` inline (no separate hydrate query); every arm is project-scoped. A test asserts the semantic SQL SELECTs `content::text` (not IDs-only) and all arms carry the 049b project segment. |
| a-AC-3 | RRF + recency + breadth preserved: `recallFast` runs the same arm set as the heavy path, fuses via the existing `fuseHits`, and applies the existing recency dampening, so its ranked output matches the heavy path with dedup/rerank/lifecycle disabled for the same query + scope. A test asserts `fuseHits` + the recency stage are invoked over all arms and the fast path's top-k order matches that reference over a fixture. |
| a-AC-8 | `recallFast` does NOT invoke dedup (`fetchCandidateEmbeddings`), the rerank seam, or any lifecycle source (`activationSource`/`stalenessSource`/`conflictSuppression`/`calibration`). A test asserts none of those seams are called on the fast path. |
| a-AC-4 | Embed-unavailable degrade: with no embed client / a null embed, `recallFast` drops the semantic arms, runs the lexical arms alone, and returns `degraded: true` (never throws). A test asserts the degraded branch. |
| a-AC-9 | A starved sibling arm returns 0 rows without erroring the recall (the per-arm `toScoredIds`→`[]` tolerance), so today's near-empty `memory`/`sessions`-semantic/`hive_graph_versions` arms are harmless, and a populated arm flows into fusion unchanged. A test asserts a 0-row arm degrades to empty-for-that-arm, not a failed recall. |
| a-AC-5 | SQL-safety: `npm run audit:sql` stays green; a test asserts identifiers/term/vector/project-segment all route through the guards, no hand-quoted value. |
| a-AC-6 | The renderer uses the fast selector and its fail-soft `""` + header contract is unchanged. A test asserts the request carries `fast` + the session/tenancy headers and that a hang still yields `""`. |
| a-AC-7 | The dashboard/heavy `recallMemories` path is unchanged (fast path is additive). A test asserts the heavy path still runs all four arms + hydrate + dedup. |

## Resolved decisions (2026-07-09)

- **D-1 — Flag on the existing route.** Expose the fast path via a `fast: true` field on `RecallBodySchema` behind `POST /api/memories/recall`; reuse the session-group middleware + tenancy header contract. Not a sibling route.
- **D-2 — All heavy-path arms, content-inline + parallel, RRF + recency in-memory, minus the I/O refinements.** Run the SAME arms as `recallMemories` (all tables — `memories`/`memory`/`sessions`/`hive_graph_versions`, semantic + lexical) concurrently, each content-inline, then fuse with the existing in-memory `fuseHits` RRF + recency — **RRF, recency, and cross-table breadth all preserved**. Drops only the hydrate hop, dedup, rerank (off), and dormant lifecycle. NOT memories-only; NOT a single cosine statement; not the native `deeplake_hybrid_record` op for v1. Rationale: the siblings are only starved by other (tracked-separately) bugs — BUG-03/04, OPS-03 — so keeping their arms costs ~nothing now and future-proofs the path.

## Open questions

- **Lexical-arm tokenization.** The lexical arm is the existing `buildMemoriesArmSql` whole-query `ILIKE '%…%'` (`recall.ts:320-338`), which matches ≈nothing for multi-word queries. Decide whether to tokenize it (per-token `OR`) now or defer — it's a secondary recall net behind the working semantic arm and the RRF fusion, and does not gate the latency fix. (Same question as the parent index; a fix here would benefit the heavy path's lexical arm too.)
