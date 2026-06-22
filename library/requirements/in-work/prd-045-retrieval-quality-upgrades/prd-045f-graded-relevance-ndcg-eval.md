# PRD-045f — Graded relevance + nDCG eval upgrade

> Status: backlog · Parent: PRD-045 · Wave: W0 · Type: S
> Goal: make rank-ORDER improvements measurable. Today the golden set is binary (relevance 1) and
> the gate is recall@5 / MRR; a reranker or recency change that improves ORDERING within the top-k
> can be invisible to a binary metric. Land graded relevance + nDCG FIRST so every later wave
> (045b/c/d/e) has an instrument that can see what it changed.

## Why
`src/eval/metrics.ts` already computes nDCG@10 (`ndcgAtK`, `idealDcgAtK`) and `aggregateMetrics`
already reports it — but the golden set (`eval/recall-golden.json`) carries `relevance: 1` on every
pair (binary), so nDCG collapses toward a binary signal and is NOT part of the gate
(`gateAgainstBaseline` enforces recall@5 + MRR only). The reranker (045b), recency (045d), and MMR
(045e) waves all change ORDER, not just presence — without graded relevance + a gated nDCG, their
wins are unprovable and could even regress unnoticed. This wave is cheap (the math exists) and
unblocks the measurement story for the rest of PRD-045.

## What (scope)
- Add graded `relevance` (e.g. 3 = the exact target, 2 = a strongly-related fact, 1 = tangentially
  relevant) to the golden pairs where a graded judgement is meaningful, keeping binary where it is
  not. Grow the judgements to small relevance CLASSES (more than one acceptable id per query) where
  the dogfood shows multiple correct answers.
- Make nDCG@10 a GATING-eligible metric in `gateAgainstBaseline` alongside recall@5 / MRR (with its
  own committed floor + `EPSILON`), so a rank-order regression fails the eval.
- Re-measure + re-commit the baseline (`eval/recall-baseline.json`) against the stabilized graded
  eval, extending the schema with the nDCG floor.

## Acceptance criteria
- **f-AC-1 — Graded golden set.** `eval/recall-golden.json` carries graded `relevance` on the pairs
  where it is meaningful; `GoldenPairSchema` already accepts it (`z.number().positive()`), so this is
  data + (optional) multi-id judgements, validated by `parseGoldenSet`.
- **f-AC-2 — nDCG is gated.** `gateAgainstBaseline` enforces a committed nDCG@10 floor (`baseline −
  ε`) in addition to recall@5 / MRR; `RecallBaseline` + `BaselineFileSchema` gain the `ndcg` field.
  Unit-tested with hand-computed nDCG expectations (the metrics module is already pure-tested).
- **f-AC-3 — Baseline re-committed.** A live, poll-convergent run measures the graded baseline and
  commits it with `placeholder: false`, documented in the baseline JSON `//` notes (mirroring the
  Wave-3 stabilization note).
- **f-AC-4 — Gates green; no secret/PII in the graded set** (grep-proven, per PRD-027 AC-7).

## Risks / Out of scope
- **Risk — grading subjectivity.** Graded labels are judgement calls. Mitigated by keeping the
  scale small (1–3), grading only where the dogfood makes the call obvious, and leaving binary
  elsewhere.
- **Out of scope — new query pairs.** Growing the SET (not the grading) is ongoing PRD-027 D-5 work;
  this wave grades the existing pairs + adds nDCG gating.

## Dependencies
- `src/eval/metrics.ts` (nDCG math — already built), `src/eval/golden.ts` (`gateAgainstBaseline`,
  schemas), `eval/recall-golden.json` + `eval/recall-baseline.json`.
