# PRD-047b — Reranker activation: eval measurement + default decision (b-AC-3)

> Date: 2026-06-24 · Run: live, workspace `honeycomb`, embed daemon `nomic-embed-text-v1.5` (768-dim),
> two-phase poll-convergent. Harness: `npm run eval:recall` on the graded golden set (047f).
> **Decision: ship the reranker WIRED + TESTED, default strategy `none`.** Measured ~0 lift on the
> synthetic instrument; `embedding-cosine` + `llm` stay activatable via config/env.

## What was measured

The embedding-cosine rerank stage (047b) re-scores the fused top-N (N=50) by cosine(query vector,
candidate embedding) after `fuseHits`, with a 300ms timeout → keep-RRF-order fallback. b-AC-3 asks:
on the graded golden set, does rerank hold recall@5 and not drop nDCG@10/MRR below `baseline − ε`,
ideally with a lift?

| Path | recall@1 | recall@5 | recall@10 | MRR | nDCG@10 | gate |
|---|---|---|---|---|---|---|
| RRF-only (f-AC-3 baseline run) | 0.583 | 0.639 | 0.667 | 0.600 | 0.596 | pass |
| RRF-only (bench run 1, 2026-06-24) | 0.583 | 0.611 | 0.611 | 0.589 | 0.573 | — |
| RRF-only (bench run 2, 2026-06-24) | 0.528 | 0.583 | 0.611 | 0.555 | 0.556 | — |
| **embedding-cosine rerank ON** | 0.583 | **0.611** | 0.639 | 0.593 | 0.584 | **pass** (floors 0.50) |

## Reading

Rerank-on recall@5 (0.611) sits **inside the RRF-only noise band** (0.583–0.639 across runs). MRR
(0.593) and nDCG (0.584) likewise land mid-band. The rerank **holds above every enforced floor**
(recall@5/MRR/nDCG floor 0.50) — so b-AC-3's hard bar (no drop below `baseline − ε`) is **met** — but
shows **no measurable lift**: it is statistically neutral on this instrument.

This is exactly the risk b-AC-3 pre-registered: *"cosine rerank ≈ the semantic arm signal. Re-cosine-ing
may add little over the `<#>` arm's own ranking. Mitigated by measuring on 047f's nDCG; if the lift is
~0, fall through to the `llm` strategy or drop rerank to `none` by default (the eval decides, not
assumption)."* On the synthetic golden set the queries are clean keyword-precise restatements, so the
`<#>` arm already ranks the target at/near the top — re-applying cosine reproduces nearly the same
order. The instrument cannot demonstrate the magnitude-recovery win the reranker targets (which shows
on messier production queries where RRF's rank-only fusion loses information).

## Decision (eval-driven, per the pre-registered rule)

**Default strategy = `none`.** The reranker is fully implemented, unit-proven (b-AC-1 cosine reorder,
b-AC-2 timeout-keeps-order, b-AC-4 fail-soft/no-vector → RRF), and **activatable** via
`reranker.strategy` config or `HONEYCOMB_RECALL_RERANKER=embedding-cosine`. It is OFF by default
because paying a per-recall embedding batch-fetch + cosine sort on the hot path is not justified by a
~0 measured lift. This mirrors the 047a precedent (keep the proven path; keep the candidate available;
do not adopt on assumption).

## Revisit triggers
1. A **graded multi-id** golden set (047f follow-on / PRD-027 D-5) or a dogfood-derived eval that
   exercises messier queries where RRF's discarded magnitude actually costs ranking.
2. The **`llm` / cross-encoder** strategy (higher ceiling) measured on that instrument.
3. A measured production MRR problem where the magnitude RRF discards is the cause.

Until then: capability shipped + tested, default `none`, RRF stays the live order.
