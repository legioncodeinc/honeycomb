# PRD-041: Graph Page (the codebase graph, full-page — then the memory graph)

> **Status:** Backlog
> **Priority:** P2
> **Effort:** L
> **Owner:** `/the-smoker`

## Overview

The dashboard already shows the codebase graph as a tiny `GraphCanvas` widget tucked into the home page's
2-col grid (`src/dashboard/web/panels.tsx`). It is a thumbnail: a ~540×200 SVG box that, even once PRD-035c
fixes its render, can only hint at a real graph. The data behind it is real and rich — `fetchGraphView`
(`src/daemon/runtime/dashboard/api.ts`) reads the latest codebase snapshot from the `codebase` table's
`snapshot_jsonb` column (built by the PRD-014 tree-sitter pipeline under `src/daemon/runtime/codebase/`) and
hands back a full `GraphView` of `GraphNode[]` / `GraphEdge[]` (`src/dashboard/contracts.ts`). A thumbnail
cannot do that justice.

This PRD builds a dedicated, full-viewport **Graph page** — the `#/graph` route the PRD-037 nav shell already
reserves for it. The page renders the whole codebase graph with a real interactive layout: force-directed /
zoomable placement, pan and zoom, click-to-select with a detail panel (file/symbol, kind, neighbors,
imports/calls), filter by node kind, and search-to-node. It does NOT re-fix the render bug — PRD-035c corrects
the shared `GraphCanvas` (deletes the hardcoded `NODE_POS` map, computes a real layout, makes nodes clickable)
and extracts a pure `layout(...)` function; this PRD REUSES that corrected component and its layout helper and
builds the full-page experience on top.

The page is built to host more than one graph. The codebase graph ships first (sub-PRD 041a). The page then
grows to render the **memory graph** — the knowledge graph of memories and entities from the PRD-008 ontology
(entities, aspects, attributes, dependency edges, append-only supersession) — behind a Codebase ↔ Memory
toggle (sub-PRD 041b). 041b is honest about readiness: it lands the view-model + endpoint + toggle as the
foundation, and explicitly flags the parts that defer until the knowledge-graph data is populated and a
serving endpoint exists.

## Goals

- Ship a full-page, interactive **codebase graph** at the nav shell's `#/graph` route: real layout, pan/zoom,
  click-to-select node detail, kind filters, and search-to-node — reusing the PRD-035c-corrected `GraphCanvas`
  and its extracted pure `layout(...)` function rather than re-implementing rendering.
- Honor the `built: false` empty state on the full page with the `honeycomb graph build` prompt (no error, no
  blank canvas), exactly as the mini-widget does.
- Lay the foundation for a **memory graph** view on the same page: a documented memory/knowledge-graph
  view-model + a daemon endpoint to serve it, and a Codebase ↔ Memory graph-type toggle, with the same canvas
  rendering both — clearly marking which parts ship now versus defer until PRD-008 data is populated.

## Non-Goals

- Re-fixing the `GraphCanvas` render bug (the hardcoded `NODE_POS`), edge rendering, or node-click mechanics.
  That is **PRD-035c**; this PRD consumes the corrected component + its pure `layout(...)` export.
- Owning the nav shell, the client-side router, the route registry, or the sidebar. That is **PRD-037**; this
  PRD provides the Graph page COMPONENT that 037's `#/graph` registry entry mounts.
- Changing the codebase graph DATA layer — `fetchGraphView`, `parseSnapshot`, the `codebase` table /
  `snapshot_jsonb` column, the tree-sitter extraction pipeline (PRD-014), or the `GraphView` / `GraphNode` /
  `GraphEdge` contracts. The page consumes them as-is.
- Building the PRD-008 knowledge-graph ontology itself (entities, dependencies, supersession, the
  `/api/ontology/*` surface). 041b consumes that graph for visualization; it does not author it.
- New daemon data ENDPOINTS for the codebase graph — `GET /api/graph` already serves the `GraphView`. (041b
  may add ONE memory-graph read endpoint; see that sub-PRD.)
- Any change to the LOCAL-MODE-ONLY + XSS-safe + no-secret-in-page security posture (PRD-021d F-1 /
  PRD-024 D-4 / PRD-037 D-9). The page inherits it.

## Features

| Sub-PRD | Feature | Status |
|---|---|---|
| [prd-041a-graph-page-codebase-graph](./prd-041a-graph-page-codebase-graph.md) | Full-page interactive codebase graph (layout, pan/zoom, node detail, kind filters, search) | Draft |
| [prd-041b-graph-page-memory-graph](./prd-041b-graph-page-memory-graph.md) | Memory/knowledge graph view-model + endpoint + Codebase ↔ Memory toggle (foundation; deferred parts flagged) | Draft |

## Acceptance Criteria

- [ ] **AC-1 — Codebase graph page renders.** The `#/graph` route renders the full codebase graph from
  `GET /api/graph` (`GraphView`) with a real interactive layout, pan/zoom, clickable nodes with a detail panel
  (id/label, kind, neighbors, imports/calls), and node-kind filters — reusing the PRD-035c-corrected
  `GraphCanvas` + its pure `layout(...)` export. (041a)
- [ ] **AC-2 — Empty state honored full-page.** When `GraphView.built` is false, the page shows the
  `honeycomb graph build` prompt rather than an error or a blank canvas. (041a)
- [ ] **AC-3 — Memory graph foundation.** A documented memory/knowledge-graph view-model and a daemon endpoint
  to serve it exist, plus a Codebase ↔ Memory graph-type toggle on the page; the SAME canvas renders both
  graph types. Parts that defer until PRD-008 data is populated / served are explicitly flagged as deferred and
  captured as Open Questions. (041b)
- [ ] **AC-4 — Security + gate unchanged.** The page stays LOCAL-MODE-ONLY + XSS-safe with no token/secret in
  the page, the route fragment, or any graph data; `npm run ci` / `build` / `audit:sql` / `audit:openclaw` /
  invariant all green.

## Related

- **Hosts this page (the nav shell):** [PRD-037 — Dashboard Nav Shell](../prd-037-dashboard-nav-shell/prd-037-dashboard-nav-shell-index.md) — owns the `#/graph` route, the sidebar nav slot, and the registry entry this page plugs into.
- **Provides the corrected shared component:** [PRD-035c — Codebase-graph widget render + interactivity fix](../prd-035-dashboard-data-fixes/prd-035c-dashboard-data-fixes-graph-render-interactivity.md) — deletes the hardcoded `NODE_POS`, computes a real layout, makes nodes clickable, and exports a pure `layout(...)` this page reuses.
- **Builds the codebase graph data:** [PRD-014 — Codebase Graph](../../in-work/prd-014-codebase-graph/prd-014-codebase-graph-index.md) — the tree-sitter extraction → `codebase` table `snapshot_jsonb` the `GraphView` is read from.
- **Defines the memory/knowledge graph:** [PRD-008 — Knowledge Graph and Ontology](../../in-work/prd-008-knowledge-graph-ontology/prd-008-knowledge-graph-ontology-index.md) — the entities / aspects / attributes / dependency edges / supersession 041b visualizes.
- **House style / prior art:** [PRD-024 — Dashboard UI Parity](../../in-work/prd-024-dashboard-ui-parity/prd-024-dashboard-ui-parity-index.md) — production-clean esbuild bundle (D-1), LOCAL-MODE-ONLY + XSS-safe security (D-4), connectivity semantics.
- **Source touched:** `src/dashboard/web/panels.tsx` (reused `GraphCanvas` + `layout(...)`), `src/dashboard/web/app.tsx` / registry (the Graph page component mounted by PRD-037), `src/dashboard/contracts.ts` (`GraphView` consumed; memory-graph view-model added by 041b), `src/daemon/runtime/dashboard/api.ts` (`GET /api/graph` consumed; memory-graph endpoint added by 041b).
