# PRD-035c — Codebase-graph widget: render + interactivity fix

> **Status:** Backlog
> **Priority:** P0
> **Effort:** M
> Parent: [PRD-035 — Dashboard Data Fixes](./prd-035-dashboard-data-fixes-index.md)

## Overview

The dashboard's codebase-graph widget renders nothing for a real graph. `GraphCanvas` in
`src/dashboard/web/panels.tsx` positions nodes from a HARDCODED map:

```ts
const NODE_POS: Record<string, { x: number; y: number }> = {
  daemon: {...}, capture: {...}, recall: {...}, pipeline: {...}, store: {...}, dreaming: {...},
};                                                              // panels.tsx:232-239
```

When the graph is built, the render does `const p = NODE_POS[n.id]; if (!p) return null;`
(`panels.tsx:269-270`) and the same for edges (`const a = NODE_POS[e.from]; ... if (!a || !b)
return null;`, `panels.tsx:263-265`). But real node ids come from `fetchGraphView` reading the
`codebase` table snapshot (`api.ts:206-218`, `parseSnapshot` at `api.ts:352-374`), where ids are
file paths / symbols (e.g. `src/daemon/server.ts`, a function name) — they NEVER match the six
hardcoded keys. So EVERY node is skipped: the panel header shows `${graph.nodes.length} nodes ·
${graph.edges.length} edges` (`panels.tsx:260`) — e.g. "5 nodes · 0 edges" — while the SVG canvas
is blank, and nothing is clickable.

This sub-PRD fixes the shared canvas component: compute real positions, render real edges, and make
nodes clickable with a node-detail surface. It does NOT touch the daemon graph data (already correct
in `fetchGraphView`).

Note on reuse: this is the dashboard MINI-widget. The full-page graph is **PRD-041**, which reuses
this corrected `GraphCanvas` (or its extracted layout). 035c's job is to make the shared component
correct; PRD-041 builds the full page on top of it.

## Goals

- Render ALL nodes and ALL edges of a built graph using a COMPUTED layout (not the hardcoded
  `NODE_POS` map).
- Render edges from the real `from`/`to` ids, connecting the computed node positions.
- Make nodes clickable: selecting a node surfaces its detail (id, kind, label, and its neighbors).
- Keep the `built: false` empty state exactly as-is (the `honeycomb graph build` prompt).

## Non-Goals

- Changing `fetchGraphView`, `parseSnapshot`, the `codebase` table, or the `GraphView`/`GraphNode`/
  `GraphEdge` contracts (`contracts.ts:82-114`) — the data layer is correct.
- Building the full-page graph experience, pan/zoom, search, or large-graph virtualization — that
  is **PRD-041**. This widget handles the dashboard's small snapshot.
- A physics simulation that runs continuously / animates forever (a deterministic settle is fine;
  see D-1).
- Replacing the `dreaming` pulse behavior (the dreaming node pulse stays, re-expressed for the new
  layout — see D-4).

## User Story

As a user with a built codebase graph, I open the dashboard and the widget actually draws my graph
— every node and edge the header counts is visible — and I can click a node to see what it is and
what it connects to, instead of staring at a blank box that claims "5 nodes · 0 edges".

## Design Decisions

- **D-1 — Compute a layout; delete the hardcoded `NODE_POS`.** Replace `NODE_POS` lookups with a
  computed position per node. Use a deterministic layout so renders are stable and test-assertable:
  either a small force-directed pass that runs a fixed number of iterations then settles, or a
  deterministic grid/radial/circular placement keyed on node index/id. Recommendation for the
  mini-widget: a **deterministic radial/grid** layout (cheap, stable, no animation loop). The
  layout is a pure function `layout(nodes, edges, viewBox) → Map<id, {x,y}>`, extracted so PRD-041
  can reuse it.
- **D-2 — Render edges from real ids against computed positions.** For each edge, look up the
  computed positions of `e.from` and `e.to` (now present for every real node) and draw the line.
  An edge whose endpoint id is missing from the node set is skipped defensively (data integrity),
  but for a well-formed snapshot all edges draw.
- **D-3 — Nodes are clickable; selection drives a detail surface.** Each node `<g>`/`<circle>`
  becomes a click target (cursor pointer, `role`/`aria` as appropriate). Clicking sets a selected
  node id in component state; the panel renders a small node-detail surface (within the panel, e.g.
  a footer/side block) showing the selected node's `id`, `kind`, `label`, and its **neighbors**
  (nodes reachable via edges where `from === id` or `to === id`). Clicking elsewhere / the same node
  toggles selection off. The selected node is visually highlighted.
- **D-4 — Preserve the dreaming pulse + empty state.** The `dreaming` prop still pulses the relevant
  node; since the hardcoded `"dreaming"` id no longer exists in real data, re-express the pulse as
  "pulse the selected/active node while dreaming" or drop the id-specific pulse and pulse a stable
  indicator — decided in OQ-2. The `built: false` branch (`panels.tsx:249-258`) is unchanged.
- **D-5 — Keep it a small, self-contained widget.** Bounded to the existing `viewBox="0 0 540 200"`
  canvas (or a modestly adjusted one). No new dependency unless a layout helper is trivially small;
  prefer a hand-rolled deterministic layout to avoid pulling a graph library into the bundle.

## Functional Requirements

- **FR-1** — When `graph.built` is true, `GraphCanvas` renders one visual node per `graph.nodes`
  entry (no node skipped because its id is absent from a hardcoded map).
- **FR-2** — Node positions come from a computed layout function, not `NODE_POS`; `NODE_POS` is
  removed.
- **FR-3** — Every edge in `graph.edges` whose endpoints exist renders as a line between the two
  computed node positions; a well-formed snapshot draws all edges.
- **FR-4** — The header eyebrow "N nodes · M edges" matches what is actually drawn.
- **FR-5** — Clicking a node selects it; a node-detail surface shows the selected node's `id`,
  `kind`, `label`, and its neighbor list. Re-clicking / clicking away clears the selection.
- **FR-6** — The selected node is visually distinguished (e.g. larger radius / highlight ring).
- **FR-7** — When `graph.built` is false, the `honeycomb graph build` empty-state prompt renders
  unchanged.
- **FR-8** — The layout is a pure, exported function so PRD-041 can reuse it.

## Acceptance Criteria

- [ ] **AC-1** — A built graph draws ALL its nodes and ALL its edges; for a snapshot of N nodes /
      M edges, N node marks and M edge lines are present (no silent skips).
- [ ] **AC-2** — Node ids that are real file paths / symbols (not the six legacy keys) render
      correctly — proven with a snapshot whose ids are arbitrary strings.
- [ ] **AC-3** — Clicking a node surfaces its detail (id, kind, label, neighbors); the neighbor list
      matches the edges in the snapshot.
- [ ] **AC-4** — Clicking the selected node / clicking away clears the selection.
- [ ] **AC-5** — The `built: false` empty state still shows `honeycomb graph build`.
- [ ] **AC-6** — The "N nodes · M edges" header equals the drawn counts.
- [ ] **AC-7** — A DOM/unit test drives `GraphCanvas` with a fake built `GraphWire` (arbitrary-id
      nodes + edges) and asserts: all nodes render, all edges render, a click selects + shows
      neighbors, and the empty state path still works; `npm run ci` is green.

## Open Questions

- **OQ-1 — Layout algorithm.** Deterministic radial/grid (recommended for stability + testability)
  vs a fixed-iteration force-directed pass (nicer-looking, slightly less deterministic)? Default:
  deterministic, so AC-7 can assert positions/structure without flake. Confirm with design whether
  the look is acceptable for the mini-widget.
- **OQ-2 — Dreaming pulse semantics.** With the hardcoded `"dreaming"` id gone, what pulses during
  a dream? Options: pulse the currently-selected node, pulse all nodes subtly, or move the pulse to
  a panel-level indicator. Default: a panel-level/active-node pulse; keep it honest (only while a
  real dream pass is active per 024 AC-6).
- **OQ-3 — Node-detail placement.** In-panel footer vs a popover vs a side block? Default: a compact
  in-panel detail block below the canvas, so the widget stays self-contained for the mini view and
  PRD-041 can replace it with a richer side panel.

## Implementation Notes

- Primary touch point: `src/dashboard/web/panels.tsx` — `GraphCanvas` (`panels.tsx:248-286`) and
  removal of `NODE_POS` (`panels.tsx:232-239`). The `KIND_COLOR` map (`panels.tsx:240`) stays and
  drives node fill by `kind`.
- Data is already correct: `fetchGraphView` (`api.ts:206-218`) + `parseSnapshot` (`api.ts:352-374`)
  yield real nodes/edges; the wire `GraphSchema` (`wire.ts:84-100`) validates them. No daemon edit.
- Extract `layout(...)` as a pure exported function (its own module or an export from `panels.tsx`)
  so **PRD-041** reuses it. Coordinate the shared-component shape with whoever picks up PRD-041.
- No `server.ts` edit; no contract change.
