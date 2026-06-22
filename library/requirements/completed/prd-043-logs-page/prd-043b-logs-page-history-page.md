# PRD-043b — Logs history page

> **Status:** Backlog
> **Priority:** P2
> **Effort:** M
> Parent: [PRD-043 — Logs Page](./prd-043-logs-page-index.md)

## Overview

This sub-PRD builds the **Logs page** — the content for the PRD-037 nav shell's `#/logs` route. It joins the
two halves of the log surface into one view:

- a **filterable, paginated history table** fed by the new `GET /api/logs/history` endpoint (PRD-043a), and
- the existing **live tail** fed by `GET /api/logs/stream` (the SSE follow stream, reused verbatim).

Today there is no Logs page; the only log surface is the live-log panel embedded in the single-scroll dashboard
(`src/dashboard/web/app.tsx` / `panels.tsx`), reading the in-memory ring buffer through `/api/logs` and
`/api/logs/stream`. PRD-037 carves out the `#/logs` route and the empty page frame; this sub-PRD fills it with a
full-page log view that finally exposes **history**, not just the last 500 records.

Grounding (current code):

- The live reads — `src/daemon/runtime/logs/api.ts`: `GET /api/logs` (snapshot, `?limit=` clamped by
  `resolveLimit`, `DEFAULT_LOGS_LIMIT = 100`) and `GET /api/logs/stream` (SSE: backfill then push each new
  `RequestLogRecord`, `event: "log"`, keepalive comments).
- The record shape rendered per row — `RequestLogRecord` in `src/daemon/runtime/logger.ts:19-37`: `time`,
  `method`, `path`, `status`, `durationMs`, `mode`, `org?`, `workspace?`. No secret in any field.
- The page frame + DS — PRD-037 D-7 registry contract + shared page-frame; tokens in `/dashboard/styles.css`
  and primitives in `src/dashboard/web/primitives.tsx`; wire client `src/dashboard/web/wire.ts`.

## Goals

- A full-page **log history table** on the `#/logs` route: columns for time, method/path, status, duration,
  and harness/org, paginated, with filters for time range, status/level, path, and harness/org.
- A **live tail** on the same page, reusing `/api/logs/stream` SSE unchanged, so new requests stream in while
  the history below stays browsable.
- Filters and pagination that drive the `/api/logs/history` query (PRD-043a FR-4/FR-5), with sensible empty
  and loading states.
- Built ONLY from existing DS tokens/primitives, bundled production-clean by the existing esbuild entry, as a
  single PRD-037 route registry entry.

## Non-Goals

- The persistence backend or the query API — those are PRD-043a. This sub-PRD consumes `/api/logs/history`.
- The sessions/turns drill-down — that is PRD-043c (a distinct section/tab of the same page).
- Changing the SSE tail contract or the `/api/logs` snapshot — reused as-is.
- Any new daemon route beyond what 043a adds, or any change to the nav shell/router (PRD-037).

## User Story

As a user on the Logs page, I see new requests streaming live at the top and a filterable, paginated history
below, so I can both watch the daemon in real time and dig back through what happened earlier — filtered to,
say, every 5xx on `/api/memories/recall` in the last hour.

## Design Decisions

- **D-1 — One page, two data sources.** The live tail subscribes to `/api/logs/stream` (SSE) exactly as the
  current live-log panel does; the history table fetches `/api/logs/history` (PRD-043a). The live stream is
  ephemeral/tailing; the history is the durable, queryable record. They share the row renderer (one
  `RequestLogRecord` row component) so live and historical rows look identical.
- **D-2 — Reuse the existing SSE client, do not re-implement.** The live tail reuses the same SSE consumption
  the dashboard live-log already uses (the `event: "log"` data lines); this sub-PRD does not touch the stream
  contract. If the daemon is down, the shell-level ConnectivityBanner (PRD-037 D-5) covers it — the page does
  not re-implement connectivity.
- **D-3 — Filters map 1:1 to the history query.** The filter controls (time range, status/level, path,
  harness/org) map directly onto the `/api/logs/history` params (043a FR-4); changing a filter refetches page
  one. Pagination uses the 043a cursor (043a FR-5). Filter state lives in the page (and may reflect into the
  hash query for deep-linkable filtered views — see OQ-1).
- **D-4 — Status rendered as a level.** Status codes render with a DS tone (2xx ok, 4xx warn, 5xx critical via
  `--severity-critical`) so the table reads like a log level at a glance, reusing the existing Badge tones —
  no new color ramp.
- **D-5 — No secret on screen.** Every rendered field comes from `RequestLogRecord` (secret-free by
  construction); the page renders no header, token, or body. XSS-safe rendering (the DS primitives' existing
  escaping), LOCAL-MODE-ONLY like the rest of the dashboard.

## Functional Requirements

- **FR-1 — History table.** The page renders a table of `request_log` rows from `GET /api/logs/history` with
  columns: time, method + path, status, duration, harness/org. Newest first.
- **FR-2 — Filters.** Controls for time range, status/level (incl. a `5xx`-style class), path
  (exact/prefix), and harness/org drive the `/api/logs/history` query; changing any filter refetches from
  page one.
- **FR-3 — Pagination.** A "load more"/next control fetches the next older page via the 043a cursor; rows
  append/replace deterministically with no duplicates or gaps. Page size is bounded.
- **FR-4 — Live tail.** A live section subscribes to `/api/logs/stream` and prepends each new record as it
  arrives, using the same row renderer as the history table.
- **FR-5 — States.** Loading, empty ("no logs match these filters"), and error states are handled; an empty
  history (fresh daemon, retention pruned) renders an explicit empty state, not a blank table.
- **FR-6 — Registry entry.** The page registers as the PRD-037 `#/logs` route via one registry entry
  (`{ route: "#/logs", label: "Logs", component, … }`), reusing the shared page-frame.

## Acceptance Criteria

- [ ] **AC-1 — Historical + live in one view.** The `#/logs` page shows a paginated history table
      (`/api/logs/history`) AND a live tail (`/api/logs/stream`); a request made while the page is open appears
      in the live tail and, on refetch, in the history.
- [ ] **AC-2 — Filters work.** Filtering by time range, status/level, path, and harness/org changes the
      history result set correctly (proven against a daemon with known seeded logs); clearing filters restores
      the full newest page.
- [ ] **AC-3 — Pagination works.** Paging fetches successively older windows with no duplicate or missing rows
      across page boundaries.
- [ ] **AC-4 — DS + production-clean.** The page is built only from existing DS tokens/primitives and bundled
      by the existing esbuild entry (no CDN React, no in-browser Babel); a DOM/unit test asserts the table +
      live section render.
- [ ] **AC-5 — No secret on screen.** No rendered log line contains a header, token, or body (the rows are
      `RequestLogRecord`s); grep/DOM-proven. Page stays LOCAL-MODE-ONLY + XSS-safe.
- [ ] **AC-6 — Gate green.** `npm run ci` / `build` / invariant are green; the PRD-037 shell + connectivity
      behavior is unchanged by adding this route.

## Implementation Notes

- Touch points: a new Logs page component under `src/dashboard/web/` (history table + filters + live tail),
  reusing `panels.tsx`/`primitives.tsx` and the `wire.ts` hydration pattern; a wire schema for the
  `/api/logs/history` response (zod, `.catch`-tolerant like the other dashboard schemas); the PRD-037 route
  registry entry for `#/logs`.
- Reuse the existing live-log SSE consumption; do not fork the stream client.
- Keep the row renderer shared between live and history so the two never drift.

## Open Questions

- **OQ-1 — Deep-linkable filters?** Should the active filter set reflect into the hash query (e.g.
  `#/logs?status=5xx&since=…`) so a filtered view is shareable/refresh-stable? Cheap given hash routing
  (PRD-037 D-1); flagged for the page, not required for v1.
- **OQ-2 — Live + history layout.** Stacked (live tail on top, history below) vs. a tabbed "Live | History"
  toggle? Proposed: stacked, with the live tail collapsible. Confirm with design.
- **OQ-3 — Should the live tail and history reconcile?** When a streamed record later appears in a refetched
  history page, do we de-dupe across the two sections, or keep them visually separate (live = transient feed,
  history = durable table)? Proposed: keep separate (D-1). Confirm.
