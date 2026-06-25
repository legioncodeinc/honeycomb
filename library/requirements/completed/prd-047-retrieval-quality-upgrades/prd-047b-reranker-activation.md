# PRD-047b — Reranker activation

> Status: backlog · Parent: PRD-047 · Wave: W1 · Type: M
> Goal: consume the reranker that is already CONFIGURED but never CALLED. RRF fuses ranks and throws
> away score magnitude; a rerank on the top-k recovers it. Highest quality-per-effort win in PRD-047
> because the plumbing is half-built.

## Why
`src/daemon/runtime/recall/config.ts` defines a reranker — default strategy `embedding-cosine`, a
300ms timeout, keep-order-on-timeout, and an `llm` / `none` strategy enum — but `recall.ts` never
reads it. RRF (`fuseHits`) orders by `Σ weight/(k+rank)`: it sees each arm's RANK, not how STRONG
the match was. A reranker re-scores the fused top-k by an actual relevance signal, fixing the case
where the right memory is in the top-k but not at the top (the MRR lever).

## What (scope)
- Wire a rerank stage into `recall.ts` AFTER `fuseHits`, over the top-N fused candidates (N a tuned
  knob, e.g. 50), gated by the existing `reranker` config.
- **`embedding-cosine` (default):** re-score each candidate by cosine of the already-embedded query
  against the candidate's stored embedding (hydrated with the candidate, or fetched in one guarded
  batch). No new model, no new infra — the query vector and candidate embeddings already exist.
- **`llm` (follow-up, behind the config):** a small LLM/cross-encoder rerank on a short top-k for the
  higher ceiling, measured before it becomes default.
- **`none`:** the current RRF-only behavior (escape hatch).
- Preserve the configured 300ms timeout → keep-prior-order fallback (a slow reranker never stalls or
  reorders to worse-than-RRF).

## Acceptance criteria
- **b-AC-1 — The configured reranker runs.** A recall with `reranker: "embedding-cosine"` reorders
  the fused top-N by the rerank score; `none` leaves RRF order untouched. Unit-tested against a fake
  candidate set with known embeddings (deterministic reorder).
- **b-AC-2 — Timeout keeps order.** A reranker that exceeds the 300ms budget yields the pre-rerank
  (RRF) order, never a partial/blank reorder. Unit-tested with an injected slow clock.
- **b-AC-3 — Measured non-regression (ideally a lift).** On the graded golden set (047f), rerank
  does not drop recall@5 and does not drop nDCG@10/MRR below `baseline − ε`; the expectation is an
  MRR/nDCG lift (the magnitude RRF discarded). Recorded in `reports/`.
- **b-AC-4 — Fallback + fail-soft intact.** The silent lexical fallback (`degraded`) and per-arm
  fail-soft are unchanged; a rerank failure degrades to RRF order, never a 500. Gates green.

## Risks / Out of scope
- **Risk — cosine rerank ≈ the semantic arm signal.** Re-cosine-ing may add little over the `<#>`
  arm's own ranking. Mitigated by measuring on 047f's nDCG; if the lift is ~0, fall through to the
  `llm` strategy or drop rerank to `none` by default (the eval decides, not assumption).
- **Out of scope — training/hosting a cross-encoder.** The `llm` strategy reuses the existing
  inference router; no new model training here.

## Dependencies
- `src/daemon/runtime/recall/config.ts` (the reranker config — already defined), `recall.ts`
  (`fuseHits` output is the rerank input), `src/daemon/storage/vector.ts` (cosine), the query embed
  (already computed for the semantic arm), PRD-047f (the nDCG instrument that proves the lift).
