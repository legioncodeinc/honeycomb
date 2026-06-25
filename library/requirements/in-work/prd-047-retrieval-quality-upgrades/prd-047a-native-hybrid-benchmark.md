# PRD-047a — Native `deeplake_hybrid_record` vs RRF: benchmark + adoption gate

> Status: CLOSED — decision UNCHANGED (keep RRF); operator since FIXED, re-eval deferred · Parent: PRD-047 · Wave: W0 · Type: S
> Goal: settle PRD-027 D-1's deferred question with NUMBERS — does DeepLake's native hybrid
> operator tie-or-beat the post-query RRF the engine ships, on the committed golden set? Adopt
> native hybrid iff it does; otherwise keep RRF and record why.
>
> **OUTCOME (2026-06-22, live run): KEEP RRF.** Native `deeplake_hybrid_record` returned a
> DEGENERATE constant-zero score (random ordering): recall@5 0.14–0.17 vs RRF's 0.72–0.78,
> weight-insensitive. The operator EXECUTES (`kind=ok`) but does not RANK as wired. Full numbers +
> root cause in [reports/2026-06-22-hybrid-benchmark-decision.md](reports/2026-06-22-hybrid-benchmark-decision.md).
> The slice (`hybrid-recall.ts` + benchmark + `npm run bench:hybrid`) stays in tree as the unwired
> reference; no production recall path changed.
>
> **RE-RUN (2026-06-24): the operator is FIXED — now at PARITY with RRF, but decision still KEEP RRF.**
> DeepLake has since fixed `deeplake_hybrid_record`: it no longer returns a degenerate zero score and
> is now weight-SENSITIVE (genuinely ranking). On the same harness (`npm run bench:hybrid`, live,
> workspace `honeycomb`): RRF recall@5 0.611 / MRR 0.593 vs native-hybrid (0.5/0.5) recall@5 0.611 /
> MRR 0.589 — a TIE on recall@1/@5, marginally behind on recall@10/MRR/nDCG. It ties but does not
> BEAT RRF, so the adoption gate (tie-or-beat recall@5 AND MRR) is not cleared. A separate
> cost/benefit review found adoption buys **no package savings** (RRF is hand-rolled, no dep; both
> paths need the embed daemon + DeepLake), **no clear cost saving**, and only ~5→~3 DeepLake
> round-trips per recall (possible latency win, unmeasured) — against re-coupling ranking to an
> opaque operator that just spent months broken. **Decision: keep RRF; keep `hybrid-recall.ts` as the
> live reference candidate; revisit with the graded eval (047f).** Full re-run numbers + triggers in
> [reports/2026-06-22-hybrid-benchmark-decision.md](reports/2026-06-22-hybrid-benchmark-decision.md)
> and [ADR-0001](../../../knowledge/private/architecture/adr/0001-retrieval-fusion-rrf-vs-native-hybrid.md).

## Why
PRD-027 D-1 shipped post-query RRF and named the DB's native `deeplake_hybrid_record` operator a
"fast-follow once the eval harness can A/B it." The harness exists. Honeycomb is already wired into
DeepLake, so calling the native operator is not a new dependency — it is a function call in the same
SQL API the `<#>` vector path already uses. We are currently hand-fusing in TypeScript a hybrid the
engine offers natively; this slice measures whether that hand-fusion is worth keeping.

## What (built in this slice)
- `src/daemon/runtime/memories/hybrid-recall.ts` — `hybridRecall`, a second recall implementation
  with the SAME `MemoryRecallRequest` / `MemoryRecallDeps` / `MemoryRecallResult` contract as
  `recallMemories`, using `(<emb>, <text>)::deeplake_hybrid_record <#> deeplake_hybrid_record(vec,
  text, vecWeight, textWeight)` over the `memories` + `sessions` tables (the tables with an
  embedding column), with the SAME arm-class weighting (distilled > raw) folded in for a fair A/B.
  Guard-safe (`sqlIdent` / `sLiteral` / `serializeFloat4Array`); `audit:sql` clean. UNWIRED — not
  mounted on any route; the live engine is untouched.
- `tests/daemon/runtime/memories/hybrid-recall.test.ts` — 10 unit tests: operator SHAPE, weight
  literals, query-text escaping (injection), score-max cross-arm merge + dedup + arm-class weight,
  the cannot-run degrade (no embed / null / wrong-dim / empty query), env weight resolution.
- `tests/integration/hybrid-benchmark-live.itest.ts` — the gated live A/B: seeds the golden set,
  polls the two-phase convergence barrier (column + `<#>` vector segment), scores BOTH
  `recallMemories` (RRF) and `hybridRecall` (native) on the same warm store, emits a `[045 receipt]`
  line per path + the delta. Asserts both RAN; never asserts a winner.
- `scripts/bench-hybrid.mjs` + `npm run bench:hybrid` — operator entry mirroring `eval:recall`'s
  gating (token + embed-daemon SKIP-with-a-reason, exit 0 when unavailable). Weights are sweepable
  via `HONEYCOMB_HYBRID_VECTOR_WEIGHT` / `HONEYCOMB_HYBRID_TEXT_WEIGHT` (ratio-only).

## Acceptance criteria
- **a-AC-1 — The A/B runs live.** With a DeepLake token + the embed daemon up,
  `npm run bench:hybrid` seeds the golden set, converges, and emits recall@1/5/10 + MRR + nDCG for
  RRF AND native hybrid + the delta. Without creds it SKIPS cleanly (exit 0).
- **a-AC-2 — Weight sweep works.** Running with `HONEYCOMB_HYBRID_VECTOR_WEIGHT` /
  `_TEXT_WEIGHT` set changes the operator weights (verified in the emitted receipt line).
- **a-AC-3 — Decision recorded.** The measured numbers + the adopt / keep-RRF decision are written
  to `reports/<date>-hybrid-benchmark.md`. Adoption (if chosen) is a follow-up that wires
  `hybridRecall` into the engine behind a flag; rejection keeps RRF and records the deficit.
- **a-AC-4 — No live-engine regression.** The slice mounts nothing and changes no route; `npm run
  ci` / `audit:sql` / `dup` stay green (verified: typecheck ✓, audit:sql ✓, 10 unit tests ✓, dup ✓).

## Status / what's left
- DONE: the slice (module + unit tests + gated benchmark + script + `bench:hybrid` wiring), all
  offline gates green.
- PENDING (needs live creds + embed daemon): run `npm run bench:hybrid`, capture the receipts,
  write the decision report (a-AC-3). The benchmark cannot produce numbers on a credential-less
  machine — this is the SAME gating posture as `npm run eval:recall`.

## Risks / Out of scope
- **Risk — operator semantics.** `deeplake_hybrid_record`'s exact scoring/normalization is the
  engine's; the benchmark treats it as a black box and compares OUTCOMES (recall@k/MRR), which is
  the only honest comparison. Score-scale differences between the two paths are irrelevant — only
  the ranked ids feed the metrics.
- **Out of scope — wiring native hybrid into production.** That is the adopt-path follow-up gated
  on a-AC-3's decision, not this slice.
