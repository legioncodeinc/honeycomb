# PRD-047 — Retrieval quality upgrades (native hybrid, rerank, dedup, recency, assembly)

> Status: Completed (2026-06-25 — merged #97 `cdc909d`; all waves wired into live `recallMemories`; QA PASS 31/31) · Owner: `/the-smoker` · Type: L (multi-feature)
> Goal: take the recall engine from a strong-but-bare hybrid+RRF floor (PRD-025/027) to a
> shaped, reranked, freshness-aware result — by adopting the capabilities Honeycomb already
> pays for (DeepLake's native hybrid operator; the scaffolded-but-unconsumed reranker) and
> the cheap wins the eval harness can now prove (semantic dedup, recency dampening,
> token-budget + MMR assembly). Every change lands behind the PRD-027 golden-set eval.

## Why
A grounded read of the live retrieval path (`src/daemon/runtime/memories/recall.ts`,
`src/daemon/storage/vector.ts`, `src/eval/*`) shows a retrieval CORE that is genuinely good —
hybrid lexical+semantic, fused with RRF (`RRF_K=60`, arm-class weights), measured by a real
golden-set eval with a committed, enforced baseline (recall@5 ≈ 0.583). That core is ahead of
the median "embeddings on pgvector" shop. The gaps are NOT in the core; they are everything
**before** the query hits the index and **after** the candidates come back, plus two
capabilities the codebase already carries but does not use:

- **The DB's native hybrid operator is unused.** DeepLake ships `deeplake_hybrid_record`
  (vector + BM25 fused in ONE statement, tunable weights). PRD-027 D-1 chose post-query RRF for
  v1 and explicitly named the native path as a "fast-follow once the eval harness can A/B it."
  The harness now exists — so the A/B is owed. We are reimplementing in TypeScript a fusion the
  engine offers natively. (`.claude/skills/retrieval-stinger/templates/recall-query.sql` even
  references the operator; the engine never calls it.)
- **The reranker is scaffolded but never consumed.** `src/daemon/runtime/recall/config.ts`
  defines a reranker (`embedding-cosine` default, 300ms timeout, keep-order-on-timeout) but
  `recall.ts` never invokes it. RRF fuses RANKS, discarding score magnitude; a rerank on the
  top-k recovers it. The plumbing is half-built.
- **No semantic dedup.** Recall dedups by `source+id` only (`fuseHits`). The SAME fact stored as
  a kept memory, a summary, and several raw session turns surfaces multiple times and crowds the
  top-k. (The live eval literally fights this — it scores against a "relevance class" of
  near-duplicate copies to stay stable. That workaround is evidence the engine should collapse
  them.)
- **No recency signal.** Agent memory goes stale faster than documents, but the `D-5` recency
  dampening knob in `recall/config.ts` is an unconsumed stub. A six-month-old fact can outrank
  last week's.
- **No token-budget / diversity in assembly.** Results are a fixed top-k (`limit ∈ [1,200]`),
  no token budget, no MMR — so "5 paraphrases of one fact" can fill the window instead of "5
  distinct useful facts."

The eval harness (PRD-027) is the moat: every item below can be adopted EMPIRICALLY (measured on
the golden set, gated against the baseline) rather than on faith. This PRD spends that moat.

## What (scope)
Six waves, sequenced so the cheapest measurement-enabling work comes first and the highest
quality-per-effort wins land early:

| Sub-PRD | Wave | Deliverable | Confidence |
|---|---|---|---|
| **047a** | W0 | Native `deeplake_hybrid_record` vs RRF **benchmark + adoption gate** | built (slice landed) |
| **047f** | W0 | **Graded relevance + nDCG** eval upgrade (so rank-order changes are measurable) | high |
| **047b** | W1 | **Reranker activation** (consume the scaffolded cosine/LLM reranker on top-k) | high |
| **047c** | W1 | **Semantic / near-duplicate dedup** (collapse by embedding similarity, keep top provenance) | high |
| **047d** | W1 | **Recency dampening** (age-decay multiplier on the fused score) | high |
| **047e** | W2 | **Token-budget + MMR context assembly** (diversity-aware, budget-bounded result set) | medium |

Each sub-PRD lands behind the PRD-027 eval: a change that drops recall@5 / MRR below
`baseline − ε` FAILS, and a quality change must show a measured, non-regressing improvement (or
explicit neutrality with a different justification, e.g. dedup trades a hair of recall for
de-duplicated top-k).

## Design alternatives + recommendation (per wave)

### 047a — native hybrid vs RRF (the deferred PRD-027 D-1 A/B)
Three fusion options were named in PRD-027 D-1: (a) weighted-sum, (b) RRF (shipped), (c) the
DB's native `deeplake_hybrid_record`. **RECOMMENDED: run (c) against (b) on the golden set
before adopting.** The benchmark slice is built (`hybrid-recall.ts` + `hybrid-benchmark-live.itest.ts`
+ `npm run bench:hybrid`); the gate is its numbers. Adopt native hybrid IFF it ties-or-beats RRF
on recall@5 / MRR at ≤ the code surface — because then DeepLake's signature feature finally earns
its keep AND we delete the TS rank-bookkeeping. If it loses, that is itself a strong signal about
whether the store fits the data, and we keep RRF.

### 047b — where the reranker runs
- **(a) embedding-cosine rerank** (the configured default) — re-score the top-k by raw cosine of
  the (already-embedded) query against candidate embeddings. Cheap, no extra model, recovers the
  magnitude RRF discards.
- **(b) cross-encoder / LLM rerank** — a heavier, higher-ceiling reranker on a small top-k.
**RECOMMENDED: ship (a) first** (it is what the config already names, zero new infra), expose
(b) behind the existing `reranker: "llm"` strategy as a measured follow-up. Either way the
300ms-timeout keep-order fallback already specified stays.

### 047c — dedup granularity
- **(a) exact content hash** — collapse byte-identical text. Misses paraphrases.
- **(b) embedding-cosine cluster** — collapse hits whose embeddings exceed a similarity
  threshold (~0.9), keeping the highest-provenance copy (memory > summary > session).
**RECOMMENDED: (b)**, threshold tuned on the golden set; it is the direct fix for the
near-duplicate crowding the eval already works around.

### 047d — recency model
- **(a) hard recency cutoff** — drop old rows. Lossy; forgets durable facts.
- **(b) multiplicative age-decay** on the fused score (half-life tunable). Demotes stale rows
  without dropping them.
**RECOMMENDED: (b)**, half-life a tuned knob, eval-gated — never a hard cutoff.

### 047e — assembly
- **(a) fixed top-k** (today). Simple; redundant.
- **(b) token budget + MMR** — fill a token budget with maximal marginal relevance, trading a
  little pure relevance for diversity.
**RECOMMENDED: (b)**, with the token budget as the surface's contract and MMR λ tuned on the eval.

## Decisions
- **D-1 — Native hybrid is ADOPTED ONLY ON EVIDENCE (047a). RESOLVED 2026-06-22: NOT adopted —
  keep RRF. RE-AFFIRMED 2026-06-24: operator now FIXED but only TIES RRF — still keep RRF.** The
  2026-06-22 live A/B found native `deeplake_hybrid_record` returned a degenerate constant-zero score
  (random ordering, recall@5 0.14–0.17 vs RRF 0.72–0.78, weight-insensitive). A 2026-06-24 re-run
  found DeepLake has since FIXED the operator: it now ranks for real and is weight-sensitive, scoring
  recall@5 0.611 / MRR 0.589 vs RRF's 0.611 / 0.593 — a TIE on recall@1/@5, marginally behind on
  recall@10/MRR/nDCG. It ties but does not BEAT, so the adoption gate (tie-or-beat recall@5 AND MRR)
  is still not cleared. A cost/benefit review confirmed adoption buys no package savings (RRF is
  hand-rolled, zero deps; both paths need the embed daemon + DeepLake), no clear cost saving, and
  only ~5→~3 DeepLake round-trips per recall — not worth re-coupling ranking to an opaque operator
  for parity. RRF stays the default; `hybrid-recall.ts` stays as the unwired live reference. Revisit
  only on a concrete trigger (per-query DeepLake billing, a measured recall-latency problem, or a
  graded-eval (047f) sweep where native hybrid BEATS RRF). See
  [047a's decision report](reports/2026-06-22-hybrid-benchmark-decision.md) and
  [ADR-0001](../../../knowledge/private/architecture/adr/0001-retrieval-fusion-rrf-vs-native-hybrid.md).
- **D-2 — The reranker is a real stage, not a stub (047b).** `recall.ts` consumes the configured
  reranker on the top-k, preserving the timeout keep-order fallback already specified.
- **D-3 — Dedup is semantic, not just `source+id` (047c).** Near-duplicate hits collapse by
  embedding similarity, keeping the highest-provenance copy.
- **D-4 — Recency is a multiplicative dampener, never a cutoff (047d).** Old facts are demoted,
  never dropped.
- **D-5 — Assembly is token-budgeted + diversity-aware (047e).** MMR over a token budget replaces
  the bare top-k at the injection boundary.
- **D-6 — Everything is eval-gated (047f).** Graded relevance + nDCG land FIRST so every later
  wave's ordering change is measurable, not a vibe. No wave merges that regresses the committed
  baseline.
- **D-7 — The silent lexical fallback is PRESERVED.** Degraded recall beats a 500 for an agent
  turn; `degraded: true` stays the honest signal. No wave may turn a fallback into a throw.

## Acceptance criteria
- **AC-1 — Native-hybrid A/B is run + recorded (047a).** `npm run bench:hybrid` runs both recall
  paths on the golden set against live DeepLake + the embed daemon and emits a `[045 receipt]`
  metrics line per path + the delta. The adoption decision (adopt / keep RRF) is recorded in
  047a's report with the measured numbers. The benchmark asserts BOTH paths ran, never a winner.
- **AC-2 — Reranker is consumed (047b).** A recall with `reranker: "embedding-cosine"` reorders
  the top-k by the rerank score; a rerank timeout keeps the prior order (the configured
  fallback). Measured: rerank does not regress recall@5 / MRR on the golden set (and ideally
  lifts MRR). Unit-tested + eval-checked.
- **AC-3 — Semantic dedup collapses near-duplicates (047c).** Given a fact present as a memory +
  a summary + N raw session turns, recall returns ONE hit (highest provenance), and the eval's
  relevance-class stability workaround is no longer load-bearing. Unit-tested on a near-dup
  fixture; measured neutral-or-better on the golden set.
- **AC-4 — Recency demotes stale rows (047d).** Two equally-relevant hits of different age order
  newest-first under the dampener; no row is dropped by age. Unit-tested; eval-gated.
- **AC-5 — Assembly is budget + diversity aware (047e).** Recall fills a token budget with an MMR
  selection; a result set of near-paraphrases is diversified vs the fixed-top-k baseline.
  Unit-tested; measured on the golden set.
- **AC-6 — Eval upgraded to graded + nDCG (047f).** The golden set carries graded relevance and
  the harness reports nDCG@10 as a gating-eligible metric, so rank-order improvements (047b/d/e)
  are visible. Baseline re-committed against the stabilized, graded eval.
- **AC-7 — Gates green + fallback intact.** `npm run ci` / `build` / `audit:sql` / `audit:openclaw`
  stay green; the per-arm fail-soft + silent lexical fallback (`degraded`) are preserved across
  every wave; no secret/PII in any new fixture or output (grep-proven).

## Risks / Out of scope
- **Risk — native hybrid is a black box.** Adopting `deeplake_hybrid_record` (047a) trades the
  transparent, per-arm-testable RRF for an engine-internal scorer. Mitigated by D-1: adopt only on
  measured parity-or-better, and keep the RRF path in tree as the reference/fallback.
- **Risk — over-tuning to the golden set.** Every knob here (rerank, dedup threshold, recency
  half-life, MMR λ) can be gamed to ~36 pairs. Mitigated by growing the set from real dogfood
  misses (PRD-027 D-5) and keeping the lexical-miss pairs load-bearing.
- **Risk — eventual-consistency flakiness.** Every live measurement polls to convergence (the
  two-phase barrier 047a reuses), never a single read (project memory).
- **Out of scope — turning embeddings on / the embed runtime.** PRD-025 owns that; this PRD ranks,
  shapes, and measures its output.
- **Out of scope — the summarization layer (PRD-017).** Embedding distilled summaries instead of
  raw `sessions.message` noise is the single biggest recall lift available, but it is owned by
  PRD-017 (wiki-summaries), currently a Wave-2 stub. This PRD COORDINATES with 017 (047c's
  provenance ordering assumes summaries exist) but does not re-spec it — see Dependencies.
- **Out of scope — query rewriting / expansion / HyDE.** A measure-gated Tier-3 experiment: it
  helps terse queries and hurts well-formed ones, so it must be A/B'd on the (graded) eval before
  any commit. Deferred to a fast-follow once 047f lands the instrument; NOT built on faith here.

## Dependencies
- **PRD-027 (the instrument).** The golden set, the metrics, `runEval`, and the committed baseline
  are the gate every wave passes through. 047f extends 027's metrics with graded relevance + nDCG.
- **PRD-025 (the semantic arm).** All of this ranks/shapes the `<#>` output 025 turns on.
- **PRD-017 (wiki-summaries, coupled).** 047c's provenance ordering (memory > summary > session)
  and the recall quality ceiling both improve materially once 017 lands real distilled summaries
  to embed instead of raw turns. Sequence: 017 lands summaries → 047c/e benefit; 045 does not
  block on 017 but flags it as the highest-leverage adjacent work.
- **The recall engine + config** — `src/daemon/runtime/memories/recall.ts` (RRF fusion, `fuseHits`,
  the hit shape), `src/daemon/runtime/memories/hybrid-recall.ts` (047a candidate, built),
  `src/daemon/runtime/recall/config.ts` (the scaffolded reranker + recency knobs 047b/d consume),
  `src/daemon/storage/vector.ts` (the `<#>` cosine + `deeplake_hybrid_record` operator).
- **DeepLake eventual consistency.** Every live eval/benchmark polls to embedding convergence,
  never a single immediate read (project memory).

## Sub-PRD index
- [047a — Native-hybrid benchmark + adoption gate](prd-047a-native-hybrid-benchmark.md) (W0, **CLOSED: keep RRF** — operator was degenerate-zero on 2026-06-22; FIXED by 2026-06-24 but only ties RRF, so decision stands. See [report](reports/2026-06-22-hybrid-benchmark-decision.md) · [ADR-0001](../../../knowledge/private/architecture/adr/0001-retrieval-fusion-rrf-vs-native-hybrid.md))
- [047f — Graded relevance + nDCG eval upgrade](prd-047f-graded-relevance-ndcg-eval.md) (W0)
- [047b — Reranker activation](prd-047b-reranker-activation.md) (W1)
- [047c — Semantic / near-duplicate dedup](prd-047c-semantic-dedup.md) (W1)
- [047d — Recency dampening](prd-047d-recency-dampening.md) (W1)
- [047e — Token-budget + MMR context assembly](prd-047e-context-assembly-token-budget-mmr.md) (W2)
