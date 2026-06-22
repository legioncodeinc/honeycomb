# PRD-046f — Prime eval (prove it, or pull it)

> Status: backlog · Parent: PRD-046 · Wave: W2 · Type: M
> Goal: measure that priming actually changes the agent's retrieval/behavior versus a cold start. A
> prime the agent ignores is worse than no prime (it costs tokens for nothing), so this slice makes the
> value testable and gives the kill criterion teeth.

## Why
Every other slice is an assertion until this one measures it. The same discipline that killed the
native hybrid operator (PRD-045a) applies: do not trust "it feels smarter." Honeycomb already has a
recall-eval harness (PRD-045f graded relevance + nDCG, built on `src/eval/`) — this slice extends it
from "is the right memory retrievable" to "does priming change what the agent does." See
`session-priming-architecture.md` §8.

## What (scope)
- **A prime-scenario set** (committed, synthetic, no secrets) of `(repo state + memory + task)` cases
  where a primed agent *should* behave differently from a cold one — e.g. a task whose answer was
  decided in a prior session captured in memory.
- **A/B harness:** run each scenario primed vs cold (no prime), and score behavioral signals:
  - **pull-through** — did the agent resolve a primed key it was given? (a key nobody expands is a bad
    key — the 046b make-or-break, measured here);
  - **redundant-search reduction** — fewer blind searches for something already in the index;
  - **convergence** — faster arrival at the right file/decision;
  - **grounded reference** — the agent references a primed memory without being told it.
- **A gate:** a committed bar; a change that drops the primed-vs-cold delta below `bar − ε` fails, the
  same way PRD-045's recall baseline gates.
- **Reuse the 045f machinery** (`src/eval/` metrics, the golden/scenario loader, the gated-live itest
  pattern) rather than a parallel harness.

## Acceptance criteria
- **f-AC-1 — Scenario set committed.** A small, synthetic, secret-free prime-scenario set exists and is
  zod-validated by the harness (mirrors `eval/recall-golden.json`).
- **f-AC-2 — Primed-vs-cold measured.** The harness runs each scenario primed and cold and emits the
  behavioral signals (pull-through, redundant-search, convergence, grounded-reference) per scenario +
  aggregate. Runs as a script + a gated live itest (skips cleanly without a token / embed daemon).
- **f-AC-3 — Priming shows a positive delta.** On the scenario set, the primed agent beats cold on at
  least the headline signal (pull-through and/or redundant-search reduction) with no regression — the
  generalized "priming helps" proof. Recorded with the measured numbers.
- **f-AC-4 — Gated.** A committed bar is enforced; a regression below `bar − ε` fails the eval (advisory
  until the first measured baseline is committed, then enforced — same posture as PRD-027/045).
- **f-AC-5 — No secrets; gates green.** The scenario set is grep-clean; `npm run ci` stays green; the
  live eval is `describe.skipIf(!HAS_TOKEN)`.

## Risks / Out of scope
- **Risk — behavioral signals are noisy.** Agent behavior varies run-to-run. Mitigated by scoring
  robust signals (pull-through, redundant-search count) over a scenario set, not a single trace, and by
  an `ε` tolerance like the recall eval.
- **Risk — overfitting to the scenarios.** Grow the set from real dogfood (a session where priming
  obviously would/ wouldn't have helped), same as the recall golden set.
- **Out of scope — the prime/keys/hooks themselves** (046a–d); **recall ranking eval** (PRD-045f, reused
  not replaced).

## Dependencies
- **046a–046d** (there must be a working prime to measure).
- **PRD-045f** — the eval harness (`src/eval/`, metrics, gated-live-itest pattern) this extends.
- DeepLake eventual consistency — live scenarios poll to convergence before scoring.
