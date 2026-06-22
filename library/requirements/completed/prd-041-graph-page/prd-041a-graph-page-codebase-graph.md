# PRD-041a — Full-page interactive codebase graph

> **Status:** Backlog
> **Priority:** P2
> **Effort:** L
> Parent: [PRD-041 — Graph Page](./prd-041-graph-page-index.md)

## Overview

The dashboard's codebase graph lives as a thumbnail. `GraphCanvas` in `src/dashboard/web/panels.tsx` draws into
a fixed `viewBox="0 0 540 200"` SVG box inside the home page's 2-col grid. Even after PRD-035c corrects its
render (deletes the hardcoded `NODE_POS` at `panels.tsx:232-239`, computes a real layout, renders all edges,
and makes nodes clickable), it is still a ~200px-tall mini-widget meant to glance at, not to explore.

The data deserves a real page. `fetchGraphView` (`src/daemon/runtime/dashboard/api.ts:206-218`) reads the
latest row of the `codebase` table, parses its `snapshot_jsonb` column (`parseSnapshot`, `api.ts:352-374`), and
returns a `GraphView` — `{ built, nodes: GraphNode[], edges: GraphEdge[] }` (`src/dashboard/contracts.ts:82-114`).
Node ids are real file paths / symbols (e.g. `src/daemon/server.ts`, a function name); edge kinds are
`imports` / `calls`. That graph is served at `GET /api/graph` and can hold far more than six nodes.

This sub-PRD builds the **full-viewport Graph page** that the PRD-037 nav shell mounts at `#/graph`: a real
interactive graph with force-directed / zoomable layout, pan and zoom, click-to-select with a node-detail
panel, node-kind filters, and search-to-node. It REUSES the PRD-035c-corrected `GraphCanvas` and the pure
`layout(...)` function 035c extracts (FR-8 of 035c: "The layout is a pure, exported function so PRD-041 can
reuse it") — it does not re-implement rendering or re-fix the bug. It honors the `built: false` empty state
with the `honeycomb graph build` prompt, exactly as the mini-widget does.

## Goals

- Render the full codebase graph from `GET /api/graph` (`GraphView`) on a full-viewport page at the nav shell's
  `#/graph` route, reusing the PRD-035c-corrected `GraphCanvas` and its extracted pure `layout(...)` function.
- Provide a real interactive layout: force-directed / deterministic-settle placement scaled to a large node
  set, with pan and zoom over the canvas.
- Make nodes selectable: clicking a node opens a detail panel showing its id/label, kind, and its neighbors
  split by relation (`imports` / `calls`, incoming and outgoing).
- Filter the graph by node kind (e.g. `file`, `function`, `class`) via on/off toggles driven by the kinds
  actually present in the snapshot.
- Search to a node by id/label and focus/select the match.
- Honor the `built: false` empty state full-page with the `honeycomb graph build` prompt — no error, no blank
  canvas.

## Non-Goals

- Re-fixing the `GraphCanvas` render (the hardcoded `NODE_POS`, edge rendering, node-click mechanics) or
  writing the layout algorithm from scratch — that is **PRD-035c**, whose corrected component + pure
  `layout(...)` export this page consumes. If 035c has not yet landed when this is built, coordinate so this
  page consumes the same shared component rather than forking it (see D-1).
- The nav shell, router, sidebar, registry, or `#/graph` route plumbing — that is **PRD-037**. This sub-PRD
  delivers the page COMPONENT that 037's registry entry mounts.
- Changing the data layer: `fetchGraphView` / `parseSnapshot` / the `codebase` table / `snapshot_jsonb` / the
  tree-sitter pipeline (PRD-014) / the `GraphView` / `GraphNode` / `GraphEdge` contracts. All consumed as-is.
- The memory graph, the Codebase ↔ Memory toggle, or any memory-graph view-model / endpoint — that is **041b**.
- Editing the graph (no node create/delete/move-persist), persisting layout, or writing back to the snapshot.
- Multi-snapshot history / diffing across snapshot versions (the page renders the latest snapshot
  `fetchGraphView` returns).

## User Story

As a developer with a built codebase graph, I open the Graph page and see my whole codebase laid out — every
file and symbol the snapshot holds, edges for imports and calls — and I can pan and zoom around it, filter to
just `function` nodes, search for `server.ts`, and click a node to see exactly what it imports, what calls it,
and what it connects to. Instead of squinting at a 200px thumbnail on the home page, I get a real map.

## Design Decisions

- **D-1 — Reuse the PRD-035c-corrected component + its pure `layout(...)`; do not fork.** PRD-035c removes the
  hardcoded `NODE_POS`, computes positions via a pure exported `layout(nodes, edges, viewBox) → Map<id,{x,y}>`,
  renders all edges, and makes nodes clickable (035c FR-8 + D-1). This page imports that component (or its
  extracted canvas/layout) and renders it full-viewport. Where the full page needs richer behavior than the
  mini-widget (pan/zoom, a large-set layout, a side detail panel), extend the SHARED component with props /
  variants rather than copy-pasting it — keep one canvas implementation. Coordinate the shared-component shape
  with whoever owns PRD-035c (035c's Implementation Notes explicitly ask for this).
- **D-2 — A real interactive layout, scaled to a full page.** The mini-widget can settle for a cheap
  deterministic radial/grid (035c OQ-1). The full page wants a genuine **force-directed** layout (or a
  fixed-iteration force pass that settles deterministically) sized to a large node set, rendered into a
  full-viewport canvas rather than a 540×200 box. Prefer reusing/parameterizing 035c's pure `layout(...)` with
  full-page dimensions and iteration budget; only if a force layout cannot be expressed through that seam does
  this page add its own layout module (still a pure function, still no continuously-running animation loop).
  See OQ-1.
- **D-3 — Pan and zoom over the canvas.** The user can pan (drag the background) and zoom (wheel / controls)
  the graph. Implement against the SVG/canvas viewBox transform (no graph framework dependency unless trivially
  small — consistent with PRD-037 D-2 and the repo's lean-deps discipline). Zoom is bounded; a "fit / reset
  view" affordance re-frames the whole graph. See OQ-2 on whether a small pan/zoom helper dependency is
  acceptable.
- **D-4 — Click-to-select drives a full detail panel.** Clicking a node selects it (035c already makes nodes
  clickable) and opens a side detail panel — the full-page replacement 035c anticipates for its compact
  in-panel detail block (035c OQ-3). The panel shows the node's `id`, `label`, `kind`, and its **neighbors**
  derived from `graph.edges`, split by relation and direction: outgoing `imports` / `calls` (edges where
  `from === id`) and incoming (edges where `to === id`). Honest caveat surfaced: per PRD-014d, cross-file
  `calls` resolve only for relative named/namespace imports, so an empty incoming list is NOT proof of dead
  code — the panel notes this (mirrors `query.ts` FR-11 / d-AC-6).
- **D-5 — Kind filters from the snapshot's real kinds.** The filter controls are derived from the distinct
  `node.kind` values actually present in the `GraphView` (not a hardcoded list), reusing the existing
  `KIND_COLOR` map (`panels.tsx:240`) for the legend swatches. Toggling a kind off hides its nodes (and edges
  incident only to hidden nodes); counts update. No kind is special-cased.
- **D-6 — Search-to-node.** A search input filters/locates nodes by `id` or `label` (case-insensitive
  substring). Selecting a result focuses + selects that node (pan/zoom to frame it, open its detail panel),
  reusing the same selection state as click. (A fuzzy fallback is out of scope here; the daemon's `graph/find`
  surface in `query.ts` already does ranked fuzzy match for the VFS — the page's search is a simpler in-memory
  filter over the loaded `GraphView`.)
- **D-7 — Empty state, full-page.** When `GraphView.built` is false, the page renders the same honest
  empty-state as the mini-widget — "No graph built for this workspace." + a `honeycomb graph build` prompt
  (`panels.tsx:249-258`) — sized for the full page, NOT an error and NOT a blank canvas.
- **D-8 — Production-clean + secure by construction.** The page bundles via the existing esbuild entry (no CDN
  React, no in-browser Babel — PRD-024 D-1, PRD-037 D-9). It reads only `GET /api/graph` over loopback through
  the existing wire client (`src/dashboard/web/wire.ts`); it adds NO new daemon route and carries NO
  token/secret in the page or the graph data. The graph holds file paths and symbol names only — no secrets —
  but rendering stays XSS-safe (labels are React text, never `dangerouslySetInnerHTML`).
- **D-9 — Reuse the connectivity contract; do not re-implement it.** When the daemon is down, the PRD-037 shell
  swaps the content outlet for the ConnectivityBanner at the SHELL level (037 D-5). This page does not
  re-implement a daemon-down banner; it simply renders the empty/loading state until its `GET /api/graph` fetch
  resolves, and relies on the shell for the daemon-down view-swap.

## Functional Requirements

- **FR-1** — The Graph page fetches `GET /api/graph` (the `GraphView`) via the existing wire client and renders
  it full-viewport at the nav shell's `#/graph` route.
- **FR-2** — When `GraphView.built` is true, every `graph.nodes` entry renders as a node and every
  `graph.edges` entry (with both endpoints present) renders as an edge, positioned by the reused/parameterized
  pure `layout(...)` (no node silently skipped for being absent from a hardcoded map).
- **FR-3** — The canvas supports pan (drag) and bounded zoom (wheel / controls) with a fit/reset-view
  affordance that re-frames the whole graph.
- **FR-4** — Clicking a node selects it and opens a detail panel showing `id`, `label`, `kind`, and its
  neighbors split by relation/direction (outgoing/incoming `imports` / `calls`), with the cross-file-`calls`
  caveat noted; clicking away / re-clicking clears the selection.
- **FR-5** — Node-kind filter controls are derived from the kinds present in the snapshot; toggling a kind
  hides its nodes (and edges incident only to hidden nodes) and updates the visible counts.
- **FR-6** — A search input locates a node by `id`/`label` (case-insensitive substring); selecting a result
  focuses + selects that node.
- **FR-7** — When `GraphView.built` is false, the page renders the `honeycomb graph build` empty-state prompt,
  full-page — not an error, not a blank canvas.
- **FR-8** — The page reuses the PRD-035c shared `GraphCanvas` / pure `layout(...)` (extended via props/variant
  for the full-page experience); it does NOT fork the canvas or re-implement the corrected render.
- **FR-9** — The page is bundled production-clean (existing esbuild entry; no CDN React / no in-browser Babel),
  adds no new daemon route, and carries no token/secret in the page or the graph data.

## Acceptance Criteria

- [ ] **AC-1** — Loading `/dashboard#/graph` against a daemon with a built graph renders the FULL codebase
      graph: all N nodes and all M edges of the served `GraphView` are drawn with a real interactive layout
      (not the 540×200 thumbnail), reusing the PRD-035c canvas + `layout(...)`.
- [ ] **AC-2** — Pan and zoom work: dragging the background pans, wheel/controls zoom within bounds, and a
      fit/reset affordance re-frames the whole graph.
- [ ] **AC-3** — Clicking a node opens a detail panel showing its `id`, `label`, `kind`, and neighbor lists
      split by `imports` / `calls` and incoming/outgoing that match the snapshot's edges; the
      cross-file-`calls` caveat is shown; clearing selection works.
- [ ] **AC-4** — Kind filters reflect the snapshot's real kinds; toggling a kind hides its nodes and the edges
      incident only to hidden nodes, and updates counts. Arbitrary-string node ids (real file paths / symbols)
      render correctly (no dependence on legacy hardcoded ids).
- [ ] **AC-5** — Searching by id/label locates and focuses/selects the matching node.
- [ ] **AC-6** — With `GraphView.built` false, the page shows the full-page `honeycomb graph build` empty-state
      (no error, no blank canvas).
- [ ] **AC-7** — Security + gate: the page is local-mode-only + XSS-safe, adds no daemon route, leaks no
      token/secret (grep-proven); a DOM/unit test drives the page with a fake built `GraphView` (arbitrary-id
      nodes/edges) asserting render-all, pan/zoom state, click-to-detail with correct neighbors, kind-filter,
      search-focus, and the empty-state path; `npm run ci` / `build` / `audit:sql` / `audit:openclaw` green.

## Open Questions

- **OQ-1 — Layout: parameterize 035c's pure `layout(...)` or add a full-page force module?** 035c recommends a
  deterministic radial/grid for the mini-widget (035c OQ-1). The full page wants force-directed for a large
  set. Default: extend/parameterize 035c's pure `layout(...)` with full-page dimensions + iteration budget if
  it can express a force pass; otherwise add a separate pure full-page layout module that the shared canvas
  accepts via prop. Decide jointly with the PRD-035c owner so there is ONE canvas, not two.
- **OQ-2 — Pan/zoom: hand-rolled viewBox transform vs a tiny helper dependency?** The repo prefers lean deps
  (PRD-037 D-2). A hand-rolled SVG viewBox pan/zoom is feasible and dependency-free; a small library is nicer
  for inertia/gestures. Default: hand-rolled, no new dependency, unless a trivially-small helper is justified.
- **OQ-3 — Large-graph performance.** Real codebase snapshots can be large. At what node/edge count does SVG
  rendering or the force layout need virtualization / canvas-2D fallback / a capped initial render with
  expand-on-demand? Default: ship SVG for the expected snapshot size, measure, and flag a follow-up if a real
  snapshot stutters — do not pre-optimize.
- **OQ-4 — Detail-panel placement + design.** A right-hand side panel vs an overlay drawer for node detail
  (035c OQ-3 anticipated the full page replacing its compact in-panel block). Default: a right-hand side panel
  that does not occlude the graph; confirm against the brand/DS.
- **OQ-5 — Does "search" need the daemon's ranked `graph/find`?** The daemon exposes a ranked fuzzy
  `graph/find/<pattern>` over the VFS (`src/daemon/runtime/codebase/query.ts`). This page's search is a simpler
  in-memory substring filter over the already-loaded `GraphView`. Confirm in-memory is sufficient for the page,
  or flag wiring to the daemon surface as a follow-up.

## Implementation Notes

- **Primary touch points:** the Graph page component mounted by the PRD-037 registry at `#/graph` (lives under
  `src/dashboard/web/`, alongside `app.tsx` and the other routed pages), reusing `GraphCanvas` + the pure
  `layout(...)` 035c exports from `src/dashboard/web/panels.tsx`, the `KIND_COLOR` map (`panels.tsx:240`) for
  the legend, and the wire client (`src/dashboard/web/wire.ts`) to fetch `GET /api/graph`.
- **Data is already correct + served:** `fetchGraphView` (`api.ts:206-218`) + `parseSnapshot`
  (`api.ts:352-374`) yield the real `GraphView`; `GET /api/graph` already serves it (`mountDashboardApi`,
  `api.ts:308-315`). No daemon edit, no contract change, no `server.ts` edit for 041a.
- **Sequencing:** depends on PRD-035c (the corrected, layout-extracted `GraphCanvas`) and PRD-037 (the
  `#/graph` route + registry entry). If built before 035c lands, coordinate to consume the same shared
  component rather than forking.
- **Neighbors** are derived purely from `graph.edges` in the loaded `GraphView` (no extra fetch): outgoing =
  edges with `from === id`, incoming = edges with `to === id`, grouped by `edge.kind`.
