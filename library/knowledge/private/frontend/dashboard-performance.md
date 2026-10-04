# Dashboard performance and steady-state cost

> Category: Frontend | Version: 1.1 | Date: October 2026 | Status: Active

How dashboard reads stay cheap in this checkout: `launchDashboard` fetches the daemon once per launch, and the dashboard API caches expensive diagnostics behind short TTLs. The React polling shell (`usePoll`, a `/health` poll owned by a page shell, below-the-fold deferral) is absent. Read this before adding a dashboard read so the new read joins the existing caches.

**Related:**
- [`dashboard-architecture.md`](dashboard-architecture.md)
- [`../dashboard/adding-a-page.md`](../dashboard/adding-a-page.md)
- [`../operations/deeplake-compute-cost.md`](../operations/deeplake-compute-cost.md)
- [`../operations/notifications-and-health.md`](../operations/notifications-and-health.md)

---

## One fetch per launch

`launchDashboard` (`src/dashboard/launch.ts:142-146`) builds a data source and calls `renderDashboard` once. The source probes `GET /health`, then `fetchAll` issues the six view reads together (`src/dashboard/launch.ts:106-130`). Nothing in `src/dashboard/` schedules a repeating poll. `usePoll`, `isTabHidden`, `HEALTH_POLL_MS`, `showSecondary`, and `document.visibilityState` are absent under `src/`. There is no dashboard entry in `esbuild.config.mjs`, so there is no host-served dashboard bundle and no tab-visibility seam to inherit.

A repeated call to the same diagnostics route inside the TTL is what the caches below skip. That is a daemon-side cache, not a browser remount.

## Short-TTL diagnostics caches

The dashboard API (`src/daemon/runtime/dashboard/api.ts`) wraps expensive diagnostics reads in `createTtlViewCache<T>(ttlMs)`, keyed by `scopeCacheKey(scope, ...extra)`. The key NUL-joins the scope plus any extra segments so a value cannot forge a key boundary.

```ts
type TtlViewCache<T> = (key: string, compute: () => Promise<T>) => Promise<T>;
```

- Sessions, rules, and skills reads use `DIAG_TTL_MS = 10_000`. Sessions are additionally keyed by limit and cursor, so one page of sessions never collides with another.
- Each `mountDashboardApi` call gets its own cache instances, so the maps do not outlive a daemon restart.
- The map is bounded by `CACHE_MAX_KEYS = 64` and cleared wholesale when a new key would exceed that size.

A 10s TTL is short enough that a freshly captured turn can show up on a later read, and long enough that a second read inside the window skips the scan.

## KPI composition: three reads

`fetchKpisView` awaits three reads (`src/daemon/runtime/dashboard/api.ts:267-271`):

```ts
const [counts, estimatedSavings, injectedTokens] = await Promise.all([
  fetchKpiCounts(storage, scope, projectId),
  fetchEstimatedSavings(storage, scope, projectId),
  fetchInjectedTokens(storage, scope, projectId),
]);
```

`fetchKpiCounts` is the count read. `fetchEstimatedSavings` is the corpus-length sum, the heaviest of the three. `fetchInjectedTokens` is the injected-token sum. The route caches the counts and the injected-token sum at `DIAG_TTL_MS` (10s) and `fetchEstimatedSavings` at `SAVINGS_TTL_MS = 60_000` (60s). `fetchKpisView` itself stays the uncached composition so a direct caller still gets the whole view in one call.

The `ViewBlock` rows from `buildKpisView` are `Memories`, `Sessions`, and `Estimated savings`. The third await is part of the view-model, not a fourth label on that block.

> **Slated to change.** `fetchEstimatedSavings` computes a corpus-length proxy (`SUM(LENGTH(content)) / 4`). [ADR-0010](../architecture/adr/0010-recall-weighted-est-savings.md) (Accepted) pivots "Estimated savings" to a recall-weighted metric and retires `fetchEstimatedSavings` / `buildEstimatedSavingsSql`. The re-wiring is IRD-278. The note above documents the corpus-sum read as it stands. Once the pivot lands, the heaviest KPI read becomes a recall-event rollup that can use a shorter TTL.

## For a new read

- Put a DeepLake scan or a filesystem walk behind `createTtlViewCache`, keyed by `scopeCacheKey(scope, ...)`. Use `DIAG_TTL_MS` for data that should move within a few seconds and `SAVINGS_TTL_MS` for a slow aggregate.
- A new visible block is a `build*View` composed by `renderDashboard`. See [`../dashboard/adding-a-page.md`](../dashboard/adding-a-page.md).
- `launchDashboard` does not poll. A repeating client loop would be a new seam.
