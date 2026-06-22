# PRD-037c: Shared page layout + route registry

> **Parent:** [PRD-037 Dashboard Nav Shell](./prd-037-dashboard-nav-shell-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Overview

The contract that makes the shell extensible. This sub-PRD defines (a) the shared **page-frame** every routed page
reuses — eyebrow + title, content max-width, and the standard wire-client hydration/polling pattern — and (b) the
single **route registry** that maps each route to its page component and nav presentation. With these two pieces in
place, adding a page (PRDs 038-044) is one registry entry plus a page component that drops into the page-frame; no
plumbing, no sidebar edits, no router edits. The registry is the single seam the downstream PRDs plug into.

## Goals

- Define a shared `<PageFrame>` (eyebrow + title + content body at a capped max-width, D-8) so every page looks and
  lays out consistently and pages carry no chrome of their own.
- Define the standard data-hydration/polling pattern a page reuses from the existing wire client (`wire.ts`
  `createWireClient`): fetch-on-mount + interval poll + cleanup-on-unmount, so each page hydrates the same way the
  current `app.tsx` does today (app.tsx lines 249-330).
- Define ONE route registry: an ordered list of `{ route, label, icon, component, dynamic? }` entries that BOTH the
  sidebar (037a) and the router outlet (037b) read.
- Mark which entries are STATIC top-level routes vs DYNAMICALLY-LOADED (per-install) entries, and define how a
  dynamic group (e.g. per-installed-harness items under Harnesses) is declared and resolved.
- Document the registry as the published contract PRDs 038-044 add a page against.

## Non-Goals

- The sidebar markup (037a) and the routing mechanism (037b) — this sub-PRD defines the data they consume.
- Any page's actual content (038-044). 037c ships the page-frame + registry + empty placeholder components only.
- A plugin/loading system beyond a `dynamic` resolver hook. "Dynamically loaded" here means "registry entries
  computed from live install state at render", not lazy code-splitting/bundle-splitting (the bundle stays one file).

## User Stories

- As a downstream PRD author (038-044), I want to add my page by writing one component and one registry entry, with
  the nav item and route appearing automatically.
- As a page author, I want a ready-made page-frame (title/eyebrow/max-width) and a copy-paste hydration pattern so I
  write content, not plumbing.
- As the Harnesses-page author (PRD-039), I want to declare a DYNAMIC group so per-installed-harness items appear
  based on what is actually installed, without the registry hard-coding six harnesses.

## Implementation Notes

- **New module:** `src/dashboard/web/registry.tsx` (or `routes.ts`) exporting the `RouteEntry` type and the
  `ROUTES` array.
  - `RouteEntry`: `{ route: string; label: string; icon: React.ReactNode; component: React.ComponentType<PageProps>;
    dynamic?: DynamicGroup }`.
  - `ROUTES` seeds the seven static entries in nav order: Dashboard (`/`), Harnesses (`/harnesses`), Memories
    (`/memories`), Graph (`/graph`), Sync (`/sync`), Logs (`/logs`), Settings (`/settings`).
  - A `matchRoute(hash)` helper resolves a hash to an entry, defaulting to the Dashboard entry on no match (feeds
    037b AC-4).
- **`<PageFrame>` (`src/dashboard/web/page-frame.tsx`):** mirrors the `Panel` header rhythm (panels.tsx lines 34-55)
  but at PAGE scale — a title (`--text-base`+, `--text-primary`, `letterSpacing: -0.01em`) + an optional mono
  eyebrow (`--font-mono`, `--text-tertiary`), then a content slot capped at the readable max-width (preserve the
  current `.wrap` 1180px cap from host.ts, D-8). Background transparent (the canvas `--bg-canvas` shows through);
  panels inside keep their own `--bg-surface`.
- **`PageProps` (the page contract):** what the outlet passes every page — the shared `wire` client (so pages do not
  each call `createWireClient`), the `daemonUp` flag (pages render content only when up; the shell owns the down
  state per 037b D-5), and the `assetBase`.
- **Hydration pattern (documented + a helper):** a small `usePoll(fn, ms)` or a documented recipe replicating
  app.tsx's mount-fetch + `setInterval` + cleanup (lines 296-330), so Logs polls `/api/logs`, Memories POSTs
  `/api/memories/recall`, Graph reads `wire.graph()`, etc., all the same way. The wire client is unchanged and reused.
- **Static vs dynamic (the parent's explicit ask):**
  - STATIC entries are the seven fixed top-level routes — always present, hard-listed in `ROUTES`.
  - A DYNAMIC entry carries a `dynamic: { resolve: (live) => SubItem[] }` resolver. The Harnesses entry (PRD-039)
    uses this so the per-harness sub-items (Claude Code, Codex, Cursor, Hermes, pi, OpenClaw) are computed from live
    install state at render rather than hard-coded — a registry entry whose CHILDREN come from data. The registry
    DEFINES this contract; the live data source is PRD-039's call (parent OQ-3).
- **Documentation deliverable:** a short "how to add a dashboard page" note (in the module doc-comment and/or
  `library/knowledge/private/dashboard/`) showing the one-entry + one-component recipe, referenced by 038-044.

## Acceptance Criteria

- [ ] **AC-1** — `<PageFrame>` renders an optional eyebrow + a title + a content body capped at the preserved
  readable max-width (≈1180px), using only existing DS tokens; a page using it carries no header chrome of its own.
- [ ] **AC-2** — `ROUTES` lists the seven static entries in nav order, each with `route`, `label`, `icon`, and
  `component`; the sidebar (037a) and outlet (037b) both consume this single source.
- [ ] **AC-3** — `matchRoute(hash)` resolves each of the seven hashes to its entry and an unknown hash to the
  Dashboard entry; unit-tested.
- [ ] **AC-4** — The documented hydration pattern (or `usePoll` helper) lets a page fetch-on-mount + poll + clean up
  on unmount, reusing the existing `wire` client without re-creating it; a placeholder page proves it polls and
  stops.
- [ ] **AC-5** — The registry supports a `dynamic` entry: a test registers a dynamic group whose `resolve` returns N
  sub-items and proves the sidebar renders those N items under the parent, distinct from the static entries.
- [ ] **AC-6** — Adding a page is ONE registry entry + one component: a throwaway entry added in a test appears in
  the nav AND routes to its component WITHOUT touching `sidebar.tsx` or `router.tsx` (proves the seam PRDs 038-044
  rely on).
- [ ] **AC-7** — The "how to add a page" contract is documented (module doc-comment + a knowledge-base note) and
  references PRDs 038-044 as the consumers.

## Open Questions

- **OQ-1** — Should `RouteEntry.icon` be an inline-SVG `ReactNode` (consistent with the panels' inline-SVG style) or
  a named key into a small icon map? Proposed: `ReactNode` to avoid an icon registry.
- **OQ-2** — Per-route document title from `label` (parent OQ-2): set `document.title = `honeycomb · ${label}`` in
  the outlet on route change? Cheap; proposed yes.
- **OQ-3** — Where does the "how to add a page" doc live — the registry module doc-comment, a
  `library/knowledge/private/dashboard/adding-a-page.md`, or both? Proposed: both (code-near + discoverable).
