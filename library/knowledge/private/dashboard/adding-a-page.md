# How to add a dashboard page

> Category: Frontend | Version: 1.2 | Date: October 2026 | Status: Active

A contributor how-to for the dashboard that ships in this checkout. A page here is a `ViewBlock` builder composed by `renderDashboard`. Owner of that seam: `src/dashboard/views.ts` and `src/dashboard/dashboard.ts`. The React registry recipe (`src/dashboard/web/registry.tsx`, one `RouteEntry`, `/dashboard/app.js`) is absent.

**Related:**
- [`../frontend/dashboard-architecture.md`](../frontend/dashboard-architecture.md)
- [`../architecture/daemon-surface.md`](../architecture/daemon-surface.md)

`src/dashboard/web/` is absent, including `sidebar.tsx`, `router.tsx`, `registry.tsx`, `page-frame.tsx`, `app.tsx`, and `pages/`. `src/daemon/runtime/dashboard/host.ts` is absent. Honeycomb has no `GET /dashboard` route. `src/dashboard/html.ts` still comments that the daemon serves `GET /dashboard`; that comment describes a route this tree does not mount. The browser origin constant is `HIVE_PORT` `3853`, documented in [`../frontend/dashboard-architecture.md`](../frontend/dashboard-architecture.md).

PRD-037 through PRD-044 named a hash-routed shell. That shell is not the seam in this repository. Follow the builders below.

## The recipe

### 1. Return a `ViewBlock`

Add a `build*View` in `src/dashboard/views.ts`. Builders are pure: they take a view-model and return a `ViewBlock` (`kind`, optional `title`, `rows`, `children`, `data`). They do not fetch and they do not import DeepLake.

```ts
export function buildExampleView(view: ExampleView): ViewBlock {
  return {
    kind: "panel",
    title: "Example",
    rows: view.rows,
    data: view,
  };
}
```

Match the kinds hosts already switch on (`panel`, `table`, `metric`, `empty-state`, `graph-canvas`, `connectivity`) unless the host serializer grows a new kind in the same change.

### 2. Compose it from `renderDashboard`

`renderDashboard` in `src/dashboard/dashboard.ts` pushes the reachable views in a fixed order: KPIs, sessions, settings, graph, rules, skill-sync. That order is the contract the Cursor webview paints.

A nested `children` entry does not add a seventh top-level block. `buildLifecycleFlagsView` is the existing example: `buildSettingsView` attaches it as a child so the six-block order stays intact.

A new top-level block changes that contract. Add the `build*View` call in `renderDashboard` only when both hosts should show a new top-level block, and update the tests that lock the order.

### 3. Feed it from the daemon read

When the block needs data the six endpoints do not already return, add the read on the dashboard API (`src/daemon/runtime/dashboard/api.ts`) and include it in `createDaemonDashboardDataSource.fetchAll` (`src/dashboard/launch.ts`). `launchDashboard` performs that fetch once per launch. It does not poll.

Expensive scans belong behind `createTtlViewCache`. See [`../frontend/dashboard-performance.md`](../frontend/dashboard-performance.md).

## What this checkout checks

View structure is asserted without a DOM in:

- `tests/dashboard/dashboard.test.ts`
- `tests/dashboard/views.test.ts`
- `tests/dashboard/html.test.ts`
- `tests/dashboard/logs.test.ts`

`tests/dashboard/web/registry.test.tsx` is absent. There is no registry test that mounts a throwaway hash route.

## Why the seam is a builder

One `ViewBlock` tree feeds the launch client and the Cursor webview. `html.ts` serializes that same tree to HTML for a host that wants a document. The daemon does not mount a route that serves it. Hash routing and a single `/dashboard/app.js` bundle belonged to `host.ts` and `src/dashboard/web/`, which are not in this checkout.
