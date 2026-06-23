# PRD-035 — Dashboard Data Fixes (Turns rename · real Est. savings · graph render)

> **Status:** Completed
> **Priority:** P0 (user-visible bugs in the live dashboard)
> **Effort:** M
> Goal: fix three broken, user-facing things in the daemon-served dashboard — the mislabeled
> "Sessions" KPI/panel (it counts TURNS), the hardcoded `estimatedSavings: 0` stub, and the
> blank codebase-graph widget that counts nodes but draws none and is not clickable.

## Overview

The dashboard is a React SPA at `src/dashboard/web/` (`app.tsx`, `panels.tsx`, `primitives.tsx`,
`wire.ts`) served by the daemon (PRD-021d host), hydrated from the diagnostics endpoints in
`src/daemon/runtime/dashboard/api.ts` against the view-model contracts in
`src/dashboard/contracts.ts` (PRD-020b). PRD-024 re-skinned this surface to the brand UI kit and
wired it to live data. Three defects survived that re-skin — each is small, isolated, and visible
to every user who opens `GET /dashboard`:

1. **The "Sessions" label lies.** The KPI and the panel both count rows in the DeepLake `sessions`
   table, where each captured Claude Code / harness **turn** becomes a row (`fetchSessionsView`
   reads `sessions` ordered by `creation_date`; `fetchKpisView` does `COUNT(*) FROM "sessions"`).
   Users read "Sessions" as conversations, not turns, and the number looks inflated and wrong.
2. **"Est. savings" is a stub.** `fetchKpisView` in `src/daemon/runtime/dashboard/api.ts:159`
   hardcodes `estimatedSavings: 0` with the comment "0 until its pipeline lands". The KPI renders
   `0 tok` for everyone, so a headline value prop of the product reads as broken.
3. **The codebase-graph widget is blank.** `GraphCanvas` in `src/dashboard/web/panels.tsx` only
   draws a node whose `id` is in a HARDCODED `NODE_POS` map (`daemon`/`capture`/`recall`/
   `pipeline`/`store`/`pollinating`). Real snapshot node ids (file paths / symbols from
   `fetchGraphView` reading the `codebase` table) never match, so `if (!p) return null` skips EVERY
   node. The header reads "N nodes · M edges" while the canvas is empty and nothing is clickable.

This PRD fixes the VIEW + the one daemon-side metric. It does not change the DeepLake schema, the
storage table names, or the route topology.

## Goals

- Rename the surfaced **Sessions → Turns** concept (KPI label, panel title, and the
  presentation-layer field naming) so the count is labeled for what it is.
- Replace the hardcoded `estimatedSavings: 0` with a real, explainable token-savings metric
  computed daemon-side, cheap enough to run on every KPI fetch.
- Make `GraphCanvas` render ALL nodes and edges from the real `codebase` snapshot via a computed
  layout (not the hardcoded position map), and make nodes clickable with a node-detail surface.

## Non-Goals

- **No DeepLake schema change.** The storage table stays named `sessions`; renaming is a
  presentation concern. Adding a `tokens`/`token_count`-style column for savings is an Open
  Question deferred to deeplake-dataset-worker-bee, NOT decided here (035b proposes a default that
  works from existing data first).
- **No new route topology.** The diagnostics endpoints (`/api/diagnostics/*`, `/api/graph`) and
  the recall/logs routes are unchanged; this PRD edits handlers and the web app, not `server.ts`.
- **Not the full-page Graph experience.** The full-page graph is **PRD-041**; 035c fixes the shared
  `GraphCanvas` mini-widget so PRD-041 can reuse a correct component. (See Related.)
- **Not the nav-shell.** These fixes predate the nav-shell **PRD-037**; they apply to the current
  single page and carry forward unchanged into the shell.
- No change to recall ranking, the embeddings runtime, or the pollinating loop.

## Features

| Sub-PRD | Feature | Status |
|---|---|---|
| [prd-035a-dashboard-data-fixes-sessions-turns-rename](./prd-035a-dashboard-data-fixes-sessions-turns-rename.md) | Sessions → Turns rename (KPI + panel + presentation fields) | Draft |
| [prd-035b-dashboard-data-fixes-est-savings-metric](./prd-035b-dashboard-data-fixes-est-savings-metric.md) | Est. savings — real, explainable token-savings metric | Draft |
| [prd-035c-dashboard-data-fixes-graph-render-interactivity](./prd-035c-dashboard-data-fixes-graph-render-interactivity.md) | Codebase-graph widget render + interactivity fix | Draft |

## Acceptance Criteria

- [ ] **AC-1 — Turns, not Sessions.** The KPI reads **"Turns"**, the panel is titled **"Turns"**,
      and no user-facing string that means "captured turns" still says "Sessions". The DeepLake
      `sessions` table name is unchanged. (035a)
- [ ] **AC-2 — Real savings.** The "Est. savings" KPI shows a real, non-zero, explainable number
      when recall/capture data exists, and `0` only when there genuinely is no data. The formula
      and its data source are documented in 035b. (035b)
- [ ] **AC-3 — Graph renders.** A built graph draws ALL its nodes and edges (no node silently
      skipped); the "N nodes · M edges" header matches what is drawn. (035c)
- [ ] **AC-4 — Graph is interactive.** Clicking a node selects it and surfaces its detail (id /
      kind / label and its neighbors). (035c)
- [ ] **AC-5 — Empty state preserved.** When `graph.built` is false the widget still shows the
      `honeycomb graph build` prompt (unchanged from today). (035c)
- [ ] **AC-6 — No regressions / gate green.** `npm run ci` (typecheck + jscpd + vitest) passes;
      the existing PRD-024 dashboard DOM tests are updated for the new labels and still assert the
      structure renders; no secret/token introduced into any rendered payload.

## Related

- View-model contracts: `src/dashboard/contracts.ts` (PRD-020b) — `KpisView`, `SessionsView`/
  `SessionRow`, `GraphView`/`GraphNode`/`GraphEdge`.
- Daemon handlers: `src/daemon/runtime/dashboard/api.ts` — `fetchKpisView`, `fetchSessionsView`,
  `fetchGraphView`.
- Web SPA: `src/dashboard/web/app.tsx` (KPI row), `src/dashboard/web/panels.tsx`
  (`SessionsPanel`, `GraphCanvas`), `src/dashboard/web/wire.ts` (zod wire schemas).
- **PRD-024** (`library/requirements/in-work/prd-024-dashboard-ui-parity/`) — the re-skin that
  shipped this surface; these fixes layer on top of it.
- **PRD-041** — the full-page Graph page; reuses the `GraphCanvas` component 035c makes correct.
- **PRD-037** — the nav-shell; these fixes carry forward into it unchanged.
- **PRD-014** (`prd-014-codebase-graph`) — the codebase-graph build pipeline that fills the
  `codebase` table 035c renders from.
