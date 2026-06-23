# PRD-037: Dashboard Nav Shell (the multi-page app shell)

> **Status:** Backlog
> **Priority:** P1
> **Effort:** L
> **Owner:** `/the-smoker`

## Overview

Today the live, daemon-served `GET /dashboard` is a SINGLE long-scrolling page. `src/dashboard/web/app.tsx`
renders the whole product on one canvas: header → KPI row → subsystem health strip → recall bar → recalled-memory
cards → 2-col grid (Sessions/Rules | Graph/Settings/Skill-sync) → live log → connectivity banner. Every concern is
stacked vertically inside one 1180px `.wrap`, so seeing rules means scrolling past KPIs, and seeing the graph means
scrolling past sessions. There is no way to deep-link a concern, and the page only grows as PRDs 038-044 add surface.

This PRD turns that single page into a mini multi-page website: a brand-appropriate **left-hand navigation shell**
that hosts seven routed pages, each its own concern, with far less scrolling. The honeycomb mark + wordmark anchor
the top of a vertical sidebar; nav items (Dashboard, Harnesses, Memories, Graph, Sync, Logs, Settings) switch the
content region without a full reload; the active route is highlighted; the daemon-health pill relocates into the
shell chrome; and deep-linking to any route works.

This PRD owns ONLY the shell — the sidebar, the client-side router, the app-shell split, the shared page frame, and
the route registry. It does NOT own any page's content. Each of the seven destinations is its own downstream PRD
(038-044). The current monolithic `app.tsx` content moves wholesale onto the **Dashboard** route as-is initially;
PRD-038 then reorganizes that home page, and PRDs 039-044 build out the other six pages as registry entries.

All of this reuses the EXISTING Honeycomb design system — the `var(--…)` tokens in the served `/dashboard/styles.css`
(`--honey`, `--honey-on`, `--honey-subtle`, `--bg-canvas`, `--bg-surface`, `--bg-elevated`, `--bg-subtle`,
`--text-primary/secondary/tertiary`, `--border-default/subtle/strong`, `--font-mono`, `--font-sans`, `--radius-*`,
`--dur-fast`, `--ease-out`, `--verified`, `--severity-critical`) and the ported primitives in
`src/dashboard/web/primitives.tsx`. No new design system, no new color ramp, no CDN React, no in-browser Babel —
the shell is bundled production-clean by the same esbuild entry that builds the current app (D-1 of PRD-024 holds).

## Goals

- Replace the single-scroll `/dashboard` with a left-nav app shell that hosts seven routed pages, sharply reducing
  scrolling per concern.
- Ship a brand-appropriate vertical sidebar (honeycomb mark + wordmark, seven nav items, active-route highlight,
  relocated daemon-health pill, collapsible/responsive) built ONLY from existing DS tokens and primitives.
- Introduce lightweight client-side routing so navigating swaps the content region with no full reload, and
  deep-linking / refresh on any route lands on that route.
- Refactor `app.tsx` into a thin app SHELL (sidebar + content outlet) that mounts the active page component, with
  the current monolithic content moved as-is onto the Dashboard route.
- Preserve the daemon-down ConnectivityBanner behavior at the SHELL level (shell-wide, not per-page).
- Define a single route registry + shared page-frame contract so PRDs 038-044 each add a page by adding one registry
  entry, including the distinction between static pages and dynamically-loaded (per-install) entries.

## Non-Goals

- Building or reorganizing any page's CONTENT. The Dashboard home reorg is PRD-038; the other six pages are PRDs
  039-044. This PRD moves the existing content onto the Dashboard route unchanged and stands up the empty frames for
  the rest.
- Introducing a routing framework or a new build/bundling story. Routing is a lightweight in-repo primitive bundled
  by the existing esbuild entry — no react-router dependency, no new toolchain.
- Any new design system, token, font, or color. The shell composes the existing DS only.
- Server-side routing or new daemon routes. `/dashboard` stays a static-asset shell served by
  `src/daemon/runtime/dashboard/host.ts`; routing is entirely client-side (see D-1 below).
- Changing the daemon's data endpoints, the wire client (`src/dashboard/web/wire.ts`), or the LOCAL-MODE-ONLY +
  XSS-safe + no-secret-in-page security posture (PRD-021d F-1 / PRD-024 D-4). The shell inherits all of it.
- The Cursor extension webview (`harnesses/cursor/extension/`). A possible fast-follow; not in scope here.

## Features

| Sub-PRD | Feature | Status |
|---|---|---|
| [prd-037a-dashboard-nav-shell-sidebar](./prd-037a-dashboard-nav-shell-sidebar.md) | Left-hand navigation component | Draft |
| [prd-037b-dashboard-nav-shell-router](./prd-037b-dashboard-nav-shell-router.md) | Client-side router + app-shell split | Draft |
| [prd-037c-dashboard-nav-shell-registry](./prd-037c-dashboard-nav-shell-registry.md) | Shared page layout + route registry | Draft |

## The seven destinations this shell hosts (each is its own downstream PRD)

This shell is the FOUNDATION for the multi-page dashboard. It owns the nav slot, the route, the registry entry, and
the empty page frame for each destination below — but NOT the page's content, which is the cross-referenced PRD's job.

| # | Nav label | Route (hash) | Content owner | Notes |
|---|---|---|---|---|
| 1 | Dashboard | `#/` (default) | **PRD-038** | The current monolithic `app.tsx` content moves here as-is, then PRD-038 reorganizes it into the home page. |
| 2 | Harnesses | `#/harnesses` | **PRD-039** | Per-harness items may be **dynamically loaded** based on what is installed (Claude Code, Codex, Cursor, Hermes, pi, OpenClaw). |
| 3 | Memories | `#/memories` | **PRD-040** | Recall bar + recalled-memory cards page. |
| 4 | Graph | `#/graph` | **PRD-041** | The codebase-graph canvas as a full page. |
| 5 | Sync | `#/sync` | **PRD-042** | Skill-sync / propagation page. |
| 6 | Logs | `#/logs` | **PRD-043** | The live-log stream as a full page. |
| 7 | Settings | `#/settings` | **PRD-044** | Provider · model · pollinating · vault key-presence. |

## Acceptance Criteria

- [ ] **AC-1 — Seven destinations render.** `GET /dashboard` renders the left-nav shell with all seven nav items
  (Dashboard, Harnesses, Memories, Graph, Sync, Logs, Settings) on the honeycomb dark theme, built only from existing
  DS tokens/primitives. Served production-clean (no CDN React / no in-browser Babel) by the existing esbuild entry.
- [ ] **AC-2 — Active-route highlight.** The nav item matching the current route is visually highlighted (honey
  accent per D-3) and the others are not; switching routes moves the highlight.
- [ ] **AC-3 — Client-side navigation, no reload.** Clicking a nav item swaps the content region to that page's
  component WITHOUT a full page reload; the daemon is not re-fetched for the shell itself.
- [ ] **AC-4 — Deep-linking works.** Loading or refreshing `/dashboard#/graph` (and every other route) lands on that
  page; an unknown route falls back to the Dashboard route (no blank screen).
- [ ] **AC-5 — Dashboard parity preserved.** The current monolithic content (KPIs, health strip, recall, cards,
  2-col grid, live log) renders intact on the Dashboard route — no regression versus today's single page.
- [ ] **AC-6 — Daemon-down banner at the shell.** When `/health` is unreachable the ConnectivityBanner replaces the
  CONTENT region (shell + sidebar remain) regardless of the active route; on reconnect the active page restores.
- [ ] **AC-7 — Registry contract is documented + plug-in proven.** A single route registry maps route → page
  component → nav label/icon, marks each entry static vs dynamically-loaded, and is documented so PRDs 038-044 add a
  page by adding one entry. A test adds a throwaway registry entry and proves it appears in the nav + routes.
- [ ] **AC-8 — Collapsible / responsive.** The sidebar collapses (and/or is responsive at narrow widths) without
  breaking the content region; the active highlight and daemon-health pill survive the collapsed state.
- [ ] **AC-9 — Security + gate unchanged.** Shell stays LOCAL-MODE-ONLY + XSS-safe; no token/secret in the served
  page, route, or registry. A DOM/unit test asserts the shell structure; `npm run ci` / `build` / invariant all green.

## Decisions

- **D-1 — Hash routing, not History API.** The dashboard is served as static assets by the daemon host
  (`src/daemon/runtime/dashboard/host.ts` registers exactly four GET routes: the shell, `app.js`, `styles.css`, the
  mark). History-API (pushState) routing would require the host to serve the shell for every `/dashboard/*` deep path
  so a refresh on `/dashboard/graph` does not 404 — i.e. a server-side catch-all route. Hash routing
  (`/dashboard#/graph`) needs ZERO server route config: the daemon always serves the same shell at `/dashboard`, and
  the fragment is client-only. Given the no-new-daemon-routes non-goal and the local single-origin target, **hash
  routing wins**: refresh-safe deep links with no host changes.
- **D-2 — Lightweight in-repo router, no framework.** Routing is a small bundled primitive (a `useHashRoute` hook
  reading `location.hash` + a `hashchange` listener, plus a `<Sidebar>` and a content `<Outlet>` that renders the
  registry-matched component). No `react-router` / no new dependency — consistent with the production-clean esbuild
  posture and the repo's lean-deps discipline.
- **D-3 — On-brand sidebar from existing tokens.** The sidebar uses the SAME tokens the rest of the dashboard uses:
  `--bg-surface`/`--bg-elevated` panel background, `--border-subtle`/`--border-default` separators, `--font-sans`
  wordmark + `--font-mono` route labels, and the **honey** accent (`--honey` / `--honey-subtle` / `--honey-border`)
  for the active-route highlight — exactly the language `Badge tone="honey"` and the `Button variant="primary"`
  already speak. The honeycomb mark is the existing `/dashboard/honeycomb-mark.svg` the host serves.
- **D-4 — Daemon-health pill relocates into the sidebar footer.** The health pill currently lives in the page
  `Header`. In the shell there is no per-page header, so the pill moves into the sidebar (footer/bottom slot), where
  it stays visible on every route. It keeps its exact contract (green `--verified` dot when up, `--severity-critical`
  when offline, mono `daemon :3850` / `offline` label) and renders subsystem STATE only — no token/secret (D-9).
- **D-5 — Shell owns connectivity, pages do not.** The `/health` poll and the daemon-down view-swap move UP to the
  shell. A page component never re-implements the banner; when the daemon is down the shell swaps the content outlet
  for the ConnectivityBanner and suspends page hydration, then restores the active page on reconnect (PRD-024 AC-5
  semantics, now shell-level). The "Pollinate now" action relocates with the Header into the shell chrome.
- **D-6 — Move-then-reorganize, not rewrite.** 037 moves the CURRENT `app.tsx` body onto the Dashboard page
  component verbatim (a lift-and-shift) so the shell ships with zero content regression. The reorg of that home page
  is explicitly PRD-038's job; 037 must not change what the Dashboard page renders, only WHERE it renders.
- **D-7 — Registry is the single extension point.** Adding a page (PRDs 038-044) is ONE registry entry: `{ route,
  label, icon, component, dynamic? }`. The sidebar maps the registry to nav items; the outlet maps the active route
  to a component. Pages reuse a shared page-frame (eyebrow + title + content max-width + the existing wire-client
  hydration/polling pattern) so a new page is content, not plumbing. Dynamic entries (e.g. per-installed-harness
  items under Harnesses) are marked `dynamic` and resolved at render from live data, distinct from the seven static
  top-level routes.
- **D-8 — Content max-width preserved.** The current `.wrap` caps content at 1180px. In the shell, the sidebar takes
  a fixed gutter and the content outlet keeps a comparable readable max-width so pages do not sprawl on wide
  monitors; this lives in the shared page-frame (037c), not per page.
- **D-9 — Security posture inherited, unchanged.** The shell is still served only in `mode === "local"`, still
  XSS-safe, and still carries NO token/secret in the shell HTML, the route fragment, the registry, or the relocated
  health pill. Nothing in this PRD adds a data endpoint or a secret to the page. `audit:openclaw` / `audit:sql` stay
  green by construction (no new daemon surface).

## Open Questions

- **OQ-1** — Should the collapsed sidebar show icon-only nav (rail) or fully hide behind a hamburger at narrow
  widths? (037a proposes an icon rail; confirm against the brand before build.)
- **OQ-2** — Do we want per-route browser-tab titles (e.g. `honeycomb · Graph`) driven by the registry `label`? Cheap
  and nice for deep links; flagged for 037c.
- **OQ-3** — The Harnesses page (PRD-039) wants dynamically-loaded per-harness items. Does the dynamic registry
  resolve those from an existing live endpoint, or does PRD-039 add one? (037c defines the registry CONTRACT for
  dynamic entries; the data source is PRD-039's call.)
- **OQ-4** — Should "Pollinate now" stay a global action in the shell chrome (always available), or move onto a specific
  page? D-5 keeps it global for now; revisit when PRD-038 reorganizes the Dashboard home.

## Related

- **Prior art / house style:** PRD-024 Dashboard UI Parity — `library/requirements/in-work/prd-024-dashboard-ui-parity/prd-024-dashboard-ui-parity-index.md` (the live brand dashboard this shell wraps; D-1 production-clean bundle, D-4 security, AC-5 connectivity).
- **Downstream routed-page PRDs (this shell hosts them):** PRD-038 (Dashboard home), PRD-039 (Harnesses), PRD-040 (Memories), PRD-041 (Graph), PRD-042 (Sync), PRD-043 (Logs), PRD-044 (Settings).
- **Source touched:** `src/dashboard/web/app.tsx` (split into shell + Dashboard page), `src/dashboard/web/main.tsx` (mount entry), `src/dashboard/web/panels.tsx` + `src/dashboard/web/primitives.tsx` (reused), `src/dashboard/web/wire.ts` (reused hydration), `src/daemon/runtime/dashboard/host.ts` (the served shell — unchanged routing, hash-only).
