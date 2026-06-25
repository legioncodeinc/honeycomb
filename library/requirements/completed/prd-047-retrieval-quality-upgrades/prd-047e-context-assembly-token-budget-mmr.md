# PRD-047e — Token-budget + MMR context assembly

> Status: backlog · Parent: PRD-047 · Wave: W2 · Type: M
> Goal: replace the bare fixed top-k at the injection boundary with a token-BUDGETED, diversity-aware
> (MMR) selection — so recall fills a context window with maximum non-redundant signal instead of
> "5 paraphrases of one fact".

## Why
Recall returns a fixed top-k (`resolveRecallLimit`, `limit ∈ [1,200]`) with no token budget and no
diversity step. The consumer (agent context, dashboard, CLI) cannot say "give me the best ~4k tokens
of distinct memory"; it gets N rows that may be near-duplicates or wildly varying in length.
Maximal Marginal Relevance (MMR) trades a little pure relevance for diversity, which — combined with
the token budget — is what separates a window full of redundant rows from one full of distinct,
useful facts. This is the "after the candidates come back" gap, the last mile of result shaping.

## What (scope)
- Add an optional token-BUDGET mode to recall assembly: instead of (or alongside) the row `limit`,
  fill a caller-supplied token budget, counting tokens per hit (a cheap heuristic tokenizer is
  fine; exactness is not required for budgeting).
- Apply MMR over the (deduped, reranked) candidates when selecting into the budget:
  `select argmax [ λ·rel(d) − (1−λ)·max_{s∈selected} sim(d,s) ]`, λ a tuned knob, `sim` the
  candidate-embedding cosine already available. Diversity layered ON TOP of dedup (047c) — dedup
  removes near-identical; MMR spreads the rest.
- Keep the existing row-`limit` API working (budget mode is additive/opt-in), so no surface breaks.

## Acceptance criteria
- **e-AC-1 — Budget-bounded.** Given a token budget, recall returns the MMR-selected hits that fit
  the budget (not a fixed count); a smaller budget returns fewer, higher-value hits. Unit-tested with
  a deterministic token counter + known hit sizes.
- **e-AC-2 — Diversity beats fixed-top-k on redundancy.** On a candidate set of near-paraphrases +
  a few distinct facts, MMR selection surfaces the distinct facts that a pure top-k by score would
  crowd out. Unit-tested on a controlled fixture.
- **e-AC-3 — λ tuned, non-regressing.** λ is chosen on the golden set; recall@5 / MRR / nDCG hold
  at-or-above baseline (MMR may trade a hair of recall for diversity — that trade must be justified
  by the dogfood, recorded in `reports/`).
- **e-AC-4 — Back-compat + fallback.** The row-`limit` path is unchanged when no budget is supplied;
  the lexical fallback + fail-soft are intact; gates green.

## Risks / Out of scope
- **Risk — MMR can drop the single best hit for diversity.** Mitigated by a λ tuned high (relevance-
  favoring) and always keeping rank-1 (the top hit is never displaced by the diversity term).
- **Risk — token counting cost/accuracy.** A heuristic counter is enough for budgeting; an exact
  per-model tokenizer is out of scope.
- **Out of scope — per-consumer budget policy.** This provides the MECHANISM (budget + MMR); each
  surface (agent inject, dashboard, CLI) sets its own budget — those policies are their own work.

## Dependencies
- `recall.ts` (assembly / final selection — runs after 047b rerank + 047c dedup), candidate
  embeddings (cosine for MMR `sim`), `resolveRecallLimit` (the existing limit path this extends),
  PRD-047c (dedup — MMR assumes near-identical already collapsed), PRD-047f (the metric instrument).
