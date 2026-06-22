# PRD-037b: Client-side router + app-shell split

> **Parent:** [PRD-037 Dashboard Nav Shell](./prd-037-dashboard-nav-shell-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** L

## Overview

The routing engine and the app-shell refactor. This sub-PRD introduces a lightweight client-side router and
restructures `src/dashboard/web/app.tsx` from one monolithic page into an app SHELL — sidebar (037a) plus a content
outlet that mounts the active page's component. Each of the seven destinations becomes a routed view; the current
monolithic content is lifted as-is onto the Dashboard route (D-6), to be reorganized later by PRD-038. The
shell-level `/health` poll and the daemon-down ConnectivityBanner swap move up from the page into the shell.

## The routing decision (D-1: hash, not History API)

The dashboard is served as static assets by `src/daemon/runtime/dashboard/host.ts`, which registers exactly four GET
routes: the shell at `/dashboard`, the bundle at `/dashboard/app.js`, the CSS at `/dashboard/styles.css`, and the
mark at `/dashboard/honeycomb-mark.svg`. There is no catch-all.

- **History API (pushState) routing** would put real paths in the URL (`/dashboard/graph`). A refresh or a deep link
  to `/dashboard/graph` would hit the daemon, which has no route for that path → 404. Making it work would require
  the host to serve the shell for every `/dashboard/*` path (a server-side catch-all) — a new daemon route, which
  the parent PRD's non-goals forbid.
- **Hash routing** puts the route in the fragment (`/dashboard#/graph`). The browser never sends the fragment to the
  server, so the daemon always serves the same shell at `/dashboard` and the client resolves the route from
  `location.hash`. Refresh-safe deep links, ZERO host changes.

For a local, single-origin, static-asset-served dashboard, **hash routing wins**. This is the justification the
parent PRD asks for: hash avoids server route config the daemon host deliberately does not have.

## Goals

- Provide a tiny in-repo routing primitive (`useHashRoute`) that reads `location.hash`, listens for `hashchange`,
  and exposes the active route + a `navigate(route)` helper — no `react-router`, no new dependency (D-2).
- Refactor `app.tsx` into `<Shell>`: sidebar + content `<Outlet>` that renders the registry-matched page component
  for the active route.
- Move the current monolithic content (KPIs, health strip, recall, cards, 2-col grid, live log) verbatim into a
  `DashboardPage` component bound to the `#/` route (D-6 lift-and-shift, no content change).
- Lift the `/health` poll + the daemon-down view swap (PRD-024 AC-5) UP to the shell so it is route-independent.
- Default unknown/empty routes to the Dashboard route (no blank screen).

## Non-Goals

- The sidebar's markup/brand (037a) and the registry/page-frame contract (037c).
- Reorganizing the Dashboard page content — that is PRD-038. This PRD only relocates the existing content unchanged.
- Building the other six pages' content (039-044). 037b stands up routed mounts; the pages arrive empty-framed from
  037c and are filled by their own PRDs.
- History-API routing or any new daemon route (explicitly rejected in D-1).

## User Stories

- As a user, I want clicking a nav item to switch the page instantly without a full reload.
- As a user, I want to bookmark `/dashboard#/logs` and have a refresh land me back on Logs.
- As a user, I want a stale/garbage hash to drop me on the Dashboard, never a blank page.
- As a user, I want the daemon-down banner to appear no matter which page I'm on, and the page to come back on
  reconnect.

## Implementation Notes

- **New module:** `src/dashboard/web/router.tsx` exporting `useHashRoute()` → `{ route, navigate }`.
  - `route` derives from `location.hash` (strip the leading `#`, default `/` when empty/unknown-after-registry-match).
  - `navigate(route)` sets `location.hash = route` (the `hashchange` listener then re-renders) — keeping mutation in
    one place so 037a's `onNavigate` stays a thin pass-through.
  - Subscribe to `window` `hashchange` in a `useEffect`; clean up on unmount (mirror the poll-cleanup pattern in
    `app.tsx` lines 296-330).
- **Shell refactor (`app.tsx` → `<Shell>`):**
  - Hoist the existing `daemonUp` / `healthReasons` state and the `/health` poll (app.tsx lines 312-330) into the
    Shell. The daemon-down branch (app.tsx lines 369-387) becomes a CONTENT-region swap: sidebar stays mounted, the
    outlet renders `ConnectivityBanner`; on `Retry`/reconnect the active page restores (D-5).
  - The Shell renders `<Sidebar … />` (037a) beside an `<Outlet route={route} />` that looks up the registry (037c)
    and renders the matched page component. Layout: a flex/grid with the sidebar gutter + the content max-width (037c
    D-8).
  - The "Dream now" action + the org/workspace identity move with the old `Header` into the shell chrome (D-5);
    `DashboardPage` no longer renders its own header.
- **`DashboardPage` (the lift-and-shift, D-6):** a new `src/dashboard/web/pages/dashboard.tsx` holding the CURRENT
  `app.tsx` body (KPI row → health strip → recall bar → cards → `grid2` → live log) verbatim, hydrating from the same
  `createWireClient()` it does today (`wire.ts`). No content change — only the wrapper moves.
- **`main.tsx` (entry):** unchanged contract — still mounts into `#root` with the `data-asset-base` attribute
  (main.tsx lines 20-29), but now renders `<Shell>` instead of `<App>`. The esbuild entry and the host shell HTML
  (`host.ts`) are untouched (still one bundle, still `/dashboard/app.js`).
- **Empty-frame the other six routes:** `#/harnesses`, `#/memories`, `#/graph`, `#/sync`, `#/logs`, `#/settings`
  each resolve to a placeholder page component (a shared page-frame with an "coming soon / owned by PRD-0XX" note)
  so the routes are live and testable before 039-044 fill them.

## Acceptance Criteria

- [ ] **AC-1** — `useHashRoute()` returns the route parsed from `location.hash` and re-renders on `hashchange`;
  `navigate(r)` updates the hash. Unit-tested with a simulated `hashchange`.
- [ ] **AC-2** — Clicking a nav item swaps the content outlet to that page's component with NO full reload (the
  document is not re-requested; React swaps the subtree). Proven by a DOM test asserting the outlet content changed
  and the document did not reload.
- [ ] **AC-3** — Deep-linking: loading `/dashboard#/graph` (and each other route) mounts that route's page; a unit
  test sets `location.hash` before mount and asserts the matching page renders.
- [ ] **AC-4** — An unknown hash (e.g. `#/nope`) falls back to the Dashboard route; no blank screen.
- [ ] **AC-5** — `DashboardPage` renders the current monolithic content intact (KPIs, health strip, recall, cards,
  2-col grid, live log) with no regression versus today's `app.tsx` — proven by porting the existing dashboard DOM
  test onto the Dashboard route.
- [ ] **AC-6** — The `/health` poll + daemon-down swap live at the Shell: when the daemon is unreachable the content
  outlet shows `ConnectivityBanner` on ANY active route while the sidebar stays mounted; `Retry`/reconnect restores
  the active page and re-hydrates. Proven by toggling the mocked health result.
- [ ] **AC-7** — No new daemon route and no new dependency are introduced; `app.js` is still the single bundle the
  host serves; `npm run ci` / `build` green.

## Open Questions

- **OQ-1** — Should the Shell suspend page polling (logs/recall) entirely while daemon-down, or just hide the
  content? Proposed: suspend (mirror the current behavior where the whole view is replaced).
- **OQ-2** — Route string convention: `#/graph` vs `#graph`. Proposed `#/<route>` (leading slash) so it reads like a
  path and the registry keys are path-like for 037c.
