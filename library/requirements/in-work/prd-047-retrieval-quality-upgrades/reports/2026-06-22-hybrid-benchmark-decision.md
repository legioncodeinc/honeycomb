# PRD-047a — native-hybrid vs RRF: benchmark DECISION (a-AC-3)

> Date: 2026-06-22 · Run: live, workspace `default`, embed daemon `nomic-embed-text-v1.5` (768-dim).
> **Decision: KEEP RRF. Do NOT adopt `deeplake_hybrid_record` as currently invocable.**

## How it was run
`HONEYCOMB_EMBEDDINGS=true npm run bench:hybrid` against live DeepLake with the developer creds
(`~/.deeplake/credentials.json`), seeded into the `default` workspace (the token is 403 on
`honeycomb_ci`), embed daemon warm. The committed golden set (~36 pairs) was seeded per-run, polled
to two-phase embedding convergence, and scored through BOTH `recallMemories` (RRF) and
`hybridRecall` (native `deeplake_hybrid_record`) on the same warm store. Weights swept.

## Measured results

| Path | recall@1 | recall@5 | recall@10 | MRR | nDCG |
|---|---|---|---|---|---|
| **RRF (current)** | 0.583–0.611 | **0.722–0.778** | 0.806–0.833 | 0.644–0.664 | 0.575–0.704 |
| Native hybrid (0.5/0.5) | 0.028 | 0.139 | 0.278 | 0.081 | 0.126 |
| Native hybrid (0.9/0.1) | 0.028 | 0.167 | 0.278 | 0.083 | 0.078 |

Native hybrid lost by a wide margin and was **weight-insensitive** (0.5/0.5 vs 0.9/0.1 barely
moved; recall@10 stuck at exactly 0.278). recall@1 = 0.028 ≈ 1/36 — *random* top-1 over the set.

## Root cause (diagnostic)
A direct score inspection (same query, same warm store) is conclusive:
- **Pure `<#>` vector arm** (what RRF consumes): top scores `0.7933, 0.7929, 0.7921, …` — a real,
  varying, correctly-ordered semantic ranking.
- **Native `deeplake_hybrid_record`**: **every row scored `0.000000`.** The operator returns
  `kind=ok` (it parses + executes — what the earlier operator probe confirmed) but emits a
  DEGENERATE constant-zero score, so `ORDER BY score DESC` is arbitrary → the near-random recall.

So the failure is NOT a fusion-weight tuning problem; the operator is not producing a usable score
through the `(embedding, content)::deeplake_hybrid_record <#> deeplake_hybrid_record(vec, text,
wV, wT)` form on Honeycomb's `memories` table. Most likely the operator requires setup the docs'
surface example omits (a registered hybrid / BM25 full-text index on the table, a different score
direction, or a different invocation), and absent that it falls back to a zero score.

## Decision + rationale
**KEEP RRF (PRD-027 D-2 stands).** The transparent, per-arm-testable RRF path scores recall@5
0.72–0.78; the native operator as invocable today scores 0.14–0.17 (random). This is exactly the
risk PRD-027 D-1 flagged for option (c): "couples ranking to the engine's hybrid semantics and is
harder to A/B." The A/B was run; native hybrid is not a drop-in win and is not adoptable without
deeper operator-contract investigation.

This is the benchmark working as intended: the operator *exists and executes* (probe: `kind=ok`),
but *executing ≠ ranking* — only the recall@k A/B + the score inspection surfaced the degenerate
output. Adopting on the probe alone would have shipped a near-random recall.

## Follow-up isolation (2026-06-22) — cause narrowed, vendor report filed
A focused isolation run (same query, same warm dataset) confirmed the zero score is **not** a
client-side formatting issue: the operator returns all-zero scores across BOTH the `ARRAY[…]::float4[]`
and the documented `'{…}'::float4[]` vector-literal forms, AND across balanced / vector-only /
text-only weights — including a text-only query that is an exact substring of a stored `content`
value. This rules out our serialization, the weights, and the vector format. A full technical report
for DeepLake is filed at
[`library/knowledge/private/ai/deeplake-hybrid-record-operator-report.md`](../../../../knowledge/private/ai/deeplake-hybrid-record-operator-report.md).

## Follow-up (only if native hybrid is revisited)
Before any future re-attempt, investigate the operator's FULL contract against DeepLake docs/support:
(1) does `deeplake_hybrid_record` require a registered hybrid/BM25 index on the table? (2) is the
score a similarity (DESC) or a distance (ASC)? (3) does the composite cast bind the stored embedding
as assumed? Re-run `npm run bench:hybrid` after any fix — the harness + score-inspection are in
tree. Until then, `hybrid-recall.ts` stays as the UNWIRED reference candidate; nothing in the live
recall path changed.

## Effect on PRD-047
- **047a: CLOSED — decision recorded (keep RRF).** No production wiring of native hybrid.
- The rest of PRD-047 (047b reranker, 047c dedup, 047d recency, 047e MMR, 047f graded eval) is
  UNAFFECTED — those improve the RRF path and never depended on native hybrid winning.
- Bonus signal: in the cleaner `default` workspace, RRF scored recall@5 ≈ 0.72–0.78, ABOVE the
  committed `honeycomb_ci` baseline (0.583) — consistent with fewer near-duplicate clones, and
  extra motivation for 047c (semantic dedup).
