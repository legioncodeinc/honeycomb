# `eval/` — the recall-quality golden set + baseline (PRD-027 D-5/D-6, AC-5/AC-6)

This directory holds the **committed, reproducible** inputs to the recall-eval harness — the
instrument that MEASURES recall quality and GATES regressions (PRD-027 Problem 3). It is plain
committed data; the metric math lives in `src/eval/metrics.ts` and the runner in `src/eval/golden.ts`.

## Files

- **`recall-golden.json`** — the golden set: ~36 `(query → expected memory)` pairs. Each pair is
  `{ key, memoryText, query, lexicalMiss, relevance? }`:
  - `key` — a stable slug. The harness uniquifies it per run (`key + RUN_ID`) so a live seed reads
    ONLY this run's rows (append-only, in the token's `honeycomb_ci` workspace).
  - `memoryText` — STORED as a memory before the query runs.
  - `query` — run through the REAL recall engine (`recallMemories`).
  - `lexicalMiss` — `true` when the query shares **no surface token** with `memoryText` (e.g. target
    *"the build is timing out on the pack step"*, query *"CI keeps failing during publish"*). Only the
    `<#>` semantic arm can bridge a lexical-miss pair — these are the pairs that exercise the PRD-025
    lift and that DROP OUT under lexical-only recall. The set is deliberately ~45% lexical-miss.
  - `relevance` — graded gain for nDCG (default `1` = binary, which is what D-6 allows when graded
    relevance is absent).
- **`recall-baseline.json`** — the committed `recall@5` / `MRR` baseline the gate reads, plus the
  epsilon. **The numbers are a marked PLACEHOLDER**; Wave 3 runs the eval live and commits the
  measured values (see below).

## How it runs

- **`npm run eval:recall`** — the scriptable entry. It is token+embeddings-gated: with no
  `HONEYCOMB_DEEPLAKE_TOKEN` or with the embed daemon unreachable it prints a clear message and
  exits 0 (it never silently passes — it SKIPS with a reason). With creds + the embed daemon up it
  seeds the golden memories, polls to embedding convergence, runs recall for every query, and prints
  the per-query hit/miss table plus aggregate recall@k / MRR / nDCG.
- **`tests/integration/recall-eval-live.itest.ts`** — the gated live itest (same gating posture as
  `semantic-recall-live.itest.ts`). Run via `npm run test:integration`. It asserts the harness emits
  the metrics and that **semantic-ON beats lexical-only** on recall@5 / MRR (AC-6, the behavioral bar).
- The metric math (`src/eval/metrics.ts`) and the gate logic (`src/eval/golden.ts`) are unit-tested
  deterministically in `tests/eval/` and run in `npm run ci` — those tests need NO creds.

## Wave-3 live commands (the orchestrator runs these to set/confirm the baseline)

```bash
# 1. start the embed daemon (the nomic model runs on this host, PRD-025)
#    (however the embed daemon is started in this repo — it must answer POST <url>/embed)

# 2. load the gitignored live creds and run the eval with embeddings ON
set -a; . ./.env.local; set +a
HONEYCOMB_EMBEDDINGS=true npm run eval:recall

# 3. run the gated live itest (asserts metrics + the semantic-beats-lexical bar)
set -a; . ./.env.local; set +a
HONEYCOMB_EMBEDDINGS=true npm run test:integration -- recall-eval-live
```

Wave 3 then writes the MEASURED `recall@5` / `MRR` into `recall-baseline.json` (replacing the
placeholder) so the `baseline − ε` gate enforces a real number.

## Growing the set (D-5)

Grow it from **real dogfood misses**: when a live recall surfaces the wrong memory or misses the
right one, distill the `(query → expected)` into a new pair, tag `lexicalMiss` honestly, keep it
synthetic (no secrets/PII — this dir is committed and grep-scanned), and re-run the eval. Keep the
lexical-miss pairs — they are the ones that keep the semantic lift honest.
