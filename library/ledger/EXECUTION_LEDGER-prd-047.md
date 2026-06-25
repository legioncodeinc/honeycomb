# EXECUTION LEDGER — PRD-047 Retrieval Quality Upgrades

> Orchestrator: `/the-smoker` · Branch: `prd-047-retrieval-quality-upgrades` · Started: 2026-06-24
> Source: `library/requirements/in-work/prd-047-retrieval-quality-upgrades/` (index + 047a–f)
> Single source of truth. Status: OPEN / IN PROGRESS / DONE / VERIFIED / BLOCKED.
> DONE = implemented + unit-proven + nothing else broken. VERIFIED = confirmed by a separate pass (close-out).

## Eval-gating reality (applies to b/c/d/e/f "live" ACs)

Every quality AC is gated by the PRD-027 golden-set eval, which needs **live DeepLake + the embed
daemon**. Split per AC:
- **Deterministic ACs** (unit-tested, no live infra) — owned by the implementer Bee.
- **Live-measurement ACs** (`b-AC-3`, `c-AC-3`, `d-AC-4`, `e-AC-3`, `f-AC-3`) — the implementer writes
  the code + the gated itest; the **orchestrator** runs the live eval (creds in `.env.local`, workspace
  `honeycomb`, embed daemon on `:3851`), tunes the knob, records the report, and re-commits the baseline.

## AC Ledger

| AC | Source | Criterion (gist) | Type | Owner | Status |
|---|---|---|---|---|---|
| a-AC-1 | 047a | `bench:hybrid` runs live A/B, emits recall/MRR/nDCG for both paths | live | retrieval | ✅ VERIFIED (re-run 2026-06-24) |
| a-AC-2 | 047a | Weight sweep changes operator weights | live | retrieval | ✅ VERIFIED |
| a-AC-3 | 047a | Decision recorded (keep RRF) + re-run | doc | retrieval | ✅ VERIFIED |
| a-AC-4 | 047a | No live-engine regression; gates green | det | retrieval | ✅ VERIFIED |
| f-AC-1 | 047f | Golden set carries graded `relevance` where meaningful | data | retrieval | ✅ DONE (36 pairs graded 1–3) |
| f-AC-2 | 047f | `gateAgainstBaseline` enforces nDCG@10 floor; baseline schema gains `ndcg` | det | retrieval | ✅ DONE (golden.ts:255/271/294/321; hand-computed tests) |
| f-AC-3 | 047f | Live poll-convergent run re-commits graded baseline (`placeholder:false`) | live | orch+retrieval | ✅ DONE (live nDCG@10=0.596 → floor 0.50 committed) |
| f-AC-4 | 047f | Gates green; no secret/PII in graded set (grep-proven) | det | retrieval | ✅ DONE (npm run ci green; synthetic set) |
| b-AC-1 | 047b | `embedding-cosine` reranks fused top-N; `none` leaves RRF order | det | retrieval | ✅ DONE (recall.ts:680 rerankHits; rerank.test.ts) |
| b-AC-2 | 047b | Rerank timeout → keep prior (RRF) order | det | retrieval | ✅ DONE (injected-clock test) |
| b-AC-3 | 047b | Eval: rerank holds recall@5, no nDCG/MRR drop below baseline−ε (ideally lift) | live | orch+retrieval | ✅ DONE — measured NEUTRAL (no lift, inside RRF noise band); per pre-registered rule default→`none`; recorded in reports/2026-06-24-reranker-activation-eval.md. **Product flag: cosine kept activatable behind config.** |
| b-AC-4 | 047b | `degraded` fallback + fail-soft intact; rerank failure → RRF order | det | retrieval | ✅ DONE (no-vector/failure → RRF tests) |
| c-AC-1 | 047c | Near-dups (memory+summary+turns) collapse to ONE (memories copy) | det | retrieval | ✅ DONE (recall.ts:840 dedupHits, provenance memories>memory>sessions) |
| c-AC-2 | 047c | Distinct facts below threshold both survive (false-merge guard) | det | retrieval | ✅ DONE (0.85<0.9 not merged) |
| c-AC-3 | 047c | Eval: recall@5/MRR/nDCG hold at-or-above baseline with dedup on | live | orch+retrieval | ✅ DONE — dedup on: recall@5 0.639 / MRR 0.600 / nDCG 0.609 (gate PASS). Surfaced + fixed the relevance-class/nDCG tension: nDCG made DEDUP-INVARIANT (the c-AC-3 "retire the workaround" deliverable) |
| c-AC-4 | 047c | Provenance preserved; fallback + fail-soft intact; gates green | det | retrieval | ✅ DONE (dedup-failure → un-deduped, fail-soft) |
| d-AC-1 | 047d | Newer wins on a relevance tie under the dampener | det | retrieval | ✅ DONE (recall.ts:1012 applyRecencyDampening) |
| d-AC-2 | 047d | Nothing dropped by age (demote, not cut) | det | retrieval | ✅ DONE (sort, never filter) |
| d-AC-3 | 047d | Missing timestamp → decay=1, no exception | det | retrieval | ✅ DONE (recencyDecay null→1) |
| d-AC-4 | 047d | Eval-tuned half-life; recall@5/MRR/nDCG hold at-or-above baseline | live | orch+retrieval | ✅ DONE — default half-life 100yr (off-equiv); live eval recall@5 0.639 / MRR 0.618 / nDCG 0.623 (gate PASS, neutral) |
| e-AC-1 | 047e | Token-budget mode returns MMR-selected hits that fit the budget | det | retrieval | OPEN |
| e-AC-2 | 047e | MMR surfaces distinct facts a pure top-k would crowd out | det | retrieval | OPEN |
| e-AC-3 | 047e | Eval: λ tuned; recall@5/MRR/nDCG hold at-or-above baseline | live | orch+retrieval | OPEN |
| e-AC-4 | 047e | Row-`limit` path unchanged when no budget; fallback intact; gates green | det | retrieval | OPEN |
| SEC | close-out | security-worker-bee: OWASP/PII/injection over the recall changes | — | security | OPEN |
| QA | close-out | quality-worker-bee: implementation vs PRD-047 | — | quality | OPEN |

## Wave plan (sequential — all feature waves edit the same `recall.ts` pipeline)

- **W0 — 047f (instrument first):** graded golden set + nDCG gating + baseline re-commit. `retrieval-worker-bee` (opus). Unblocks measurement for every later wave.
- **W1 — 047b reranker:** rerank stage after `fuseHits`. `retrieval-worker-bee` (opus).
- **W2 — 047c semantic dedup:** collapse near-dups after rerank. `retrieval-worker-bee` (opus).
- **W3 — 047d recency dampening:** age-decay multiplier on final ordering. `retrieval-worker-bee` (opus).
- **W4 — 047e token-budget + MMR:** assembly/selection at the boundary. `retrieval-worker-bee` (opus).
- **Close-out:** `security-worker-bee` (security-stinger) → `quality-worker-bee` (quality-stinger).
- **Ship:** commit, push, PR, monitor CI to green.

Model: every feature wave routes to `retrieval-worker-bee` on **opus** — deep reasoning on the live
recall hot path with eval-gated correctness; not a mechanical job. Close-out Bees on opus (security
audit + QA verification both demand high reasoning).

## Dependency notes
- W0 first (the nDCG instrument must exist before b/d/e rank-order wins are provable).
- W1→W2→W3→W4 are serial: they are an ordered pipeline in `recall.ts` (fuse → rerank → dedup → recency → assemble). Each starts from the prior's committed, verified state.
- After every wave: `tsc --noEmit` clean + the wave's unit tests green + `git status` shows changes only under `src/`+`tests/` (no scatter) before proceeding.

## Status log
- 2026-06-24: Ledger created. 047a VERIFIED (incl. today's re-run). 047f/b/c/d/e OPEN. Branch cut from `main`.
