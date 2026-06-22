# PRD-035b — Est. savings: real, explainable token-savings metric

> **Status:** Backlog
> **Priority:** P0
> **Effort:** M
> Parent: [PRD-035 — Dashboard Data Fixes](./prd-035-dashboard-data-fixes-index.md)

## Overview

The "Est. savings" KPI on the dashboard is hardcoded to zero. In
`src/daemon/runtime/dashboard/api.ts`, `fetchKpisView` returns `estimatedSavings: 0` (`api.ts:159`)
with the inline comment "savings is a real metric (0 until its pipeline lands)" (`api.ts:148`). The
web app renders it verbatim — `<Kpi label="Est. savings" value={kpis.estimatedSavings...} unit="tok"
... />` (`app.tsx:401`) — so every user sees `0 tok` for a headline value-prop metric. The contract
field already exists and means the right thing: `KpisView.estimatedSavings` — "Estimated token/cost
savings (the org savings metric)" (`contracts.ts:43`); the wire schema parses it
(`KpisSchema.estimatedSavings`, `wire.ts:58`). Only the daemon-side computation is missing.

This sub-PRD defines and implements the real computation: the data source, the formula, where it is
computed, and how it stays cheap.

## Goals

- Replace the hardcoded `0` with a real, explainable estimated-token-savings number computed
  daemon-side from data Hivemind already has.
- The number is non-zero when recall/capture data exists and is `0` only when there genuinely is no
  data to estimate from.
- Keep it cheap: the cost of computing it must not meaningfully slow the `/api/diagnostics/kpis`
  response.

## Non-Goals

- A perfectly accurate accounting of tokens saved (this is an *estimate*, labeled "Est. savings").
- A new DeepLake schema column purely for this metric in v1 — if existing columns suffice, use them
  (see OQ-1). A dedicated column is an Open Question for deeplake-dataset-worker-bee.
- Cost-in-dollars conversion (the KPI unit is `tok`; dollars are a later enhancement).
- A historical time-series of savings (the KPI is a single current number).

## The metric — definition

**What "savings" means.** Every recall hit that Hivemind injects into a harness turn is context the
agent did NOT have to re-derive by re-reading files / re-asking / re-deriving from scratch. The
estimate is: *the tokens of recalled-and-injected context that substituted for re-derivation*.

**Proposed default formula (D-1).** Compute, daemon-side, an estimate that works from data already
captured, without a new schema column:

```
estimatedSavings  =  turnsWithRecall  ×  avgInjectedContextTokens
```

where:
- `turnsWithRecall` — the number of captured turns/sessions for which recall served at least one
  hit (derivable from the `sessions`/`memory` capture record; see OQ-1 for the exact column).
- `avgInjectedContextTokens` — the mean token size of the injected recalled context per such turn.
  If a per-row token count is not stored, approximate from the recalled memories' text length using
  a fixed chars-per-token divisor (a documented constant, e.g. ~4 chars/token), summed over the
  recalled memories. This keeps the estimate explainable and bounded.

**Alternative formula (D-1, fallback).** If per-turn recall attribution is not cheaply available,
use a memory-corpus proxy: `sum(tokens(memory.summary_text))` over the org's stored memories — i.e.
the total distilled context the corpus can serve — as a coarse "context available to be reused"
proxy. This is less precise (it measures supply, not realized substitution) and is the second
choice; pick the turn-attributed formula if the data supports it.

**Honesty rule.** Whichever formula ships, the KPI must be `0` only when the inputs are genuinely
empty (no recalls / no memories), never a stub. The chosen formula is documented in a code comment
replacing the current "0 until its pipeline lands" stub comment.

## Where it is computed

- **D-2 — Compute in `fetchKpisView` (daemon-side), behind a small helper.** Add a
  `fetchEstimatedSavings(storage, scope)` (or fold into the existing `Promise.all` in
  `fetchKpisView`) that runs ONE additional guarded aggregate query (e.g. a `SUM`/`COUNT` over the
  `memory`/`sessions` table), using the existing `sql.ts` guards (`sqlIdent`/`sLiteral`) and the
  `selectRows` fail-soft helper — exactly like the existing count queries. No new route; the value
  flows out on the existing `KpisView.estimatedSavings` field the page already renders.
- **D-3 — Stay storage-correct and fail-soft.** The query goes through the injected `StorageQuery`
  seam (never a raw connection), and on any non-ok result returns `0` (the existing `selectRows`
  pattern), so a degraded storage layer yields `0`, not a thrown handler.

## Functional Requirements

- **FR-1** — `fetchKpisView` computes `estimatedSavings` from real storage data using the D-1
  formula; the hardcoded `estimatedSavings: 0` and its stub comment are removed.
- **FR-2** — The computation runs as a guarded aggregate through the `StorageQuery` seam, added to
  the existing parallel reads (or a sibling helper), reusing `sqlIdent`/`sLiteral`/`selectRows`.
- **FR-3** — The result is a finite non-negative number; on any storage error the value is `0`
  (fail-soft), never NaN/undefined (reuse `toNum`).
- **FR-4** — The formula and the chars-per-token constant (if used) are documented in a code
  comment at the computation site, replacing the "0 until its pipeline lands" comment.
- **FR-5** — The web KPI (`app.tsx:401`) renders the real value with the existing `tok` unit and
  `toLocaleString()` formatting — no web-side change required beyond what already exists.

## Acceptance Criteria

- [ ] **AC-1** — With recall/capture data present, the "Est. savings" KPI shows a real, non-zero
      number (proven against an assembled daemon with seeded data).
- [ ] **AC-2** — With no data (empty `memory`/`sessions`), the KPI shows `0` — and `0` is reached
      only by the genuinely-empty path, not a hardcode.
- [ ] **AC-3** — The number is explainable: the formula is documented at the computation site and a
      reader can trace KPI value → formula → source query.
- [ ] **AC-4** — The added query is a single cheap aggregate through the storage seam with guarded
      SQL; `fetchKpisView` still returns promptly (no per-row N+1).
- [ ] **AC-5** — On a storage error the savings value is `0` (fail-soft), and no handler throws.
- [ ] **AC-6** — A daemon-side vitest asserts: (a) non-zero from seeded data, (b) `0` from empty
      data, (c) `0` on a forced storage error; `npm run ci` is green.

## Open Questions

- **OQ-1 — Exact data source.** Which table/column gives `turnsWithRecall` and the per-turn injected
  token size? Candidates: a recall-attribution field on `sessions`, or a token/length field on
  `memory`. If none exists cheaply, ship the memory-corpus proxy (D-1 fallback) for v1 and file a
  deeplake-dataset-worker-bee request for a dedicated `tokens`/recall-attribution column. **Decide
  with deeplake-dataset-worker-bee + retrieval-worker-bee before implementation.**
- **OQ-2 — Token estimation method.** If we approximate tokens from text length, what divisor
  (chars/token) do we standardize on, and do we ever call a real tokenizer? Default: a documented
  ~4 chars/token constant (cheap, good enough for an estimate); a tokenizer is out of scope for a
  per-request KPI.
- **OQ-3 — Scope of the count.** Is "savings" org-scoped (matching `fetchKpisView`'s scope) or
  workspace-scoped? Default: same scope as the other KPIs (org), so all four KPIs agree.

## Implementation Notes

- Primary touch point: `src/daemon/runtime/dashboard/api.ts` — `fetchKpisView` (`api.ts:149-161`)
  + a new guarded aggregate helper. Contract (`contracts.ts:43`) and wire (`wire.ts:58`) already
  carry the field — no change needed there. No `server.ts` edit.
- Follow the existing fail-soft + guarded-SQL idioms in the file (`selectRows`, `toNum`, `sqlIdent`,
  `sLiteral`). Hand the formula to retrieval-worker-bee for a sanity check on the recall-attribution
  data before coding.
