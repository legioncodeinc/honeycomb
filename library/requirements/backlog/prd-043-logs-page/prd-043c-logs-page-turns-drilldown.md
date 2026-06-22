# PRD-043c — Sessions/turns drill-down

> **Status:** Backlog
> **Priority:** P2
> **Effort:** M
> Parent: [PRD-043 — Logs Page](./prd-043-logs-page-index.md)

## Overview

Beyond request logs, the operator wants to see **captured turns** — the rows in the DeepLake `sessions` table,
each of which is one captured harness turn (per PRD-035a the surfaced concept is **Turns**, not "Sessions").
This sub-PRD adds a **browsable turns history** to the Logs page, with **drill-down** from a turn in the list
into that turn's metadata (harness, project, timestamp, event count, status).

The daemon already serves captured turns: `fetchSessionsView` (`src/daemon/runtime/dashboard/api.ts:164-182`)
selects `id`, `project`, `creation_date`, `path` from the `sessions` table (newest first, `LIMIT 50`) and maps
each row to `{ sessionId, project, startedAt, eventCount, status: "captured" }`. The current dashboard renders
these in the `SessionsPanel`; this sub-PRD gives them a **full-page, browsable, drillable** view on the Logs
route, as the raw operational record of what was captured — complementary to the Memories page's curated view.

Grounding (current code):

- Turns read — `src/daemon/runtime/dashboard/api.ts`: `fetchSessionsView(storage, scope)` reads the `sessions`
  table (`sqlIdent("sessions")`), `ORDER BY creation_date DESC LIMIT 50`, returning `SessionsView` /
  `SessionRow` (`sessionId`, `project`, `startedAt`, `eventCount`, `status`). Served at
  `/api/diagnostics/sessions` (the `DASHBOARD_GROUPS.sessions` group).
- Terminology — PRD-035a: the `sessions` table is presented as **Turns**; `KpisView.turnCount` /
  `SessionsView` labeled "Turns". The DeepLake table name `sessions` is unchanged (035a D-3).

## Goals

- A **browsable turns history** on the Logs page: captured turns listed (newest first) with harness/project/
  timestamp/status, labeled **Turns** per PRD-035a.
- **Drill-down** from a listed turn into a detail view showing that turn's metadata: harness, project,
  timestamp, event count, status.
- Read turns through the existing daemon path (`fetchSessionsView` / the diagnostics sessions endpoint), not a
  new storage surface — turns stay in DeepLake.

## Non-Goals

- Persisting turns into the 043a SQLite store. Turns are DeepLake rows; 043c reads them from DeepLake (D-2).
  SQLite holds the request/event log only.
- Renaming the DeepLake `sessions` table or its columns (PRD-035a D-3) — labels only.
- Rendering full captured turn CONTENT / transcript bodies. This is an operational metadata view; surfacing
  raw dialogue/JSONB is out of scope (and a secret-exposure concern — see D-4 / OQ-2).
- Duplicating the Memories page. Overlap is fine and intended: Memories is the curated recall view; this is
  the raw operational "what got captured" log.

## User Story

As a user on the Logs page, I can browse the turns Hivemind has captured (newest first), labeled "Turns", and
click one to see its harness, project, timestamp, event count, and status — so I have a raw operational record
of capture activity alongside the request log.

## Design Decisions

- **D-1 — Turns are a section of the Logs page.** The turns history is a distinct section/tab on the same
  `#/logs` route (alongside the 043b request-log table), not a separate nav destination. It reuses the PRD-037
  page-frame and the DS table/list primitives.
- **D-2 — Read turns from DeepLake via the existing path, not SQLite.** The list reads the captured turns
  through `fetchSessionsView` / the `/api/diagnostics/sessions` endpoint (or a small history-friendly
  extension of it — see OQ-1). 043a's SQLite store is for the request/event log; turns remain DeepLake rows.
  This keeps a single source of truth for captured turns.
- **D-3 — "Turns" labeling, `sessions` storage.** Every user-facing string says **Turns** (PRD-035a); the
  underlying read still targets the `sessions` table by name. No new label that means captured turns reads
  "Sessions".
- **D-4 — Metadata only, no secret/body.** The drill-down shows the turn's metadata fields
  (`sessionId`/`project`/`startedAt`/`eventCount`/`status` + harness). It does NOT render captured request
  bodies, transcript content, or any field that could carry a secret. If a harness field is added, it is the
  coarse harness name only.
- **D-5 — Empty + paging states.** An empty turns list (nothing captured yet) renders an explicit empty state.
  The current `fetchSessionsView` caps at 50 rows; a browsable history wants paging/a higher bound (OQ-1).

## Functional Requirements

- **FR-1 — Turns list.** The Logs page renders a list/table of captured turns (newest first) with: harness,
  project, timestamp (`startedAt`), event count, and status — titled **Turns**.
- **FR-2 — Drill-down.** Selecting a turn opens a detail view showing that turn's metadata (harness, project,
  timestamp, event count, status, turn id). Closing returns to the list.
- **FR-3 — Read path.** The list/detail read captured turns via the existing daemon sessions read
  (`fetchSessionsView` / `/api/diagnostics/sessions`), extended for browsable history if needed (OQ-1), not a
  new storage layer.
- **FR-4 — Labeling.** All user-facing strings use "Turns"/"turn" (PRD-035a); no captured-turns string reads
  "Sessions".
- **FR-5 — Metadata-only.** No transcript/body/secret is rendered in the list or the detail (D-4).
- **FR-6 — States.** Empty ("no turns captured yet"), loading, and (if paged) load-more states are handled.

## Acceptance Criteria

- [ ] **AC-1 — Turns listed.** The Logs page lists captured turns (newest first) with harness, project,
      timestamp, event count, and status, under a **Turns** heading.
- [ ] **AC-2 — Drill-down works.** Selecting a turn opens its detail (harness, project, timestamp, event
      count, status, id); returning to the list works. Proven against a daemon with seeded `sessions` rows.
- [ ] **AC-3 — DeepLake-sourced, `sessions`-backed.** The turns read still targets the `sessions` table by
      name (verified: the read path uses `sqlIdent("sessions")` via `fetchSessionsView` or its extension); no
      turn is persisted into the 043a SQLite store.
- [ ] **AC-4 — "Turns" labeling.** No user-facing string denoting captured turns reads "Sessions"
      (grep-proven), per PRD-035a.
- [ ] **AC-5 — Metadata only.** No transcript/body/secret appears in the list or detail (DOM/grep-proven);
      page stays LOCAL-MODE-ONLY + XSS-safe.
- [ ] **AC-6 — Gate green.** `npm run ci` / `build` / `audit:sql` / `audit:openclaw` / invariant are green; a
      DOM/unit test asserts the list + drill-down render.

## Implementation Notes

- Touch points: the Logs page component (a Turns section + a turn-detail view) under `src/dashboard/web/`,
  reusing `panels.tsx`/`primitives.tsx`; the turns read via `src/daemon/runtime/dashboard/api.ts`
  (`fetchSessionsView`, possibly extended for paging/higher bound under OQ-1) and its
  `/api/diagnostics/sessions` endpoint; the existing `SessionsView`/`SessionRow` contracts in
  `src/dashboard/contracts.ts` (labeled per PRD-035a).
- The current `eventCount` is hard-coded to `0` in `fetchSessionsView`; if the detail must show a real event
  count, that is a small daemon-side read change — flagged in OQ-3, coordinate with PRD-035 if it touches the
  shared contract.

## Open Questions

- **OQ-1 — Extend the sessions read for browsable history?** `fetchSessionsView` caps at `LIMIT 50` and is a
  dashboard-panel read. A browsable turns history wants paging (a cursor on `creation_date`/`id`) and possibly
  a higher bound. Do we extend the existing `/api/diagnostics/sessions` read with paging, or add a sibling
  history-oriented endpoint? Proposed: extend additively (paged params), coordinate with deeplake-dataset /
  typescript-node worker-bees. Note DeepLake eventual-consistency: a freshly captured turn may not be
  immediately readable — paging reads should tolerate that (no single immediate-read assumption).
- **OQ-2 — How much turn detail is safe to show?** Metadata only (D-4) is the safe default. If product wants
  more (e.g. a turn summary), confirm with security-worker-bee that nothing surfaced can carry a captured
  secret/body before widening the detail view.
- **OQ-3 — Real `eventCount`?** `fetchSessionsView` returns `eventCount: 0` today. Should the detail show a
  real per-turn event count (a daemon-side read change), or display the placeholder until a metric lands?
  Proposed: show what the contract carries; defer a real count to a coordinated PRD-035 change.
- **OQ-4 — Overlap with the Memories page (PRD-040).** The Memories page surfaces curated recall; this surfaces
  raw captured turns. Confirmed acceptable overlap (different lens); confirm the two do not need to cross-link.
