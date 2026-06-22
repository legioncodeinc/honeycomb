# `eval/prime-*` — the prime-eval scenario set + baseline (PRD-046f, f-AC-1..5)

This is the **committed, reproducible** input to the prime-eval harness — the instrument that
MEASURES whether session priming (the 046c digest injected at SessionStart) changes what the agent
retrieves versus a COLD start, and GATES regressions. It extends the recall-eval (`recall-golden.json`,
PRD-027) from *"is the right memory retrievable"* to *"does priming change what the agent does"*. It
reuses `src/eval/`'s patterns — pure metric functions + a thin runner — and does **not** fork a second
metrics module. The metric math lives in `src/eval/prime.ts`.

## Files

- **`prime-golden.json`** — the scenario set: synthetic `(seeded memory + a task)` cases where a
  PRIMED agent should behave differently from a COLD one. Each scenario is
  `{ key, targetMemoryText, distractorMemoryTexts[], task, coldSearchCount, primedResolveCount }`:
  - `key` — a stable slug. The harness uniquifies it per run (`key + RUN_ID`) so a live seed reads
    ONLY this run's rows (append-only, in the token's `honeycomb_ci` workspace).
  - `targetMemoryText` — the prior-session decision that answers `task`. STORED as a memory so its
    Tier-1 key lands in the prime digest.
  - `distractorMemoryTexts` — other memories seeded in the same scope, so pull-through is a real
    discrimination (not a trivial one-item digest).
  - `task` — the prompt the agent faces.
  - `coldSearchCount` — blind searches a COLD agent needs to reach the target with no prime
    (hand-estimated; a lexical-miss task costs more).
  - `primedResolveCount` — resolve calls a PRIMED agent needs when the digest lists the target's key
    (normally `1` — one `hivemind_read` of the primed ref).
- **`prime-baseline.json`** — the committed `pullThroughRate` / `searchReductionMean` baseline the gate
  reads, plus the placeholder flag. **The numbers are a marked PLACEHOLDER (advisory)**; the gate
  computes the verdict but never FAILS a run until the first live measurement flips
  `placeholder: false` — the same posture as PRD-027/045.

## The two deterministic signals (no LLM judge — f-AC-2)

The prime path is itself deterministic (`skimPrimeKeys` pure SQL → `assemblePrimeDigest` pure
transform), so the harness never asks a model "did priming help":

- **pull-through** — is the TARGET memory's id present in the assembled digest (so the primed agent
  resolves it with one `hivemind_read`, no blind search)? A key nobody can expand is a bad key — 046b's
  make-or-break, **measured**. A COLD start has no digest → pull-through is structurally `0` for cold,
  so the primed pull-through rate IS the primed-vs-cold delta.
- **redundant-search reduction** — how many blind searches priming SAVED: `coldSearchCount − primedSearches`
  (floored at 0). The primed agent, when the digest carries the target, reaches it with ZERO blind
  searches; the cold agent must blind-search.

Both reduce to COUNTS and a SET-MEMBERSHIP test over ids — the same hand-verifiable shape as
`src/eval/metrics.ts`. The unit tests (`tests/eval/prime.test.ts`) assert the math against HAND-COMPUTED
expectations and drive a deterministic fake (primed surfaces the target, cold does not).

## How it runs

- **`npm run eval:prime`** — the scriptable entry. Token-gated: with no `HONEYCOMB_DEEPLAKE_TOKEN` it
  prints a clear message and exits 0 (it never silently passes — it SKIPS with a reason). With creds it
  seeds the scenarios, polls to convergence, assembles the REAL prime digest, scores pull-through +
  redundant-search reduction primed-vs-cold, and prints the per-scenario table + the aggregate + the
  baseline gate. The embed daemon is **optional** here (the prime read is pure SQL — no `<#>`);
  embeddings only sharpen the cold blind-search reachability check.
- **`tests/integration/prime-eval-live.itest.ts`** — the gated live itest (`describe.skipIf(!HAS_TOKEN)`,
  same gating posture as `recall-eval-live.itest.ts`). Run via `npm run test:integration`. It asserts the
  harness emits the signals and that **priming beats a cold start** on the headline signal (f-AC-3).
- The metric math + the gate logic (`src/eval/prime.ts`) are unit-tested deterministically in
  `tests/eval/prime.test.ts` and run in `npm run ci` — those tests need NO creds.

## Setting the measured baseline (advisory → enforced, f-AC-4)

```bash
# load the gitignored live creds and run the eval (embed daemon optional)
set -a; . ./.env.local; set +a
npm run eval:prime
```

Read the `[046f receipt]` pull-through / search-reduction the itest logs, write the measured values
AT-OR-BELOW the stable observed numbers into `prime-baseline.json`, and flip `placeholder: false` so the
`baseline − ε` gate enforces a real floor (ε = `EPSILON_PRIME` in `src/eval/prime.ts`).

## Growing the set (the kill criterion — f-AC risk note)

Grow it from **real dogfood**: a session where priming OBVIOUSLY would have helped (the agent
blind-searched for something a prior session had already decided) becomes a new scenario — capture the
prior decision as `targetMemoryText`, the blind-search count as `coldSearchCount`, and the task the
agent faced. Keep it synthetic (no secrets/PII — this dir is committed and grep-scanned). A prime the
agent ignores is worse than no prime; the lexical-miss / high-`coldSearchCount` scenarios are where the
prime earns its tokens, so keep them.
