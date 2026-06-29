# Dashboard performance and steady-state cost

> Category: Frontend | Version: 1.0 | Date: June 2026 | Status: Active

How the daemon-served dashboard keeps its idle and cold-load cost low: the background-tab polling pause, the single deduplicated `/health` poll, the short-TTL diagnostics caches, the split KPI read (cheap counts vs heavy savings), and the below-the-fold deferral. Read this before adding a new polling page or a new dashboard read so you inherit the existing cost controls instead of reintroducing the load they removed.

**Related:**
- [`dashboard-architecture.md`](dashboard-architecture.md)
- [`../dashboard/adding-a-page.md`](../dashboard/adding-a-page.md)
- [`../operations/deeplake-compute-cost.md`](../operations/deeplake-compute-cost.md)
- [`../operations/notifications-and-health.md`](../operations/notifications-and-health.md)

---

## The problem: an idle dashboard is not free

The dashboard self-hydrates by polling same-origin loopback endpoints, and several of those endpoints fan out to DeepLake scans (KPIs, sessions, rules, skills) or a filesystem walk (installed assets). Left naive, a dashboard tab parked in the background keeps firing those polls forever, and the hash router REMOUNTS a page every time the operator navigates back to it, re-running the same scans. Both are pure waste: nobody is looking at a background tab, and re-landing on the home should not recompute a KPI sum that has not moved. PRD-049e (PR [#161](https://github.com/legioncodeinc/honeycomb/pull/161)) closed both gaps with steady-state and cold-load wins that do not change what the dashboard shows.

## Background-tab pause (the single visibility seam)

`usePoll(fn, ms)` (`src/dashboard/web/page-frame.tsx`) is the one polling primitive every page uses, and it is the single place the pause lives. Its interval keeps its cadence but does NO work while the tab is hidden:

```ts
export function isTabHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}
```

- Each tick early-returns when `isTabHidden()` is true, so a backgrounded dashboard stops hitting the daemon/DeepLake entirely.
- A `visibilitychange` -> visible listener fires an IMMEDIATE tick on re-foreground, so returning to the tab refreshes at once rather than waiting up to `ms` (the skipped ticks left the view as stale as `ms` ago).
- The exported `isTabHidden` predicate also guards the per-page RAW loops (the graph/memories/sync/settings pages run their own `setInterval`/raw fetch loops outside `usePoll`); those check it too, so the pause is total, not just for `usePoll` consumers.

Because `usePoll` is the seam, any page authored to the documented `usePoll` recipe inherits the pause for free. A page that hand-rolls its own loop must call `isTabHidden()` itself.

## Health dedup: one `/health` poll, reasons flow down

The home page once polled `/health` a SECOND time to render its per-subsystem health strip, duplicating the shell's liveness poll. Now the shell (`src/dashboard/web/app.tsx`, `Shell`) owns the single `/health` poll, and the per-subsystem `reasons` flow DOWN to pages via `PageProps.healthReasons` (`HealthReasonsWire | null`, null until the first probe resolves):

```ts
usePoll(async () => {
  const { up, reasons } = await wire.health();
  setHealthReasons(reasons);
  // ...daemon-down swap + recovery re-hydrate
}, HEALTH_POLL_MS); // 5000ms
```

The shell's poll was migrated onto `usePoll`, so it inherits the background-tab pause too: a hidden dashboard stops probing `/health` as well. The home reads `healthReasons` from its props instead of polling, so there is exactly one `/health` poll for the whole app.

## Short-TTL diagnostics caches (skip the re-nav scans)

The dashboard API (`src/daemon/runtime/dashboard/api.ts`) wraps the expensive diagnostics reads in a keyed, time-bounded view cache so re-navigating to a page skips the underlying scan. The generalized helper is `createTtlViewCache<T>(ttlMs)` (the generalized form of the older installed-assets cache), keyed by `scopeCacheKey(scope, ...extra)`, which NUL-joins the scope plus any extra segments (e.g. sessions are keyed by page coordinates) so no value can forge a key boundary:

```ts
type TtlViewCache<T> = (key: string, compute: () => Promise<T>) => Promise<T>;
```

- **Sessions / rules / skills** reads are cached at the short `DIAG_TTL_MS = 10_000` (10s) per scope. Sessions are additionally keyed by `(limit, cursor)` so the default home panel page never collides with a deep Logs-page page. Re-landing on the home skips the DeepLake scan and (for skills) the disk inventory walk.
- Each `mountDashboardApi` call gets its OWN cache instances, so the caches never outlive a daemon restart.
- The map is bounded by `CACHE_MAX_KEYS = 64` and cleared wholesale when exceeded, a coarse but correct backstop for the handful of scopes a local dashboard ever touches.

A 10s TTL is short enough that a freshly captured turn surfaces on the next load, long enough that navigating away and back is free.

## Split KPI read: cheap counts vs heavy savings

The KPI band has two very different reads behind it. The three COUNTS (Memories / Turns / etc.) are cheap and churn; the estimated-savings SUM scans `content` across the corpus, is the heaviest KPI query, and moves slowly. `fetchKpisView` was split so each is independently cacheable at its own TTL:

```ts
// fetchKpisView now composes the two reads for direct callers (uncached):
const [counts, savings] = await Promise.all([
  fetchKpiCounts(storage, scope, projectId),
  fetchEstimatedSavings(storage, scope, projectId),
]);
```

The route caches `fetchKpiCounts` at `DIAG_TTL_MS` (10s) and `fetchEstimatedSavings` at `SAVINGS_TTL_MS = 60_000` (60s), so the most expensive query is recomputed roughly six times less often than the counts. `fetchKpisView` stays as the one-call composition so a direct caller or unit test still gets the whole view uncached in a single call.

## Defer the below-the-fold area to a second paint

On the home, the harness area sits below the fold; the KPI band + recall box are what the operator actually looks at first. The home now mounts the harness-area CONTENTS on a SECOND paint (`showSecondary` flips in a passive effect after the first commit paints, `src/dashboard/web/pages/dashboard.tsx`) so the KPI band + recall are interactive first. The landmark element itself always renders (stable layout, no reflow jump); only its contents wait. This is a cold-load latency win with no change to what eventually renders.

## What was deliberately NOT done

Route-level code-splitting (Tier 2.5) was deferred to its own PR. The dashboard is a single host-served bundle on loopback, so splitting it would need esbuild chunking, a new chunk-serving host route (a new security surface, see [`dashboard-architecture.md`](dashboard-architecture.md) on why the host route set is kept minimal), an asset resolver, and build-output test changes, all for a parse-time-only win that loopback delivery makes negligible. Not worth the added surface today.

## For a new page or read

- Poll through `usePoll` (or call `isTabHidden()` in your own loop) so a background tab goes quiet.
- Read `/health` reasons from `PageProps.healthReasons`; do NOT add a second `/health` poll.
- If your read fans out to a DeepLake scan or a filesystem walk, wrap it in a `createTtlViewCache` keyed by `scopeCacheKey(scope, ...)` so re-navigation is free; pick a short TTL for fast-moving data and a longer one for slow, heavy aggregates.
