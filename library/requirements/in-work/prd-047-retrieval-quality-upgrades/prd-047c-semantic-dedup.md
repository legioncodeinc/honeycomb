# PRD-047c — Semantic / near-duplicate dedup

> Status: backlog · Parent: PRD-047 · Wave: W1 · Type: M
> Goal: stop the same fact from filling the top-k. Today dedup is `source+id` only, so one fact
> stored as a memory + a summary + several raw session turns surfaces multiple times. Collapse
> near-duplicates by embedding similarity, keeping the highest-provenance copy.

## Why
`fuseHits` in `recall.ts` dedups by `source+id` — it merges the SAME row seen by two arms, but it
does NOT merge two DIFFERENT rows that say the same thing. The live recall-eval already fights this:
the Wave-3 stabilization scores against a "relevance CLASS" of near-duplicate copies because the
shared workspace accumulates ~12 clones of one golden memory, and which clone `<#>` ranks first
shuffles run-to-run (`eval/recall-baseline.json` `//wave3` note). That workaround is direct evidence
the ENGINE should collapse near-duplicates so the surface shows distinct facts, not paraphrases.

## What (scope)
- After fusion (and after rerank, 047b), collapse hits whose embeddings exceed a similarity
  threshold (~0.9, tuned on the eval) into ONE, keeping the highest-PROVENANCE copy by class order
  `memories` (kept fact) > `memory` (summary) > `sessions` (raw turn) — and the higher fused score
  within a class. The dropped copies are removed from the result, not merely demoted.
- Use the embeddings already on the candidates (hydrated for rerank/semantic); no extra embed calls.
- Keep it provenance-aware: a near-dup across DIFFERENT facts must NOT collapse (threshold tuned to
  avoid false merges — measured, not guessed).

## Acceptance criteria
- **c-AC-1 — Near-dups collapse.** Given a fact present as a `memories` row + a `memory` summary + N
  `sessions` turns (embeddings within threshold), recall returns ONE hit — the `memories` copy.
  Unit-tested on a near-dup fixture with controlled embeddings.
- **c-AC-2 — Distinct facts survive.** Two semantically different hits below the threshold both
  remain. Unit-tested (the false-merge guard).
- **c-AC-3 — The eval workaround is retired.** With semantic dedup on, the recall-eval no longer
  needs the relevance-CLASS stability hack to stay stable run-to-run (or the hack becomes redundant);
  recall@5 / MRR / nDCG hold at-or-above baseline. Recorded in `reports/`.
- **c-AC-4 — Provenance + fallback intact.** Every surviving hit keeps its `source`/`kind`/`secondary`
  provenance; the lexical fallback + per-arm fail-soft are unchanged; gates green.

## Risks / Out of scope
- **Risk — over-collapsing.** Too low a threshold merges distinct facts and HIDES information.
  Mitigated by tuning the threshold on the golden set (with the false-merge guard c-AC-2 as a
  regression test) and erring high (collapse only obvious paraphrases).
- **Risk — cost.** Pairwise similarity over the candidate set is O(n²); n is the small top-N, so it
  is cheap, but the implementation must cap n (the fused top-N, not the whole result).
- **Out of scope — cross-WORKSPACE dedup / a write-time dedup.** This is READ-time shaping of one
  recall; collapsing duplicates at STORE time (or reaping clones) is separate.

## Dependencies
- `recall.ts` (`fuseHits` / post-rerank output), candidate embeddings (047b hydration),
  `src/daemon/storage/vector.ts` (cosine), PRD-017 (summaries — the `memory` provenance tier is most
  useful once real summaries exist), PRD-047f (the metric that proves neutral-or-better).
