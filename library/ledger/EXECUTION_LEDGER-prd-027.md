# EXECUTION LEDGER — PRD-027 Recall ranking + result shaping + recall-eval harness (M)

> Orchestrator: `/the-smoker` · Branch: `prd-027-recall-ranking-and-eval` · Status: **IN-WORK**
> Goal: recall returns RANKED, SHAPED results backed by a REAL relevance score ([memory] facts above raw
> [sessions] dumps), and a recall-eval harness MEASURES recall quality on a golden set so PRD-025's
> semantic-on lift is PROVEN + regression-gated.

## Builds on (now merged: PRD-025 semantic arm is live)
- `src/daemon/runtime/memories/recall.ts` — per-arm guarded queries; semantic `<#>` arm (`runSemanticArms`) + lexical arms merged semantic-first in `shapeHits`, deduped by `source+id`; hit shape `{source,id,text}` (NO score yet); `degraded` honest.
- `src/daemon/storage/vector.ts` — `vectorSearch` → normalized cosine `((1 + (emb <#> vec))/2)` 0..1.
- `src/daemon/runtime/memories/api.ts` — `/api/memories/recall`. Client renderers fabricate `1 - i*0.06`.

## AC matrix (7) — OPEN → DONE → VERIFIED
| AC | Criterion (abbrev) | Wave | Owner | Status |
|----|--------------------|------|-------|--------|
| AC-1 | Real `score` per hit, ordered by fused RRF relevance (not arm order / not client-fake); unit-tested vs the RRF math | 1 | retrieval | **DONE** |
| AC-2 | Provenance shaping: distilled `[memory]` ranks ABOVE raw `[sessions]` dumps; raw rows tagged drill-down/secondary; unit-tested mixed-arm | 1 | retrieval | **DONE** |
| AC-3 | Near-dup hits across arms deduped to one; every hit carries `source`+scope provenance; unit-tested | 1 | retrieval | **DONE** |
| AC-4 | Client stops faking scores — dashboard/CLI render engine `score` + engine order; `1 - i*0.06` gone (grep-proven); order == engine order | 2 | ts-node | **DONE** |
| AC-5 | Eval harness exists: committed golden set (~30–50, lexical-miss-inclusive) → recall@k(1,5,10)+MRR(+nDCG) via `npm run eval:recall` AND a gated live itest (real daemon+embed, poll-convergent); per-query hit/miss report | 2 | retrieval | **DONE (W2b)** — harness + golden set (36, 16 lexical-miss) + `npm run eval:recall` + gated itest; 36 metric/gate unit tests green in `npm run ci` |
| AC-6 | **Behavioral bar:** eval shows semantic-ON + new ranking beats BM25/ILIKE-only on recall@5/MRR (generalized 025 AC-4); committed baseline enforced — drop below `baseline−ε` FAILS | 3 | retrieval + orch | **DONE/VERIFIED (W3)** — eval STABILIZED (was a 2× swing), measured live, baseline committed ENFORCED (recall@5=0.55, MRR=0.55, `placeholder:false`, ε=0.05). 5 live runs: recall@5 0.583–0.611, MRR 0.577–0.591; semantic beats lexical 5/5 (recall@5 Δ≈0.58–0.61); gate `passed=true advisory=false` 5/5. See Wave-3 section below |
| AC-7 | Gates green; ranking/shaping preserve per-arm fail-soft (missing sibling table → empty arm, not 500); no secret in eval output/fixtures (grep) | 3 | security + orch | **fail-soft DONE (W1)**; gates+grep at W3 |

## Wave plan
- **Wave 1 — RRF ranking + provenance shaping (retrieval-worker-bee).** Add a real `score` to `MemoryRecallHit`; fuse the per-arm ranked lexical + semantic lists via **RRF** post-query in `recall.ts` (D-1/D-2 — preserve the per-arm guarded-query fail-soft); provenance-forward shaping — `[memory]` arm-class weight folded into the fused rank so distilled facts outrank raw `[sessions]` dumps, near-dups deduped, raw session rows tagged drill-down/secondary (D-3); order by fused score, never arm order. Unit tests: AC-1 (RRF order vs the math), AC-2 (facts-above-dumps mixed fixture), AC-3 (dedup+provenance), AC-7 (a missing sibling arm still degrades to empty). Thread `score`+shaping through `api.ts`.
- **Wave 2 — client de-fake + eval harness (parallel, after W1):**
  - **2a client (typescript-node-worker-bee):** dashboard recall bar + `honeycomb recall` CLI render the engine `score` + engine order; DELETE the `1 - i*0.06` fabrication (D-4/AC-4); the wire client passes the engine score through (the `wire.ts` scope-derivation can stay, but score is the engine's). DOM/unit tests: rendered order == engine order, no fabricated score (grep).
  - **2b eval harness (retrieval-worker-bee):** a committed golden set (~30–50 `(query→expected)` pairs, lexical-miss-inclusive — `eval/recall-golden.*`); a metrics module (recall@k k=1,5,10 + MRR + nDCG); `npm run eval:recall` (seeded-store, fast local) + a GATED live itest (real assembled daemon + real embed daemon, poll-convergent) emitting the metrics + per-query hit/miss; a committed `recall@5`/`MRR` baseline + the `baseline−ε` gate (AC-5; AC-6 authored).
- **Wave 3 — live verification + close-out (orchestrator → security → quality).** Start the embed daemon (model runs on this host, PRD-025), run `npm run eval:recall` + the gated live eval itest against live DeepLake; PROVE semantic-ON + new ranking beats BM25/ILIKE-only on recall@5/MRR + the baseline gate holds (AC-6). security-worker-bee (no secret in eval output/fixtures, AC-7) → quality-worker-bee.

## Wave 1 — LANDED (RRF ranking + provenance shaping), retrieval-worker-bee

**Files touched (no new files):** `src/daemon/runtime/memories/recall.ts` (RRF fusion + shaping + dedup +
extended hit shape), `src/daemon/runtime/memories/api.ts` (forwards `score`/`kind`/`secondary` verbatim),
`tests/daemon/runtime/memories/recall.test.ts` (AC-1/2/3/7 suite + updated cap-test for RRF order).

**Extended hit shape (`MemoryRecallHit`, AC-1):** now `{ source, id, text, score, kind, secondary }`.
- `score: number` — the fused RRF relevance (ordered DESC). Real + comparable, not arm order, not the
  client `1 - i*0.06`. Available for Wave 2 (client de-fake + eval harness).
- `kind: "memory" | "session"` — provenance class. `memories`+`memory` arms → `memory` (distilled);
  `sessions` arm → `session` (raw dump). Derived by exported `kindOfSource(source)`.
- `secondary: boolean` — `true` iff `kind === "session"` (drill-down; the raw dump is demoted, never dropped).

**RRF math + constants (D-1/D-2/D-3, all named + exported + documented in `recall.ts`):**
- `RRF_K = 60` (the fusion constant). `score(doc) = Σ_arms ARM_CLASS_WEIGHT[kind] / (RRF_K + rank_arm)`,
  `rank` 1-based. Each arm is a RANKED list: the semantic `<#>` arms by cosine DESC (one ranked arm PER
  table), the three lexical arms by their storage/ILIKE order. Computed POST-QUERY in TS over the per-arm
  lists (no ranking pushed into SQL — preserves the per-arm guarded-query fail-soft).
- `ARM_CLASS_WEIGHT = { memory: 1.0, session: 0.4 }` (the D-3 provenance weight). With `k=60`: a rank-1
  distilled hit = `1.0/61 = 0.016393`; a rank-1 raw session = `0.4/61 = 0.006557`. So a raw session needs a
  materially stronger rank signal (or cross-arm corroboration) to outrank a distilled fact — and a distilled
  fact as deep as rank 3 (`1.0/63 = 0.015873`) still beats a raw session at rank 1. The governing inequality
  `rrf("memory",3) > rrf("session",1)` is asserted in the AC-2 test.
- **Ordering:** fused score DESC, tie-break distilled-before-raw, then id (deterministic). Capped at the
  clamped overall limit.

**Dedup (AC-3):** cross-arm fusion keys every doc by `source+id`. A memory surfaced by BOTH the semantic and
a lexical arm accumulates BOTH contributions (corroboration raises it) and is emitted ONCE — the survivor
keeps the summed (best) fused score + its `source` and provenance class.

**Per-arm fail-soft preserved (AC-7):** the per-arm guarded `runArm`/`runSemanticArm` tolerance is untouched
— a missing sibling table is a non-`ok` result → an EMPTY arm → an empty ranked list that contributes
NOTHING to the fusion. The other arms still rank and carry real scores; recall never 500s; `degraded` stays
honest (false iff the semantic arm actually ran). The semantic arms still merge ahead conceptually but order
is now purely by fused score.

**Unit tests (what each proves):**
- AC-1: a hit corroborated by the semantic arm (r1) AND the lexical arm (r2) fuses to `1/61 + 1/62` and
  ranks ABOVE a lexical-only r1 hit (`1/61`) — proving order is FUSED, not arm-order (arm-order alone would
  invert it). Asserts the emitted `score` equals the hand-computed RRF value to 10 d.p. + DESC order. Plus a
  `kindOfSource` mapping check.
- AC-2: a distilled fact and a raw session dump both at lexical rank-1 → the fact ranks above the dump (weight
  alone), the dump is tagged `kind:"session"`/`secondary:true`, the fact `kind:"memory"`/`secondary:false`.
  Second case: a distilled fact buried at rank-3 STILL outranks a raw session at rank-1.
- AC-3: a memory surfaced by the semantic AND lexical arm collapses to ONE hit keeping the summed (best)
  score + `source`/`kind` provenance.
- AC-7: missing `memory`+`sessions` siblings → the `memories` hit still ranks with a real RRF score, no
  throw, `degraded` honest; and every-arm-failing → empty fused result, no throw.
- Updated the pre-existing cap test: under RRF the top-3 of (5 memories + 1 summary + 1 session) is
  `[mem-0, sum/1, mem-1]` (sources `[memories, memory]`), no raw session, every hit a positive numeric score.

**Gate exit codes (all from repo root):** `npm run ci` → **0** (1844 passed, ran `audit:sql` → **0**);
`npm run build` → **0**; `npm run audit:openclaw` → **0**; `tests/daemon/storage/invariant.test.ts` → **0**.
`git check-ignore` on the 3 touched files → not ignored (correct). No new files; no
`.agents/.codex/.claude/.cursor`/`AGENTS.md` touched; no `git add`/commit/push.

**Wave 2 handoff:** `score` (+ `kind`/`secondary`) is now on the wire from `/api/memories/recall`. 2a de-fakes
the dashboard/CLI off `1 - i*0.06` onto the engine `score`+order; 2b's eval harness measures recall quality
on the golden set using this ranked output.

## Wave 2a — LANDED (client de-fake, typescript-node-worker-bee) — AC-4 DONE

**Files touched (no new files):** `src/dashboard/web/wire.ts` (wire-schema extension + `recall()` de-fake),
`src/dashboard/web/primitives.tsx` (`MemoryCard` renders engine score + demotes `secondary`),
`src/commands/storage-handlers.ts` (`honeycomb recall` CLI renders engine score + engine order),
`tests/dashboard/web/wire.test.ts` (+3 AC-4 wire tests), `tests/dashboard/web/app.test.tsx` (DOM score
repointed off 1.00 → engine 0.42/0.17), `tests/commands/storage-handlers.test.ts` (CLI score + order test).

**Wire-schema extension (`RecallHitSchema`):** now parses the Wave-1 hit verbatim —
`score: z.number().catch(0)`, `kind: z.enum(["memory","session"]).catch("memory")`,
`secondary: z.boolean().catch(false)`. The `.catch()` defaults let an OLDER daemon (pre-score) still render
(degrade gracefully); the LIVE daemon always sends them. `RecalledMemory` grew `kind`/`secondary` so the card
can show distilled-vs-drill-down.

**The de-fake (what was DELETED):** `wire.ts` `recall()` previously synthesized
`score: Math.max(0, 1 - i * 0.06)` per hit (and rank-by-index). That line is GONE; each hit now carries the
ENGINE `score` (`h.score`) and `kind`/`secondary`, mapped in the engine's returned order with NO client-side
re-sort. `scope`/`verified` stay honestly derived from the arm name (unchanged).

**Dashboard (`MemoryCard`):** renders the real engine score (`score.toFixed(2)`, already wired); a raw-session
drill-down (`secondary:true` / `kind:"session"`) is visually demoted — dimmed (`opacity 0.72`) + a `session`
tag — below the distilled facts the engine ranked above it.

**CLI (`renderRecall`):** each hit line is now `[source] id  (score)  <snippet>`, iterated in the engine's
ranked order (distilled `[memory]` before raw `[sessions]` drill-down) with NO re-sort and NO score invention.
`--json` still passes the raw daemon body verbatim; `(lexical fallback)` marker unchanged.

**Grep-proof the fabrication is GONE:** `Math.max(0, 1 -` / `score: Math` / `1 - i * 0.06` / `1 - <idx>*0.06`
→ ZERO executable hits across `src/`. The only residue is three DOC COMMENTS (wire.ts:127, wire.ts:330,
api.ts:159) that NAME the removed `1 - i*0.06` to explain the change — no synthesis remains.

**Rendered order == engine order (proven):** the engine returns hits ranked DESC by fused RRF; both renderers
iterate that list verbatim. CLI test asserts the `[memory]` line index precedes the `[sessions]` line index;
wire test asserts `memories.map(m=>m.memoryKey)` equals the wire order and is NOT re-sorted even when a later
hit carries a higher score; DOM test asserts engine scores 0.42/0.17 render and the old 1.00 does not.

**Tests (what each proves):**
- `wire.test.ts` (AC-4): `recall()` carries `h.score`/`kind`/`secondary`, preserves engine order (no re-sort),
  proves the old `1 - i*0.06` first-value `1` is gone, and degrades gracefully when an older daemon omits the
  fields (`.catch` → 0/"memory"/false).
- `app.test.tsx` (AC-3 updated): the recall payload now carries engine `score`/`kind`/`secondary`; the DOM
  asserts the ENGINE score (0.42 top, 0.17 second) renders and the fabricated 1.00 does NOT.
- `storage-handlers.test.ts` (AC-4): the CLI renders `(0.51)`/`(0.19)` and the distilled `[memory]` line
  precedes the raw `[sessions]` drill-down line (engine order preserved). Existing `--json`, `(lexical
  fallback)`, and `no memories found` assertions kept and pass unchanged.

**Gate exit codes (all from repo root):** `npm run ci` → **0** (1847 passed, 5 skipped; chained `audit:sql`
→ **0**); `npm run build` → **0**; `npm run audit:sql` → **0**; `npm run audit:openclaw` → **0**;
`tests/daemon/storage/invariant.test.ts` → **0** (3 passed). TS strict, zod at the wire boundary, no `any`,
no swallowed errors. No new files; no `.agents/.codex/.claude/.cursor`/`AGENTS.md` touched; no
`git add`/commit/push.

## Wave 2b — LANDED (recall-eval harness: golden set + metrics + `npm run eval:recall` + gated itest), retrieval-worker-bee

**New files (all committable; `git check-ignore` → none ignored):**
- `eval/recall-golden.json` — the committed golden set: **36 pairs, 16 lexical-MISS** (the query shares
  NO surface token with its target — e.g. target *"the build is timing out on the pack step"* ← query
  *"CI keeps failing during publish"*). A unit test tokenizes both sides and ASSERTS the lexical-miss
  pairs genuinely share no significant surface token, so the set really exercises the semantic lift.
  Purely synthetic engineering scenarios — no secret/PII (grep-proven, below). `eval/README.md`
  documents the schema + how to grow it from real dogfood misses (D-5).
- `eval/recall-baseline.json` — the committed `recall@5`/`MRR` baseline the gate reads. **`placeholder:
  true`** → the gate is ADVISORY (reports the comparison, never fails a run) until Wave 3 commits the
  measured numbers + flips `placeholder` to false.
- `src/eval/metrics.ts` — PURE metric functions over `(ranked ids, expected id)`: `recallAtK` (k=1,5,10),
  `reciprocalRank`/`firstRelevantRank` (MRR), `dcgAtK`/`idealDcgAtK`/`ndcgAtK` (nDCG, binary or graded),
  `aggregateMetrics`. No I/O — hand-computed unit-tested. `RECALL_K_VALUES=[1,5,10]`, `NDCG_K=10`.
- `src/eval/golden.ts` — the harness: zod load/validate (`loadGoldenSet`, duplicate-key guard), per-run
  isolation keys (`uniqueKeyFor`/`seedTextFor` stamp the run id), the engine-agnostic `runEval` (injected
  `SeededRecall` → per-query report + aggregate), and the **baseline gate** (`gateAgainstBaseline`,
  `EPSILON=0.05`, advisory-while-placeholder) + the **semantic-vs-lexical comparison**
  (`compareSemanticVsLexical` — no regression + ≥1 improvement = beats).
- `tests/eval/metrics.test.ts` (16 tests) + `tests/eval/golden.test.ts` (17 tests) — **all expectations
  hand-computed** (recall@k / MRR / DCG / IDCG / nDCG to 10 d.p.; the aggregate means; the gate
  pass/fail/advisory branches; the golden-set integrity incl. the lexical-miss token-overlap contract).
  Run in `npm run ci` (no creds).
- `scripts/eval-recall.mjs` + `package.json` `"eval:recall"` — the scriptable entry. Token+embeddings
  +embed-daemon gated: each missing prerequisite prints a clear SKIP-WITH-A-REASON and exits 0 (never a
  silent pass). With all present it spawns the gated live itest and surfaces the `[027 receipt]` metric lines.
- `tests/integration/recall-eval-live.itest.ts` — the gated live itest (mirrors
  `semantic-recall-live.itest.ts`: `skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` + the `embedReady` probe). Boots
  the assembled daemon, seeds the 36 golden memories into a per-run `honeycomb_ci` workspace, **polls
  every seeded `content_embedding` to 768-dim convergence** (never a single read), runs recall per query
  twice (semantic seam + lexical-only), and asserts: AC-5 the metrics + per-query report are emitted and
  recall@10 > 0; AC-6 semantic BEATS lexical on recall@5/MRR, the lexical-miss pairs bridge under semantic
  + miss under lexical, and the baseline gate is evaluated (advisory until Wave 3).

**Design notes:**
- **One metric source.** The unit tests, `npm run eval:recall`, and the live itest all reduce recall to
  a ranked id list and call the SAME `src/eval/metrics.ts`. The harness is engine-agnostic (injected
  `SeededRecall`); the live caller injects the REAL `recallMemories` (with/without the embed seam) so the
  semantic-vs-lexical bar runs the production ranking, not a fork.
- **Isolation.** Seed text carries the run id; the QUERY does not — so a lexical-miss pair stays a genuine
  lexical miss (the run-id token never leaks into the query). Per-run keys → reads only this run's rows.
- **Gate is advisory-then-enforcing.** `placeholder:true` keeps the gate from failing on un-measured
  numbers; the comparison is still computed + logged. Wave 3 flips it to enforce `baseline−ε`.

**Gate exit codes (all from repo root):** `npm run ci` → **0** (1880 passed / 5 skipped — +36 new eval
unit tests over W1's 1844; ran `audit:sql` → **0**); `npm run build` → **0**; `npm run audit:openclaw` →
**0**; `tests/daemon/storage/invariant.test.ts` → **0**. `npm run eval:recall` with no creds / embeddings
off / no embed daemon → all three SKIP cleanly, **exit 0**. **No-secret proof:** a value-pattern grep
(long hex/base64, JWTs, public IPs, emails) over `eval/` + `src/eval/` + the script + the itest → CLEAN
(only loopback `127.0.0.1`; "token"/"secret" matches are documented prose / the `g-secret-scan` golden
pair, never a value). No `.agents/.codex/.claude/.cursor`/`AGENTS.md` touched; no `git add`/commit/push.

**Wave-3 live commands (the orchestrator runs these to set/confirm the baseline):**
```
# start the embed daemon (the nomic model runs on this host, PRD-025), then:
set -a; . ./.env.local; set +a
HONEYCOMB_EMBEDDINGS=true npm run eval:recall
# and the gated live itest directly:
set -a; . ./.env.local; set +a
HONEYCOMB_EMBEDDINGS=true npm run test:integration -- recall-eval-live
```
Then write the measured `recall@5`/`MRR` (semantic-ON run) into `eval/recall-baseline.json` and set
`placeholder:false` so the `baseline−ε` gate ENFORCES (AC-6 → DONE/VERIFIED).

## Wave 3 — LANDED (live verification + eval STABILITY fix + honest baseline), retrieval-worker-bee

Wave-3 live verification found the recall-eval **UNSTABLE run-to-run**: same golden set / model / host,
recall@5 swung **0.278 ↔ 0.556** (a 2× swing) while `beats=true` held both runs. A regression gate is
meaningless on a measurement that flaps that hard, and the first-committed baseline (recall@5=0.55) then
FAILED a second run. Root-caused to TWO compounding instability sources and fixed both at the measurement
layer (NOT by lowering the bar — the "semantic beats lexical" assertion + the metric math are untouched).

**Files touched (no production recall/ranking change):**
- `tests/integration/recall-eval-live.itest.ts` — the two-phase convergence barrier + the relevance-class
  scoring + the single converged snapshot reused across AC-5/AC-6.
- `src/eval/golden.ts` — `ExpectedIds` extended to `string | readonly string[]` (a relevance CLASS);
  `runEval` scores a hit on ANY class member. Back-compat: a single-string value still works (unit tests
  unchanged in behaviour).
- `eval/recall-baseline.json` — the MEASURED, ENFORCED baseline (`placeholder:false`).
- `tests/eval/golden.test.ts` — the two committed-baseline unit tests flipped from "placeholder advisory"
  to "enforced floor" (+1 new test); the advisory branch still covered with an inline placeholder fixture.

**Root cause #1 — the convergence barrier polled the wrong segment.** The barrier confirmed each seeded
`content_embedding` scalar column was 768-dim, then scored. But DeepLake is eventually consistent
SEGMENT-by-segment: live timing (instrumented) showed the scalar column converges **~15 s AHEAD** of the
`<#>` vector segment recall actually queries (`col-converged=36/36` while `<#>` self-recall was only
`25/36`, full at ~26 s). So scoring ran on a HALF-WARM vector index, and each run scored a different partial
subset → the swing. **Fix:** a PHASE-2 barrier that polls the actual `<#>` path — for every seeded text,
embed it and run the SAME `vectorSearch` engine recall uses; the segment is "warm" for that seed when the
self-recall's top hit is at near-perfect cosine (`score ≥ 0.90`; live-measured served tops were 0.956–0.989,
so 0.90 cleanly separates served from unserved). A 90% QUORUM (not all-36) returns the barrier — requiring
all 36 simultaneously made the FIRST run of a batch flake on one slow cluster; the quorum + class scoring
absorbs the residual. Column convergence stays as the necessary phase-1 precondition.

**Root cause #2 — golden-set cross-run contamination in a shared workspace.** The token authorizes ONLY
`honeycomb_ci` (a fresh per-run workspace returns 403 — verified), and the table is append-only, so every
prior run left near-duplicate copies of each golden memory (measured: **499 rows, ~12 clones of one seed**).
A query's `<#>` arm then competes the this-run seed against ~12 near-identical clones; which clone ranks
first shuffles run-to-run, and only the this-run id counted → recall@5 flapped even on a fully-warm index
(0.139 ↔ 0.333 in a controlled repro). **Fix:** the eval scores against the relevance CLASS — after
convergence it resolves, per golden pair, EVERY `memories.id` whose content matches that pair's `memoryText`
(this run's seed + all equally-correct prior copies) and counts a hit on ANY of them. That is the honest
meaning of recall@k ("did a correct memory surface"), and the target CLUSTER reliably surfaces even though
individual copy ranks shuffle. This is the documented "curate so the measurement is stable" path — the
variance was a measurement artifact (clone competition), not genuine borderline-query variance.

Also: AC-5 now scores the semantic + lexical arms ONCE post-convergence and stashes the snapshots; AC-6
REUSES them (no second, divergent re-run) — removing the within-run re-measurement divergence.

**≥3-run stability evidence (embed daemon up, `HONEYCOMB_EMBEDDINGS=true`, live DeepLake):**

| run | recall@1 | recall@5 | recall@10 | MRR | nDCG | sem-vs-lex recall@5 Δ | beats | gate |
|-----|----------|----------|-----------|------|------|-----------------------|-------|------|
| 1 | 0.556 | **0.583** | 0.639 | 0.577 | 0.573 | 0.583 | true | PASS |
| 2 | 0.583 | **0.583** | 0.639 | 0.591 | 0.577 | 0.583 | true | PASS |
| 3 | 0.583 | **0.583** | 0.639 | 0.591 | 0.572 | 0.583 | true | PASS |
| 4 | 0.583 | **0.583** | 0.639 | 0.591 | 0.581 | 0.583 | true | PASS |
| 5 (`npm run eval:recall`) | 0.556 | **0.611** | 0.639 | 0.580 | 0.562 | 0.611 | true | PASS |

recall@5 lands in a TIGHT band **0.583–0.611 (±0.014)** — the 2× swing (0.278↔0.556) is GONE; MRR
0.577–0.591. `beats=true` 5/5; the enforcing gate `passed=true advisory=false` 5/5.

**Committed baseline (AC-6, honest):** `eval/recall-baseline.json` → `recallAt5: 0.55`, `mrr: 0.55`,
`placeholder: false`. Set AT-OR-BELOW the stable measured value so `baseline − ε` clears the residual
≤0.014 variance with headroom: recall@5 floor `0.55 − 0.05 = 0.50` vs stable ≥0.583; MRR floor
`0.55 − 0.05 = 0.50` vs min-observed 0.577. **EPSILON kept at 0.05** — the residual variance is far
smaller than ε, so no widening was justified or applied (documented in the baseline `//wave3` note).

**Live eval now passes the ENFORCING gate repeatably:** yes — 5/5 runs `passed=true advisory=false`; the
`if (!verdict.advisory) expect(verdict.passed).toBe(true)` assertion in AC-6 holds every run.

**Gate exit codes (all from repo root):** `npm run ci` → **0** (includes `audit:sql` → 0; 34 eval unit
tests green, +1 over W2b's 33 for the enforced-baseline test); `npm run build` → **0**;
`npm run audit:sql` → **0**; `npm run audit:openclaw` → **0**; `tests/daemon/storage/invariant.test.ts`
→ **0**. The live itest SKIPS without the token (CI stays green). `npm run eval:recall` with the daemon up
→ **PASS, exit 0**. No `.agents/.codex/.claude/.cursor`/`AGENTS.md` touched; no `git add`/commit/push.

## Blockers
- (none)
