# PRD-041b — Memory graph view-model + endpoint + Codebase ↔ Memory toggle (foundation)

> **Status:** Backlog
> **Priority:** P2
> **Effort:** M
> Parent: [PRD-041 — Graph Page](./prd-041-graph-page-index.md)

## Overview

The Graph page (041a) renders the codebase graph. But the more valuable graph to a memory product is the
**memory graph**: the knowledge graph of memories and entities that PRD-008 builds — entities, weighted
aspects, claim attributes, dependency edges (with strength/confidence/reason), and append-only supersession
that keeps "what is true about X right now" answerable. PRD-008's own framing: "Flat memories answer 'what did
I say about X.' A graph answers 'what is true about X right now, what does X depend on, and who claimed it.'"
Seeing that graph is the natural second view of a Graph page.

This sub-PRD lays the **foundation** for rendering the memory graph on the same page, reusing the same canvas:

1. a documented **memory-graph view-model** — the node/edge shape the page renders, mapping PRD-008's
   entities/dependencies/supersession onto a `GraphView`-shaped contract so the existing canvas can draw it;
2. a daemon **endpoint** to serve that view-model; and
3. a **Codebase ↔ Memory graph-type toggle** on the page that switches which graph the canvas renders.

It is deliberately honest about readiness. PRD-008 (Knowledge Graph and Ontology) is still **In-Work**; the
ontology tables, the `/api/ontology/*` surface, and a populated knowledge graph are not guaranteed to exist
when this lands. So this sub-PRD ships what is buildable now — the view-model contract, a serving endpoint
(with a `built: false`-style empty state when there is no graph yet), and the toggle + shared rendering — and
explicitly **defers** the parts that depend on populated PRD-008 data, capturing each gap as an Open Question.
The toggle and canvas must degrade gracefully to an honest empty state when the memory graph is empty or its
data source is not yet available, exactly as the codebase graph does for `built: false`.

## Goals

- Define and document a **memory-graph view-model**: a `GraphView`-shaped contract (so the existing
  `GraphCanvas` + pure `layout(...)` render it unchanged) that maps PRD-008 entities → nodes and PRD-008
  dependency / supersession / mention edges → edges, with node `kind` carrying the ontology kind (entity /
  aspect / attribute) and edge `kind` carrying the relation (`depends_on` / `supersedes` / `mentions` / …).
- Add a daemon **endpoint** that serves the memory-graph view-model for the active scope, returning an honest
  empty state (`built: false`) when no knowledge graph exists yet — mirroring `GET /api/graph`'s `built` flag
  contract.
- Add a **Codebase ↔ Memory graph-type toggle** to the Graph page that switches the source the canvas renders;
  the SAME canvas, layout, pan/zoom, selection, and kind-filter machinery from 041a render both graph types.
- Be explicit about NOW vs DEFERRED: clearly mark which parts ship as foundation and which defer until PRD-008
  data is populated and served, and capture every gap as an Open Question rather than implying a graph exists.

## Non-Goals

- Building the PRD-008 knowledge graph itself — the entity model, the inline linker, dependency edges,
  supersession, `ontology_proposals`, `epistemic_assertions`, or the `/api/ontology/*` surface. 041b CONSUMES
  that graph for visualization; PRD-008 authors it.
- Changing the codebase graph, its data layer, or 041a's behavior. 041b adds a second source behind a toggle;
  the codebase path is unchanged.
- Editing the memory graph from the page (no create/supersede/apply-proposal from the UI). This is a read-only
  visualization; structural change stays in PRD-008's control plane.
- Retrieval traversal / currentness shaping (PRD-007) and the pollinating loop's graph reshaping. Out of scope —
  041b visualizes the graph, it does not query or reshape it for recall.
- A bespoke memory-graph layout / canvas. The whole point is to reuse 041a's shared `GraphCanvas` +
  `layout(...)`; the memory graph is just another `GraphView`-shaped source.

## User Story

As a user, I open the Graph page and flip a toggle from **Codebase** to **Memory** to see the knowledge graph
of my memories and entities — what depends on what, what superseded what — rendered on the same interactive
canvas I already use for the codebase graph. When the knowledge graph has not been built yet, I see an honest
"no memory graph yet" state instead of a broken or empty canvas.

## Design Decisions

- **D-1 — Map the memory graph onto a `GraphView`-shaped contract.** The page's canvas already renders
  `{ built, nodes: {id,label,kind}[], edges: {from,to,kind}[] }` (`src/dashboard/contracts.ts:82-114`). The
  memory-graph view-model adopts the SAME shape so the shared `GraphCanvas` + `layout(...)` render it with no
  canvas changes: PRD-008 entities (and, per OQ, aspects/attributes) become nodes whose `kind` is the ontology
  kind; PRD-008 edges (`depends_on` / `supersedes` / `mentions`, threshold-gated per PRD-008 AC-3) become edges
  whose `kind` is the relation. Define it as a distinct named type (e.g. a `MemoryGraphView` alias of the
  `GraphView` shape, or a shared `GenericGraphView`) so the contract is documented and greppable even though
  the runtime shape matches. See OQ-1 for which ontology objects map to nodes.
- **D-2 — One serving endpoint, honest empty state.** Add a single read endpoint (e.g.
  `GET /api/memory-graph`, attached under the existing protected diagnostics/graph groups exactly like
  `GET /api/graph` in `mountDashboardApi`, `api.ts:308-315`) that returns the memory-graph view-model for the
  active scope. When the knowledge graph is empty or its data source (PRD-008 ontology tables) is not yet
  populated, it returns `{ built: false, nodes: [], edges: [] }` — the SAME `built` contract the codebase graph
  uses (`fetchGraphView`, `api.ts:206-218`) — so the page renders an honest empty state rather than failing.
  The endpoint reads through the injected `StorageQuery` with guarded SQL (the storage-correct pattern in
  `api.ts`); it never opens a raw connection and carries no secret. See OQ-2 on the exact source.
- **D-3 — A graph-type toggle on the page; the canvas is source-agnostic.** Add a Codebase ↔ Memory toggle to
  the Graph page (041a). Selecting a type swaps which view-model the page fetches (`GET /api/graph` vs the new
  memory-graph endpoint) and feeds to the SAME `GraphCanvas`. Pan/zoom, selection/detail, kind-filter, and
  search (041a) all operate on whichever `GraphView`-shaped source is active — the canvas does not know or care
  which graph it is drawing. The node-detail panel's relation labels and the kind legend are driven by the
  active source's real `kind` values (041a D-5), so the memory graph's `depends_on` / `supersedes` relations
  and entity/aspect kinds render without special-casing.
- **D-4 — NOW vs DEFERRED, stated up front.** What ships NOW (the foundation): the documented view-model
  contract, the serving endpoint with the honest empty state, and the toggle + shared rendering — provable end
  to end even against an empty knowledge graph. What DEFERS until PRD-008 data is populated and served:
  populating real entities/edges (the endpoint returns `built: false` until then), any ontology-kind-specific
  legend/iconography, supersession-history affordances (showing the superseded lineage of a claim), and
  threshold tuning for which `depends_on` edges are traversable/visible (PRD-008 AC-3). Each deferred item is an
  Open Question, NOT a silent stub — the page must never imply a memory graph exists when it does not.
- **D-5 — Provenance is honest, not authoritative.** PRD-008 states the graph "is never authoritative on its
  own; it is a fast, rebuildable index over evidence." The page reflects that: if/when node detail surfaces a
  claim, it should be presentable as derived-from-memories provenance, not as ground truth. For 041b's
  foundation this is a note on the view-model (a provenance-friendly field is allowed but optional); the full
  provenance UI defers to when PRD-008 data lands (OQ-4).
- **D-6 — Same security + production-clean posture as 041a.** The endpoint and toggle inherit LOCAL-MODE-ONLY +
  XSS-safe + no-secret-in-page (PRD-024 D-4, PRD-037 D-9). The memory graph carries entity/claim text derived
  from memories, so XSS-safety matters MORE here than for the codebase graph — all labels render as React text,
  never raw HTML, and the endpoint leaks no token/secret. `audit:sql` / `audit:openclaw` stay green.

## Functional Requirements

- **FR-1** — A documented memory-graph view-model exists as a named contract, shaped so the existing
  `GraphCanvas` + pure `layout(...)` render it unchanged (`{ built, nodes, edges }` with ontology `kind`s).
- **FR-2** — A daemon read endpoint serves the memory-graph view-model for the active scope, returning
  `{ built: false, nodes: [], edges: [] }` (the codebase graph's `built` contract) when no knowledge graph
  exists yet, reading through the injected `StorageQuery` with guarded SQL and leaking no secret.
- **FR-3** — The Graph page has a Codebase ↔ Memory toggle that switches which view-model the canvas renders;
  the same canvas/layout/pan-zoom/selection/kind-filter/search from 041a operate on the active source.
- **FR-4** — When the memory graph is empty / not yet available, the page renders an honest empty state (an
  analog of the `honeycomb graph build` prompt, worded for the memory graph) — not an error and not a blank
  canvas.
- **FR-5** — The view-model + endpoint + page document explicitly which parts ship now (foundation) and which
  defer until PRD-008 data is populated/served; deferred parts are captured as Open Questions, and nothing
  implies a populated graph that does not exist.
- **FR-6** — Security/gate: local-mode-only + XSS-safe (labels as React text, never raw HTML), no new
  token/secret in the page or endpoint response; `npm run ci` / `audit:sql` / `audit:openclaw` green.

## Acceptance Criteria

- [ ] **AC-1** — A named, documented memory-graph view-model exists, `GraphView`-shaped, mapping PRD-008
      entities → nodes (ontology `kind`) and PRD-008 relations → edges (`depends_on` / `supersedes` /
      `mentions`), and the existing `GraphCanvas` renders it unchanged when given such a value.
- [ ] **AC-2** — A daemon read endpoint serves the memory-graph view-model for the active scope and returns the
      honest `{ built: false }` empty state when no knowledge graph exists; it reads via `StorageQuery` with
      guarded SQL and leaks no secret (proven against a fake storage seam, mirroring the 020b daemon-side
      suite).
- [ ] **AC-3** — The Graph page shows a Codebase ↔ Memory toggle; switching to Memory fetches the memory-graph
      endpoint and renders it on the same canvas; switching back restores the codebase graph. The 041a
      interactions (pan/zoom, click-to-detail, kind-filter, search) work on the memory source too.
- [ ] **AC-4** — With an empty memory graph, the Memory view shows an honest "no memory graph yet" empty state
      (not an error, not a blank canvas).
- [ ] **AC-5** — The PRD documentation (this file + the view-model's doc comment) explicitly enumerates NOW vs
      DEFERRED, and every deferred dependency on PRD-008 data is captured as an Open Question; the
      implementation contains no stub that fakes a populated graph.
- [ ] **AC-6** — Security/gate: local-mode-only + XSS-safe (labels as React text), no token/secret in the page
      or endpoint response (grep-proven); `npm run ci` / `build` / `audit:sql` / `audit:openclaw` green.

## Open Questions (these ARE the deferred-readiness gaps — keep them honest)

- **OQ-1 — Which ontology objects are nodes?** PRD-008 models entities, weighted aspects, and claim attributes,
  plus dependency / mention / supersession edges. Do we render only entities as nodes (edges = dependencies),
  or also aspects/attributes (richer, busier)? Default for the foundation: entities as nodes + dependency edges
  as the first edge kind; aspects/attributes/supersession lineage deferred. Confirm with the PRD-008 owner.
- **OQ-2 — What does the endpoint read from, and does it exist yet?** PRD-008's data lives in the ontology
  tables (entities/aspects/attributes/dependencies/mentions, per PRD-003b) and is exposed via `/api/ontology/*`
  (PRD-008 "API changes"). Does 041b's endpoint read those tables directly via `StorageQuery`, or compose the
  existing `/api/ontology/*` surface? And since PRD-008 is In-Work, is any of that populated/served at build
  time? Default: read the ontology tables directly with guarded SQL (like `fetchGraphView` reads `codebase`),
  returning `built: false` until rows exist; revisit if PRD-008 ships a ready-made graph projection.
- **OQ-3 — Edge threshold + visibility.** PRD-008 AC-3: loose `related_to` / `depends_on` edges are traversable
  only when `strength × confidence` clears a threshold. Which edges does the page SHOW (all, or only
  above-threshold)? Default: show above-threshold edges to match traversal semantics; flag for the PRD-008
  owner. Deferred until real edges exist.
- **OQ-4 — Supersession + provenance UI.** Showing a claim's superseded lineage and its derived-from-memories
  provenance (PRD-008's "never authoritative" stance) is valuable but depends on populated attribute history.
  Deferred; the foundation only reserves an optional provenance-friendly field on the view-model (D-5).
- **OQ-5 — Endpoint path + grouping.** `GET /api/memory-graph` vs `GET /api/graph/memory` vs a
  `?type=memory` param on the existing graph route. Default: a distinct `GET /api/memory-graph` attached under
  the same protected group as `/api/graph` (no `server.ts` edit, mirroring `mountDashboardApi`); confirm naming
  with whoever owns the daemon route map.
- **OQ-6 — Empty-state copy.** The codebase graph says `honeycomb graph build`. What is the memory graph's
  honest empty-state action — is there a `honeycomb` command that builds/refreshes the knowledge graph, or is
  it "populated automatically as memories accrue"? Default: a neutral "no memory graph yet for this workspace"
  message until PRD-008 defines the build/refresh path; do not invent a command that does not exist.

## Implementation Notes

- **Reuse, don't fork:** the toggle feeds the same `GraphCanvas` + pure `layout(...)` (from 041a / PRD-035c).
  The ONLY net-new rendering is the toggle control and the memory-graph empty-state copy; everything else is
  the 041a machinery pointed at a second source.
- **Endpoint pattern:** mirror `GET /api/graph` in `src/daemon/runtime/dashboard/api.ts` — attach under an
  already-mounted protected group via `daemon.group(...)`, read through `StorageQuery` with `sqlIdent` /
  `sLiteral` guards, return the view-model, no `server.ts` edit. Add a `fetchMemoryGraphView(storage, scope)`
  next to `fetchGraphView`.
- **Contract location:** add the memory-graph view-model type next to `GraphView` in
  `src/dashboard/contracts.ts` (or a sibling), with a doc comment that states NOW vs DEFERRED (D-4) so the
  honesty lives in the code, not only this PRD.
- **Hard dependency on PRD-008 readiness:** the endpoint returns `built: false` until PRD-008 tables are
  populated/served. The foundation (view-model + endpoint + toggle + empty state) is provable end-to-end
  against an empty graph; the populated experience lands when PRD-008 does. Coordinate OQ-1/OQ-2/OQ-3 with the
  PRD-008 owner before wiring real reads.
- **Sequencing:** depends on 041a (the page + shared canvas + interactions) and, for populated data, on PRD-008
  (In-Work). Buildable now as foundation; visually complete only once PRD-008 data exists.
