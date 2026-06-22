# PRD-037a: Left-hand navigation component

> **Parent:** [PRD-037 Dashboard Nav Shell](./prd-037-dashboard-nav-shell-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Overview

The brand-appropriate left sidebar that anchors the multi-page dashboard. It carries the honeycomb mark + wordmark
at the top, a vertical list of the seven nav items, an active-route highlight, the relocated daemon-health pill, and
collapsible/responsive behavior. It is a pure presentational + nav component: it reads the route registry (037c) for
its items and the current route (037b) for its highlight, and emits navigation intent. It introduces NO new design
system — every visual value is an existing `var(--…)` token already served in `/dashboard/styles.css`, exactly as
the ported primitives in `src/dashboard/web/primitives.tsx` use them.

## Goals

- Render a vertical left sidebar with the honeycomb mark + `honeycomb` wordmark at top (the same mark the host
  serves at `/dashboard/honeycomb-mark.svg`, the same wordmark treatment as the current `Header`).
- Render all seven nav items (Dashboard, Harnesses, Memories, Graph, Sync, Logs, Settings) from the route registry,
  each with an icon + label.
- Highlight the nav item matching the active route with the honey accent; leave the others in the resting state.
- Relocate the daemon-health pill into the sidebar (footer slot) so it is visible on every route.
- Support a collapsed / responsive state (icon rail at narrow widths) without losing the highlight or the pill.

## Non-Goals

- Owning the route table or the page components (that is 037c's registry and the downstream page PRDs).
- Owning the routing mechanism itself — the `hashchange` listener and the content outlet are 037b. The sidebar only
  reads "what's the active route" and calls "navigate to route X".
- Any new token, color, font, or icon system. Icons come from the existing inline-SVG style the panels already use
  (e.g. the graph canvas's inline SVG); no icon-font dependency.

## User Stories

- As a local dogfooder, I want a persistent left nav so I can jump straight to Graph or Logs instead of scrolling a
  single long page.
- As a user, I want the current page obviously highlighted so I always know where I am.
- As a user on a narrow window, I want the sidebar to collapse to an icon rail so the content keeps its width.
- As a user, I want the daemon-health pill visible at all times, not buried in a page header.

## Implementation Notes

- **New module:** `src/dashboard/web/sidebar.tsx` exporting `<Sidebar>`. Props: the registry's nav entries
  (`{ route, label, icon }[]` from 037c), the `activeRoute` (from 037b's `useHashRoute`), an `onNavigate(route)`
  callback, the `daemonUp` boolean + health label, and a `collapsed` flag.
- **Brand chrome (mirrors the current `Header` in `app.tsx` lines 66-108):**
  - Mark: `<img src={`${assetBase}/honeycomb-mark.svg`} width={34} height={34} alt="" />`.
  - Wordmark: `honeycomb` at `fontWeight: 700, fontSize: 19, letterSpacing: "-0.03em", color: var(--text-primary)`,
    with the org/workspace mono sub-line (`--font-mono`, `--text-tertiary`) beneath it.
- **Nav item resting style:** `--font-mono` label (or `--font-sans` per brand check, OQ-1), `--text-secondary`
  color, transparent background, `--radius-md`, `padding` matching the panel header rhythm.
- **Active-route highlight (D-3):** background `--honey-subtle`, left-edge or text accent `--honey`, border
  `--honey-border` — the exact language `Badge tone="honey"` (primitives.tsx lines 144) and `Button
  variant="primary"` already speak. Transition `background var(--dur-fast) var(--ease-out)`, matching the Button
  hover transition.
- **Sidebar container:** `--bg-surface` background with a `--border-default` right edge, matching the `Panel` shell
  (panels.tsx lines 36-46). Fixed width gutter (e.g. ~220px expanded / ~56px collapsed rail).
- **Health pill (relocated, D-4):** the exact pill markup from `Header` (app.tsx lines 89-104) — a `--verified` dot
  when `daemonUp`, `--severity-critical` when offline, mono `daemon :3850` / `offline` label, on `--bg-elevated`
  with a `--border-default` border. Lives in a sidebar footer slot; in the collapsed rail it shows the dot only.
- **Collapse control (OQ-1):** a toggle button (ghost `Button` variant) that flips `collapsed`; the rail shows
  icon-only nav with the label as a `title` hover. Responsive: collapse automatically under a narrow breakpoint
  (mirror the `@media (max-width: 900px)` rule the layout CSS already uses in host.ts).
- **Reuse, do not fork:** compose the existing `Button` primitive for the collapse toggle and the existing `Badge`
  for any count chips; do not hand-roll new buttons.

## Acceptance Criteria

- [ ] **AC-1** — The sidebar renders the honeycomb mark + `honeycomb` wordmark + the org/workspace sub-line at the
  top, using the existing mark asset and the current `Header`'s exact type treatment.
- [ ] **AC-2** — All seven nav items render from the registry (Dashboard, Harnesses, Memories, Graph, Sync, Logs,
  Settings), each with an icon and a label, in registry order.
- [ ] **AC-3** — The nav item matching `activeRoute` is highlighted with the honey accent
  (`--honey` / `--honey-subtle` / `--honey-border`); no other item is highlighted. A unit/DOM test asserts exactly
  one active item for a given route.
- [ ] **AC-4** — Clicking a nav item calls `onNavigate(route)` with that item's route and changes nothing else
  (the sidebar does not itself mutate `location.hash` — that is 037b's job, kept testable).
- [ ] **AC-5** — The daemon-health pill renders in the sidebar footer with the live `daemonUp` state (green
  `--verified` dot up / `--severity-critical` offline + mono label), visible regardless of active route.
- [ ] **AC-6** — Collapsed/responsive: toggling `collapsed` (and a narrow viewport) renders an icon-only rail; the
  active highlight and the health dot survive the collapsed state; expanding restores labels.
- [ ] **AC-7** — Every color/spacing/font value is an existing `var(--…)` token; no new token is introduced. The
  component matches the honeycomb dark theme by construction.

## Open Questions

- **OQ-1** — Mono vs sans for nav labels, and icon-rail vs hamburger at narrow widths (inherited from parent OQ-1).
- **OQ-2** — Does the wordmark sub-line (org/workspace) belong at the TOP under the mark, or in the footer next to
  the health pill? Proposed: top, mirroring the current Header grouping.
