# ADR-0010, Recall-weighted "Est. savings"; the corpus-length proxy is retired

> **Status:** Accepted | **Date:** 2026-07-08
> **Supersedes:** the PRD-035b est-savings metric decision (a metric definition, not a prior ADR) | **Superseded by:** none
> **Owners:** dashboard, daemon, operations | **Related:** IRD-278, PRD-035b, PRD-060 (ROI tracker)

## Context

The dashboard KPI band shows an "Est. savings" tile (unit `tok`). Today it is computed by
`fetchEstimatedSavings` in [`src/daemon/runtime/dashboard/api.ts`](../../../../src/daemon/runtime/dashboard/api.ts)
(PRD-035b) as a single aggregate over the memory corpus:

```sql
SELECT SUM(LENGTH(content)) AS chars FROM "memories" [WHERE project_id = <id>]
```

returning `Math.floor(chars / CHARS_PER_TOKEN)` with `CHARS_PER_TOKEN = 4`. `hive` proxies + caches
`/api/diagnostics/kpis` (2s TTL); honeycomb caches this SUM on a longer TTL because it is the most
expensive KPI query and slow-moving.

PRD-035b was explicit that this is a **proxy**: it replaced an old hardcoded `0` with "the total
distilled context the corpus can serve," rationalized as "every recalled-and-injected memory is
context the agent did not re-derive." In practice the metric measures **corpus size**, not savings,
and this produces a concrete user-visible defect (IRD-278): the number never moves in response to
using the harness. The reasoning chain is deterministic:

- `SUM(LENGTH(content)) / 4` is a **storage stat** — how much text sits in `memories` — not tokens avoided.
- It counts **inventory, not hits.** A memory that is never recalled saves nothing; a memory recalled
  50× saves ~50× its size. Weighting every stored memory equally (and never-recalled memories fully)
  is backwards.
- It is **monotonic and decoupled from behavior** — it only rises as memories accumulate, independent
  of whether recall does anything useful. Hence "it never updates when I use Claude Code."

Meanwhile the PRD-060 ROI tracker already models savings honestly: `RoiSavingsSection` separates
`measuredCents` (a billed/metered fact) from `modeledCents` (a subordinate `est.` line carrying its
assumption as data), and the capture path (PRD-060a) records the recall/injection events and token
counts a real savings figure needs. The honest data exists next door; the KPI band is simply wired to
the wrong source.

## Decision drivers

- **A tile labeled "savings" must measure savings.** Honesty of the render edge is a standing
  contract (the `/roi` page already refuses to fabricate `$0.00`).
- **Measure hits, not inventory.** Value is delivered at recall/injection time, not at storage time.
- **Reuse the ROI tracker's source of truth.** Do not invent a second, divergent savings number;
  fold the KPI into the PRD-060 measured/modeled model.
- **Keep the KPI cheap and fresh.** A recall-event rollup is lighter than a full-corpus TEXT SUM and
  can move to a shorter cache TTL, tightening freshness.
- **Fail honest, never fabricate.** Absent capture ⇒ an honest empty state, not a confident wrong number.

## Decision

We are **pivoting** "Est. savings" from a corpus-length proxy to a **recall-weighted savings** metric.

1. **Source from recall/injection events, not corpus length.** The KPI is a windowed rollup of
   savings actually realized when memories were recalled and injected — conceptually
   `Σ (injected_tokens × injection_count)` over the scope's recall events (PRD-060a capture path),
   NOT `SUM(LENGTH(content))` over `memories`.

2. **Adopt the PRD-060 honesty model in the KPI contract.** `KpisView` distinguishes **measured**
   (billed/metered) savings from **modeled** (estimated) savings rather than emitting one
   undifferentiated `est.` number, mirroring `RoiSavingsSection`. The KPI-band tile is the compact
   view of the same truth the `/roi` page renders in full.

3. **Retire the corpus-length proxy.** `fetchEstimatedSavings` / `buildEstimatedSavingsSql` are
   removed. If total corpus size is still worth surfacing, it returns as its **own** clearly-labeled
   KPI ("Corpus size" / distinct unit) — never again as "savings."

4. **Honest render + unit.** The `hive` KPI band shows the measured figure as the headline with the
   modeled figure subordinate; the unit honestly reflects the quantity (`tok` only for tokens). No
   fabricated `$0.00`; absent capture renders an honest empty/dash state.

5. **Caching follows the new source.** The recall-event rollup replaces the corpus SUM in the KPI
   read; because it is cheaper it may use a shorter TTL than the old savings cache, so the tile
   reflects recent activity rather than a slow-moving corpus total.

The `/roi` page (PRD-060e) is unchanged by this ADR — it already models savings correctly. This
decision only re-points the **KPI-band tile** at the same honest source.

## Consequences

**Positive**

- "Est. savings" becomes a real signal: it moves when recall does work, answering IRD-278 directly.
- One savings source of truth (PRD-060), so the KPI tile and the `/roi` page cannot diverge.
- Measured-vs-modeled separation reaches the KPI band, extending the ROI honesty contract.
- The KPI read gets cheaper and fresher (event rollup vs full-corpus TEXT SUM).

**Negative / accepted**

- "Est. savings" is only meaningful once token/recall capture (PRD-060a) is live for the scope; before
  then the tile shows an honest empty state rather than a (wrong-but-nonzero) corpus proxy. We accept a
  truthful blank over a confident-but-meaningless number.
- Historical recall events that predate capture cannot be backfilled, so the windowed figure starts
  from when capture began (surface a "tracked from <date>" caption, as the trend view already does).
- Existing consumers/tests binding to the old `SUM(LENGTH(content))` semantics must be migrated.

## Required invariants

- The KPI labeled "savings" must derive from recall/injection savings, never from corpus length.
- Measured savings must be distinguishable from modeled savings in the served contract.
- The render edge must never fabricate a savings figure; absent capture ⇒ honest empty state.
- Any surviving corpus-size metric must be labeled as size, not savings.

## Revisit triggers

Re-open this decision if any of these become true:

1. Token/recall capture (PRD-060a) proves too sparse to yield a stable KPI — consider a clearly-labeled
   modeled-only fallback rather than reverting to the corpus proxy.
2. The `/roi` savings model itself changes shape — keep the KPI tile folded into whatever becomes the
   single savings source of truth.
3. Product decides the KPI band should show cost/dollars rather than tokens — revisit unit + the
   measured/modeled split accordingly.

## Links

- IRD-278: `library/issues/backlog/ird-278-est-savings-recall-weighted/ird-278-est-savings-recall-weighted-index.md`
- PRD-035b (superseded metric): `library/requirements/completed/prd-035-dashboard-data-fixes/prd-035b-dashboard-data-fixes-est-savings-metric.md`
- PRD-060 (ROI tracker): `library/requirements/completed/prd-060-roi-tracker/prd-060-roi-tracker-index.md`
- PRD-060b (cost + savings engine): `library/requirements/completed/prd-060-roi-tracker/prd-060b-roi-tracker-cost-and-savings-engine.md`
