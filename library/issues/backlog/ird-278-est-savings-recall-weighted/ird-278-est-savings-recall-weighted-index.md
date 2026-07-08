# IRD-278: Dashboard "Est. savings" KPI measures corpus size, not savings — pivot to recall-weighted savings

> **GitHub Issue:** [#278](https://github.com/legioncodeinc/honeycomb/issues/278) - Enhancement
>
> **Status:** Backlog
> **Priority:** P2
> **Effort:** M (3-8h)
> **Reporter:** Mario Aldayuz (@legioncodeinc)

---

## Problem

**Observed:** The dashboard "Est. savings" KPI (rendered with unit `tok`) never moves in response to actually using the harness. It reads as a savings meter but behaves like a slow-growing storage counter.

**Expected:** A metric labeled "Est. savings" should reflect value actually delivered — tokens the agent did **not** have to spend because a memory was recalled and injected — and should visibly respond when recall is doing work during sessions.

**Reproduction steps:**

1. Open the dashboard; note the "Est. savings" value.
2. Run several Claude Code sessions that recall and inject memories.
3. Re-open the dashboard.
4. Observe the value is unchanged except insofar as the raw memory corpus grew — it does not track recall/injection activity at all.

---

## Root cause

By design. PRD-035b replaced an old hardcoded `0` with a **corpus-length proxy**, not a savings measurement. In [`src/daemon/runtime/dashboard/api.ts`](../../../../src/daemon/runtime/dashboard/api.ts), `fetchEstimatedSavings` runs a single aggregate over the memory corpus:

```sql
SELECT SUM(LENGTH(content)) AS chars FROM "memories" [WHERE project_id = <id>]
```

and returns `Math.floor(chars / CHARS_PER_TOKEN)` with `CHARS_PER_TOKEN = 4` (`buildEstimatedSavingsSql`). `hive` only proxies + caches `/api/diagnostics/kpis` ([`src/daemon/proxy-cache.ts`](../../../../../hive/src/daemon/proxy-cache.ts), 2s TTL); honeycomb caches the savings SUM on a longer TTL because it is the most expensive KPI query and slow-moving.

The value is therefore *total characters of distilled memory `content` ÷ 4*. Consequences:

1. **It is corpus size, not savings** — a storage stat, not tokens avoided.
2. **The core assumption does not hold.** The rationale ("every stored memory is context the agent did not re-derive") counts *inventory*, not *hits*: a never-recalled memory saves nothing; one recalled 50× saves ~50× its size. Backwards.
3. **Monotonic and decoupled from behavior** — it only grows as memories accumulate, hence "never updates" with use.
4. **Honest data already exists.** The PRD-060 ROI tracker carries `measuredCents` (real cache savings), `modeledCents`, recall/injection events, and a token-capture path; the KPI band is simply not wired to it.

---

## Fix plan

Architecture decision + design sketch captured in [ADR-0010](../../../knowledge/private/architecture/adr/0010-recall-weighted-est-savings.md). This IRD is the implementation-tracking view.

1. Source savings from **recall/injection events** (the PRD-060a token-capture path), not a `SUM(LENGTH())` over `memories`. Compute a windowed `Σ (injected_tokens × injection_count)` per scope.
2. Reconcile against the ROI tracker's honesty model: distinguish **measured** (billed/metered) from **modeled** (estimated) savings in the `KpisView` contract rather than emitting one undifferentiated `est.` number.
3. Update the `hive` KPI band render + unit so the label is honest (`tok` only if tokens; no fabricated `$0.00`).
4. Remove or explicitly repurpose `buildEstimatedSavingsSql` / `fetchEstimatedSavings`; if corpus size is still worth surfacing, it becomes its own clearly-labeled KPI, not "savings".
5. Preserve the caching split (a recall-event rollup is cheaper than the corpus SUM and can move to a shorter TTL, tightening freshness).

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given active recall during sessions, when the dashboard reloads, then "Est. savings" reflects recall/injection activity, not raw corpus length. |
| AC-2 | Given no new memories are formed but existing memories are recalled repeatedly, when the KPI is computed, then its value increases (proving it tracks hits, not inventory). |
| AC-3 | Given the KPI contract, when savings is served, then measured savings is distinguished from modeled estimate, consistent with the PRD-060 `RoiView` model. |
| AC-4 | Given the render edge, when the KPI is shown, then its label and unit honestly reflect the quantity (no fabricated `$0.00`; `tok` only for tokens). |
| AC-5 | Given the pivot ships, when the codebase is inspected, then the corpus-length proxy is removed or explicitly repurposed under an honest label. |

---

## Files touched

- [`src/daemon/runtime/dashboard/api.ts`](../../../../src/daemon/runtime/dashboard/api.ts) — replace `fetchEstimatedSavings` / `buildEstimatedSavingsSql`.
- [`src/dashboard/contracts.ts`](../../../../src/dashboard/contracts.ts) — `KpisView` measured/modeled split.
- [`src/daemon/runtime/dashboard/roi-savings.ts`](../../../../src/daemon/runtime/dashboard/roi-savings.ts) — reuse the ROI savings/recall source of truth.
- hive: `src/dashboard/web/pages/dashboard.tsx` (render), `src/dashboard/web/wire.ts` (schema), `src/daemon/proxy-cache.ts` (TTL) — in the `hive` submodule.

---

## Out of scope

- The full `/roi` page (PRD-060e) — this IRD only re-points the KPI-band "Est. savings" tile; the ROI page already models savings honestly.
- Backfilling historical recall events that predate token capture.
- Changing `CHARS_PER_TOKEN` heuristics used elsewhere (recall budget, compaction, prime-digest) — those are unrelated token estimators.

---

## Related

- [ADR-0010: Recall-weighted "Est. savings"](../../../knowledge/private/architecture/adr/0010-recall-weighted-est-savings.md) — the decision + sketch this IRD implements.
- PRD-035b (est-savings-metric) — the current corpus-length proxy being superseded.
- PRD-060 (ROI tracker) — the measured/modeled savings engine and recall/token-capture source of truth.
