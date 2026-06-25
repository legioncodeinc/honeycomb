# ADR-0001, Retrieval fusion: keep post-query RRF over DeepLake's native `deeplake_hybrid_record`

> **Status:** Accepted (keep RRF) · **Date:** 2026-06-24
> **Supersedes:** none · **Superseded by:** none
> **Owners:** retrieval · **Related:** PRD-027 (D-1/D-2), PRD-047a, PRD-045b

## Context

Honeycomb's recall path needs to fuse a semantic (`<#>` cosine, embedding) signal with a lexical
(BM25 / ILIKE) signal into one ranked result. Two fusion strategies were on the table:

- **Post-query RRF (shipped).** `src/daemon/runtime/memories/recall.ts` issues **separate per-arm
  queries** (a `<#>` vector arm + a lexical arm, over `memories` and `sessions`) and fuses their
  ranked lists in TypeScript with reciprocal-rank fusion (`fuseHits`, `RRF_K=60`, arm-class
  weights). The per-arm design is deliberate (`recall.ts:24-47`): a single `UNION ALL` fails as a
  whole on a fresh/missing partition, and per-arm execution gives graceful degradation, if the
  embed daemon is down, recall runs lexical-only and sets `degraded: true` (an honest signal).
- **Native `deeplake_hybrid_record` (candidate, unwired).** DeepLake fuses vector + BM25 in **one
  statement per table** with tunable weights. Reference implementation: `hybrid-recall.ts` (built,
  not mounted). PRD-027 D-1 named this an evidence-gated fast-follow.

PRD-027 D-1 required adopting native hybrid **only if it ties-or-beats RRF** on the committed golden
set (recall@5 AND MRR). PRD-047a built the A/B harness (`npm run bench:hybrid`). PRD-045b separately
de-scoped the old five-phase `RecallEngine`, leaving RRF as the sole live fusion path.

Two live A/B runs were performed:

| Run | Native `deeplake_hybrid_record` | RRF | Finding |
|---|---|---|---|
| **2026-06-22** | recall@5 0.14-0.17, MRR 0.08, **weight-insensitive** | recall@5 0.72-0.78 | Operator returned a **degenerate constant-zero score** → random ordering. Broken. |
| **2026-06-24** | recall@5 0.611, MRR 0.589, **weight-sensitive** | recall@5 0.611, MRR 0.593 | DeepLake **fixed** the operator; it now ranks for real and is at **parity** with RRF (ties recall@1/@5, marginally behind on recall@10/MRR/nDCG). |

(2026-06-24 run: live, workspace `honeycomb`, embed daemon `nomic-embed-text-v1.5`, two-phase
convergence. The 0.7/0.3 weight sweep moved the numbers, confirming the operator genuinely ranks
now.)

## Decision drivers

- **Quality gate:** tie-or-beat RRF on recall@5 AND MRR (PRD-027 D-1).
- **Dependency / install footprint.**
- **Operating cost** (embedding, LLM, DeepLake query volume).
- **Latency** (round-trips, client-side vs server-side fusion).
- **Robustness & debuggability** (graceful degradation, per-arm testability, black-box risk).
- **Maintenance surface** (TS rank-bookkeeping vs an opaque engine operator).

## Considered options

### Option A, Keep post-query RRF (CHOSEN)
### Option B, Adopt native `deeplake_hybrid_record`

Cost/benefit of switching to Option B, as measured/verified 2026-06-24:

- **Packages saved: ZERO.** RRF is hand-rolled TypeScript with no npm dependency (`recall.ts`
  imports only internal storage/vector/embed modules). Both options still require the embed daemon
  (`@huggingface/transformers` + the ~600 MB nomic model, native hybrid also needs a query vector)
  and DeepLake. Nothing is uninstalled.
- **Cost reduction: none verified.** The query is embedded once locally on either path (no per-token
  API cost); recall invokes no LLM. The only lever is DeepLake query volume, recall fires ~5
  per-arm round-trips today; native hybrid fuses server-side, ~5 → ~3. Whether fewer statements
  reduces dollars depends on DeepLake's (unverified) billing model.
- **Upside (modest):** possibly lower recall latency (fewer round-trips + server-side fusion,
  unmeasured) and deletion of the RRF rank-fusion code (partial, cross-arm weighting and the
  `degraded` fallback remain).
- **Downside:** re-couples ranking to an opaque operator that just spent months silently broken
  (only the eval caught it); the per-arm `degraded:true` fallback and fresh-table tolerance must be
  re-proven; quality is only parity, not a gain.

## Decision

**Keep post-query RRF as the default recall fusion (Option A).** Do **not** wire
`deeplake_hybrid_record` into the production recall path at this time. Retain `hybrid-recall.ts`,
`tests/integration/hybrid-benchmark-live.itest.ts`, and `npm run bench:hybrid` as the **unwired live
reference candidate** so the A/B is repeatable on demand.

Rationale: native hybrid now **works** but only **ties** RRF (fails the tie-or-beat-on-MRR gate), and
switching delivers no package savings, no verified cost reduction, and only a possible (unmeasured)
latency gain, not enough to justify re-coupling ranking to a black-box operator with a weaker
robustness story. Parity is "good to know," not "adopt."

## Consequences

**Positive**
- Recall ranking stays transparent, per-arm testable, and gracefully degrading (`degraded:true`).
- No migration risk; no dependence on opaque engine scoring semantics.
- The A/B remains a one-command rerun, so revisiting is cheap.

**Negative / accepted**
- Honeycomb continues to hand-fuse in TypeScript a capability the engine now offers natively (the
  ~5→~3 round-trip and code-deletion upside is forgone).
- `hybrid-recall.ts` remains carried-but-unused code (kept intentionally as the reference).

## Revisit triggers

Re-open this decision (continue evaluations later) if ANY of these holds:
1. DeepLake billing is confirmed **per-query / per-compute** AND recall query volume is a real cost.
2. Recall **latency** becomes a measured problem (the round-trip reduction would then matter).
3. A **graded-relevance + nDCG sweep** (PRD-047f, now wired), ideally multi-run, in the cleaner
   `default` workspace, across a fuller weight grid, shows native hybrid **beating** RRF, not tying.

## Links

- PRD-047a: `library/requirements/completed/prd-047-retrieval-quality-upgrades/prd-047a-native-hybrid-benchmark.md`
- Benchmark decision report (both runs): `library/requirements/completed/prd-047-retrieval-quality-upgrades/reports/2026-06-22-hybrid-benchmark-decision.md`
- Live recall (RRF): `src/daemon/runtime/memories/recall.ts`
- Reference candidate: `src/daemon/runtime/memories/hybrid-recall.ts`
- Operator probe report: `library/knowledge/private/ai/deeplake-hybrid-record-operator-report.md`
