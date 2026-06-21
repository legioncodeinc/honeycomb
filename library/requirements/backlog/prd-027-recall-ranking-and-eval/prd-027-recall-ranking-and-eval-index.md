# PRD-027 — Recall ranking + result shaping + a recall-eval harness

> Status: backlog · Owner: `/the-smoker` · Type: M (feature)
> Goal: recall returns RANKED, SHAPED results backed by a REAL relevance score — distilled `[memory]`
> facts above raw `[sessions]` dumps — and a recall-eval harness MEASURES recall quality on a golden
> query set so the semantic-on lift (PRD-025) is PROVEN and regressions are caught.

## Why
Running the real daemon this session, every recall returned a MIX of distilled `[memory]` session-summary
rows AND raw `[sessions]` tool-call JSON dumps, in **arm order, not relevance order**, with the "scores"
fabricated CLIENT-SIDE (`1 - i*0.06`) because the engine returns none. Three coupled defects in the live tree:
- **No real relevance score.** `src/daemon/runtime/memories/recall.ts` returns hits as
  `{ source, id, text }` — there is NO score field. The lexical arms are BM25/ILIKE substring matches with no
  ranking signal, and the result is merged in fixed arm order (`memories → memory → sessions`, line 253) then
  truncated. The caller (the dashboard / CLI) invents a descending score so the UI has *something* to show.
- **Raw session dumps pollute the top.** The `sessions` arm surfaces raw captured-turn JSON
  (`buildSessionsArmSql`, `message::text`) intermixed with the distilled `memory` summaries and `memories`
  facts. A raw tool-call blob can rank at or above a clean distilled fact, which is exactly backwards for a
  recall surface.
- **No way to MEASURE recall quality.** There is no golden set, no recall@k / MRR / nDCG, no
  `npm run eval:recall`. So PRD-025's "semantic is better" claim rests on a single hand-picked query (025
  AC-4), and any future change to ranking, the embedding model, or the SQL can regress recall silently.

The user explicitly asked to "plan out the best way" for this — so this PRD PRESENTS DESIGN ALTERNATIVES
with a RECOMMENDED approach for each of the three problems, not just requirements.

## What (scope)
Three coupled deliverables:
1. **A real relevance score + ranked recall.** Recall hits carry a real, comparable score, and the result is
   ordered by relevance — not arm order, not a client-side fabrication. The score fuses the lexical (BM25)
   and semantic (`<#>` cosine) signals into one ranking.
2. **Result shaping (provenance-forward).** Distilled `[memory]` facts and summaries rank ABOVE raw
   `[sessions]` dumps; raw session rows become drill-down/secondary, not top results; near-duplicates are
   deduped; every hit is provenance-tagged (source/scope) so the surface can render it honestly.
3. **A recall-eval harness.** A golden set of `(query → expected memory)` pairs + metrics (recall@k, MRR,
   nDCG) that runs both as a gated live itest and as a scriptable `npm run eval:recall`, and that GATES
   ranking/embedding/SQL changes against a regression threshold. This harness is the validation instrument
   for PRD-025.

## Design alternatives + recommendation

### Problem 1 — the scoring algorithm
The semantic arm already yields a normalized cosine score 0..1 (`vector.ts` `buildVectorSearchSql` →
`((1 + (emb <#> vec)) / 2)`). The lexical arms yield no score today. Options to combine them:
- **(a) Weighted-sum fusion.** Normalize BM25 to 0..1, combine `w_sem*cos + w_lex*bm25`. Simple, tunable,
  but sensitive to score-scale calibration and needs per-arm normalization that can drift.
- **(b) Reciprocal-rank fusion (RRF).** Rank within each arm, fuse by `Σ 1/(k + rank_arm)`. Scale-free
  (no normalization), robust to incomparable raw scores, well-suited to fusing a BM25 list with a cosine
  list. Standard hybrid-search default.
- **(c) The DB's native hybrid.** Use a `deeplake_hybrid_record`-style native hybrid path (the sibling
  product references this) so fusion happens in ONE DeepLake statement. Fewest round trips, but couples
  ranking to the engine's hybrid semantics and is harder to A/B against (a) and (b) offline.

**RECOMMENDED: (b) RRF as the default fusion, computed post-query, with the native hybrid path (c) kept as a
fast-follow once the eval harness can A/B it.** RRF is scale-free (it needs no BM25↔cosine calibration — the
weakest point of (a)), is the well-trodden hybrid-search default, and is trivial to reason about and test.
Computing it post-query (in `recall.ts`, over the per-arm ranked lists) keeps ranking debuggable and lets
the eval harness compare RRF vs weighted-sum vs native-hybrid on the SAME golden set before we commit ranking
into SQL. We add a small `score` to each `MemoryRecallHit` and order by it.

### Problem 2 — where ranking lives (SQL vs post-query)
- **(a) In SQL** — one ORDER BY in a UNION/hybrid statement. Fast, fewest round trips, but couples ranking to
  the per-arm SQL and the per-partition fresh-table tolerance the per-arm design exists to protect
  (`recall.ts` runs each arm separately precisely so a missing sibling table degrades to empty, not a 500).
- **(b) Post-query in `recall.ts`** — each arm returns its ranked list; fusion + shaping + dedup happen in TS.
  Slightly more in-process work, but keeps the per-arm fail-soft tolerance intact AND keeps fusion/shaping
  unit-testable and A/B-able.

**RECOMMENDED: (b) post-query fusion + shaping for v1**, preserving the per-arm guarded-query design;
revisit the native in-SQL hybrid (Problem 1 option (c)) only after the eval harness can prove it matches or
beats the post-query RRF on the golden set.

### Problem 3 — the eval harness
- **Golden-set sourcing.** Options: hand-curated `(query → expected memory)` pairs; mined from real captured
  sessions (a turn → a paraphrased query that should recall it); or synthetic. **RECOMMENDED: a small
  hand-curated seed (~30–50 pairs) committed to the repo, deliberately including lexical-MISS pairs (queries
  with no surface-token overlap with their target) so the set actually exercises the semantic lift**, grown
  over time from real misses observed in dogfood.
- **Metrics. RECOMMENDED: recall@k (k=1,5,10) as the headline + MRR; nDCG as a secondary signal** once the
  golden set has graded (not just binary) relevance. Recall@k answers "did we surface the right memory at
  all," which is the product question.
- **How it runs. RECOMMENDED: both** — a scriptable `npm run eval:recall` (offline-ish, against a seeded
  store, for fast local iteration) AND a gated live itest (real assembled daemon + real embed daemon, polling
  to embedding convergence) so the measured lift is proven end-to-end, not just in a fixture.
- **Gating. RECOMMENDED: a committed baseline `recall@5` + `MRR`; the eval FAILS if a change drops either
  below `baseline − ε`.** This is what turns "semantic is better" (025 AC-4, one query) into a defended,
  regression-gated property.

## Decisions
- **D-1 — RRF is the default fusion (Problem 1 (b)); weighted-sum + native hybrid are eval-bench candidates.**
  Recall hits gain a real `score`; ordering is by fused score, never arm order, never a client-side fake.
- **D-2 — Ranking + shaping live post-query in `recall.ts` (Problem 2 (b)),** preserving the per-arm
  fail-soft guarded-query design. No ranking is pushed into the per-arm SQL in v1.
- **D-3 — Provenance-forward shaping: arm priority + dedup.** Distilled `[memory]` (facts + summaries)
  outrank raw `[sessions]` dumps via an arm-class weight folded into the fused rank (a raw session row needs a
  materially stronger signal to outrank a distilled fact); near-duplicate hits across arms are deduped by
  identity/content; raw session rows are tagged as drill-down/secondary so the surface can demote them. Every
  hit carries `source` + scope provenance (already on the hit; surfaced through ranking, not dropped).
- **D-4 — The client stops fabricating scores.** Once recall returns a real `score`, the dashboard/CLI render
  the engine score and the engine order; the `1 - i*0.06` client-side fabrication is removed.
- **D-5 — Golden set: hand-curated seed (~30–50), committed, lexical-miss-inclusive (Problem 3),** grown from
  real dogfood misses. Lives in the repo so the eval is reproducible.
- **D-6 — Metrics recall@k + MRR headline, nDCG secondary; runs as BOTH `npm run eval:recall` and a gated
  live itest; gates on a committed `recall@5`/`MRR` baseline (Problem 3).**

## Acceptance criteria
- **AC-1 — Real score, real order.** `POST /api/memories/recall` returns hits each carrying a real `score`,
  ordered by fused relevance (RRF, D-1) — not arm order, not client-fabricated. Unit-tested: a query where the
  semantic-strong hit and the lexical-strong hit differ produces a fused order that matches the RRF math.
- **AC-2 — Facts above dumps (shaping).** Given a recall where a distilled `[memory]` fact and a raw
  `[sessions]` JSON dump both match, the distilled fact ranks ABOVE the raw dump, and the raw session row is
  tagged drill-down/secondary (D-3). Unit-tested on a mixed-arm fixture.
- **AC-3 — Dedup + provenance.** Near-duplicate hits across arms are collapsed to one, and every returned hit
  carries its `source` + scope provenance. Unit-tested.
- **AC-4 — Client stops faking scores.** The dashboard/CLI render the engine `score` + engine order; the
  `1 - i*0.06` fabrication is removed (grep-proven gone) and the rendered order equals the engine order.
- **AC-5 — Eval harness exists + scores recall (GATED LIVE ITEST + `npm run eval:recall`).** A committed
  golden set (~30–50 `(query → expected)` pairs, lexical-miss-inclusive) runs via `npm run eval:recall` AND a
  gated live itest against a real assembled daemon + real embed daemon (polling to embedding convergence),
  emitting recall@k (k=1,5,10) + MRR (+ nDCG). The harness reports per-query hits/misses.
- **AC-6 — The eval PROVES the PRD-025 lift + GATES regressions (the behavioral bar).** Run on the golden set
  with embeddings ON vs the BM25/ILIKE-only fallback, the harness shows semantic-on with the new ranking
  beats lexical-only on recall@5 / MRR (the measured, generalized version of 025 AC-4). A committed
  `recall@5` / `MRR` baseline is enforced: a change that drops either below `baseline − ε` FAILS the eval.
- **AC-7 — Gates green.** `npm run ci` / `build` / `audit:sql` / `audit:openclaw` / invariant stay green; the
  ranking + shaping preserve the per-arm fail-soft tolerance (a missing sibling table still degrades that arm
  to empty, never a 500); no secret/credential in eval output or fixtures (grep-proven).

## Risks / Out of scope
- **Risk — golden-set overfitting.** A tiny hand-curated set can be gamed by tuning to it. Mitigated by
  growing it from real dogfood misses (D-5) and keeping lexical-miss pairs that exercise the semantic path.
- **Risk — RRF `k` + arm-weight tuning.** The fusion constant and the `[memory]`-over-`[sessions]` weight are
  knobs that can mis-rank. Mitigated by the eval harness: every tuning change is measured on the golden set
  before it lands (D-6).
- **Risk — eval flakiness from eventual consistency.** A live eval that reads before embeddings converge would
  under-report recall. Mitigated by polling to convergence (per project memory), never a single read.
- **Out of scope — turning embeddings on / the embed runtime.** That is PRD-025. This PRD RANKS + SHAPES +
  MEASURES the results; it assumes the semantic arm can run (025 wires it on).
- **Out of scope — the `<#>` cosine SQL itself + the embedding model.** `vector.ts` `vectorSearch` and
  `nomic-embed-text-v1.5` are reused as-is; this PRD fuses/ranks their output, it does not re-derive the
  vector query or change the model/dimension.
- **Out of scope — the skillify/codify quality eval.** This harness scores RECALL quality only; skillify-gate
  quality is a separate concern.

## Dependencies
- **PRD-025 (coupled — bidirectional).** 025 turns the semantic `<#>` arm ON by default and feeds the store
  path real embeddings; 027 RANKS + SHAPES that output and provides the eval harness that VALIDATES 025's lift
  and gates its regressions. 027's ranking is only meaningful once 025's semantic arm runs; 025's "semantic is
  better" claim is only DEFENDED once 027's eval measures it. Sequence: 025 lands the semantic arm + AC-4
  single-query proof; 027 lands ranking/shaping + the generalized, gated eval. The eval harness (AC-5/AC-6) is
  the explicit validation instrument for PRD-025.
- **The recall engine** — `src/daemon/runtime/memories/recall.ts` (per-arm guarded queries + the `{source,id,
  text}` hit shape this PRD extends with `score`) and `src/daemon/runtime/memories/api.ts`
  (`/api/memories/recall`, which already surfaces `degraded`).
- **The `<#>` cosine + BM25 signals** — `src/daemon/storage/vector.ts` (`vectorSearch` / the normalized cosine
  score) for the semantic arm; the BM25/ILIKE arms in `recall.ts` for the lexical arm; the
  `deeplake_hybrid_record`-style native hybrid path (sibling product) as the Problem 1 (c) bench candidate.
- **The client renderers** — the dashboard recall bar + `honeycomb recall` CLI that currently fabricate
  `1 - i*0.06`, which D-4/AC-4 repoint to the real engine score.
- **DeepLake eventual consistency.** The live eval (AC-5/AC-6) must poll to embedding convergence before
  reading recall, never a single immediate read (per project memory).
