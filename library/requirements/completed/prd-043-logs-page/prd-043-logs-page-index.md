# PRD-043: Logs Page (durable log history + sessions/turns operational view)

> **Status:** Backlog
> **Priority:** P2
> **Effort:** L
> **Owner:** `/the-smoker`

## Overview

The dashboard's **Logs** route (the sixth destination of the PRD-037 nav shell) needs a real operational
log surface, and today there is nothing durable behind it. The ONLY log surface that exists is an
**in-memory ring buffer** owned by `RequestLogger` (`src/daemon/runtime/logger.ts`), served by the
already-mounted `/api/logs` group (`src/daemon/runtime/logs/api.ts`):

- `GET /api/logs` — a JSON snapshot of the last ~500 `RequestLogRecord`s (newest last), bounded by `?limit=`.
- `GET /api/logs/stream` — a Server-Sent-Events tail that backfills the buffer then pushes each new record.

That buffer is **ephemeral**: it holds at most `DEFAULT_LOG_BUFFER_SIZE` (500) records and is **lost on
every daemon restart**. A `RequestLogRecord` is deliberately minimal and secret-free — `time`, `method`,
`path` (no query string), `status`, `durationMs`, `mode`, and the resolved `org`/`workspace`; never a
header, bearer token, or request body (the logger's load-bearing security invariant). So a user who opens
the Logs page after a restart sees an empty or near-empty list, and there is no way to ask "what happened
an hour ago" or "show me every 5xx on `/api/memories/recall` today."

This PRD turns the Logs route into a **durable, queryable operational log view**. It introduces the one new
capability the current surface lacks — **persistence** — and then builds the page on top of it:

1. **043a — a persistent log store (SQLite)** in the daemon's on-disk runtime path that the `RequestLogger`
   writes through to, surviving restarts, with retention/rotation and a filterable `GET /api/logs/history`
   query API.
2. **043b — the Logs history page** itself: a filterable, paginated history table fed by `/api/logs/history`,
   alongside the existing **live tail** (reusing `/api/logs/stream` SSE unchanged).
3. **043c — a sessions/turns drill-down** that surfaces captured turns (the DeepLake `sessions` table, which
   per PRD-035a is presented as **Turns**) as a browsable history with per-turn detail.

The page composes the EXISTING Honeycomb design system (the `var(--…)` tokens in `/dashboard/styles.css` and
the primitives in `src/dashboard/web/primitives.tsx`) and slots into the PRD-037 shell as one route registry
entry — no new design system, no CDN React, no in-browser Babel; bundled production-clean by the existing
esbuild entry (PRD-024 D-1 holds).

## Goals

- Persist request logs (and a turn/session activity log) **beyond daemon restarts** in a local, queryable
  store, so the Logs page can show real history, not just the last 500 in-memory records.
- Make log history **queryable with filters** (time range, level/status, path, harness/org) and pagination
  via a new `GET /api/logs/history` endpoint.
- Ship the **Logs page**: a filterable, paginated history table PLUS the existing live tail (live + historical
  in one view), built only from existing DS tokens/primitives, inside the PRD-037 nav shell.
- Surface **captured turns** (the `sessions` table, presented as Turns per PRD-035a) as a browsable history
  with drill-down into a single turn's metadata.
- Keep the secret-free posture absolute: nothing this PRD adds may persist or surface a header, token, body,
  or any secret. The persisted records carry exactly the `RequestLogRecord`/`EventLogRecord` fields and no more.

## Non-Goals

- **No new log fields that capture request/response bodies, headers, or secrets.** The store persists exactly
  what `RequestLogger` already records (043a D-2). This PRD does not widen the log record shape to capture
  more sensitive data.
- **Not a move of memory/session data out of DeepLake.** SQLite holds the operational LOG (request history +
  a turn-activity index); the `sessions` and `memory` tables stay in DeepLake. The turns drill-down (043c)
  reads turns from DeepLake via the existing `fetchSessionsView` path, not from SQLite (043c D-2).
- **Not the nav shell, router, or page-frame.** Those are PRD-037. This PRD is one registry entry + the page's
  content + the persistence/query backend.
- **Not a log aggregation/forwarding pipeline.** No shipping logs to an external collector, no syslog, no
  OpenTelemetry export — local-first, on-disk, single-daemon (OQ-2).
- **No changes to the live SSE tail contract.** `GET /api/logs/stream` (and `GET /api/logs`) are reused
  verbatim; this PRD adds `GET /api/logs/history`, it does not alter the existing two reads.
- **Not a team-mode / multi-host log view.** The Logs page stays LOCAL-MODE-ONLY like the rest of the
  dashboard (PRD-021d F-1 / PRD-024 D-4).

## Features

| Sub-PRD | Feature | Status |
|---|---|---|
| [prd-043a-logs-page-persistent-log-store](./prd-043a-logs-page-persistent-log-store.md) | Durable SQLite log store + `/api/logs/history` query API | Draft |
| [prd-043b-logs-page-history-page](./prd-043b-logs-page-history-page.md) | Filterable/paginated log history page + live tail | Draft |
| [prd-043c-logs-page-turns-drilldown](./prd-043c-logs-page-turns-drilldown.md) | Sessions/turns browsable history + per-turn detail | Draft |

## Acceptance Criteria

- [ ] **AC-1 — Logs survive a restart.** Request logs written while the daemon runs are still queryable after
  the daemon is stopped and restarted (the in-memory ring buffer would have lost them). Proven by writing
  logs, restarting, and reading them back via `/api/logs/history`. *(043a)*
- [ ] **AC-2 — History is queryable with filters.** `GET /api/logs/history` returns persisted records filtered
  by time range, level/status, path, and harness/org, with working pagination; an unfiltered call returns the
  newest page. *(043a)*
- [ ] **AC-3 — The Logs page shows historical + live logs.** The page (PRD-037 `#/logs` route) renders a
  paginated history table from `/api/logs/history` AND a live tail from the existing `/api/logs/stream`, with
  working filters and pagination, built only from existing DS tokens/primitives. *(043b)*
- [ ] **AC-4 — Turns are browsable with drill-down.** The page lists captured turns (the `sessions` table,
  labeled **Turns** per PRD-035a) and opens a single turn to its detail (harness, project, timestamp, event
  count, status). *(043c)*
- [ ] **AC-5 — No secret in any persisted or surfaced log line.** The SQLite store and every endpoint/page
  surface carry only the `RequestLogRecord`/`EventLogRecord`/turn-metadata fields — no header, token, body, or
  secret (grep-proven, mirroring the `logger.ts` invariant). *(043a/043b/043c)*
- [ ] **AC-6 — Security + gate unchanged.** The Logs page stays LOCAL-MODE-ONLY + XSS-safe; the new
  `/api/logs/history` endpoint inherits the `/api/logs` group's auth/RBAC and is local-gated; `npm run ci` /
  `build` / `audit:sql` / `audit:openclaw` / invariant all green. *(all)*

## Related

- **Hosting shell:** PRD-037 Dashboard Nav Shell — `library/requirements/backlog/prd-037-dashboard-nav-shell/prd-037-dashboard-nav-shell-index.md` (the `#/logs` route this page fills; D-7 registry contract, D-9 security posture).
- **Terminology:** PRD-035a Sessions → Turns rename — `library/requirements/backlog/prd-035-dashboard-data-fixes/prd-035a-dashboard-data-fixes-sessions-turns-rename.md` (the `sessions` table is presented as **Turns**).
- **House style / prior art:** PRD-024 Dashboard UI Parity — `library/requirements/in-work/prd-024-dashboard-ui-parity/prd-024-dashboard-ui-parity-index.md` (D-1 production-clean bundle, D-4 security, AC-5 connectivity).
- **Source this builds on:** `src/daemon/runtime/logs/api.ts` + `src/daemon/runtime/logs/index.ts` (the `/api/logs` snapshot + `/api/logs/stream` SSE), `src/daemon/runtime/logger.ts` (`RequestLogger`, `RequestLogRecord`, `EventLogRecord`), `src/daemon/runtime/dashboard/api.ts` (`fetchSessionsView` reading the `sessions` table), `src/daemon/runtime/secrets/store.ts` (the `$HONEYCOMB_WORKSPACE/.daemon/` on-disk runtime path).
