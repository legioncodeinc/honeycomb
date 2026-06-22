# PRD-043a — Persistent log store (SQLite)

> **Status:** Backlog
> **Priority:** P2
> **Effort:** M
> Parent: [PRD-043 — Logs Page](./prd-043-logs-page-index.md)

## Overview

The daemon's only log surface today is an **in-memory ring buffer** inside `RequestLogger`
(`src/daemon/runtime/logger.ts`). `createRequestLogger` keeps the last `DEFAULT_LOG_BUFFER_SIZE`
(500) `RequestLogRecord`s in a plain array and shifts the oldest out; a parallel buffer holds up to
500 `EventLogRecord`s. The `/api/logs` group (`src/daemon/runtime/logs/api.ts`) reads that buffer for
its JSON snapshot and SSE tail. **Nothing is written to disk**, so:

- The history is capped at 500 records and **lost on every daemon restart**.
- There is no way to query "all 5xx today" or "every request to `/api/memories/recall` this week" — the
  buffer is a flat tail with only a `?limit=`.

This sub-PRD adds a **durable, append-only SQLite log store** in the daemon's on-disk runtime path so
request logs (and a turn/session activity log) **persist beyond restarts**, with retention/rotation and a
filterable, paginated query API at `GET /api/logs/history`. The `RequestLogger` becomes a **write-through**:
it keeps its existing in-memory ring buffer (so `/api/logs` and `/api/logs/stream` are unchanged and fast)
AND appends each record to SQLite.

Grounding (current code):

- `RequestLogger` / `createRequestLogger` / `RequestLogRecord` / `EventLogRecord` / `DEFAULT_LOG_BUFFER_SIZE`
  — `src/daemon/runtime/logger.ts:19-116`. `log(record)` pushes + shifts the in-memory buffer; `event(name, fields)`
  does the same for events. These are the two write seams to tee into SQLite.
- The `/api/logs` reads — `src/daemon/runtime/logs/api.ts`: `mountLogsApi` attaches `GET /` (snapshot) and
  `GET /stream` (SSE) onto the already-mounted, auth/RBAC-protected `/api/logs` group via `daemon.group(LOGS_GROUP)`.
  `LOGS_GROUP = "/api/logs"`, `DEFAULT_LOGS_LIMIT = 100`, `MAX_LOGS_LIMIT = 1000`, `resolveLimit` clamp helper.
- The on-disk runtime path — `src/daemon/runtime/secrets/store.ts:73-95`: the daemon's local base dir is
  `$HONEYCOMB_WORKSPACE`, with daemon-local state (e.g. the redacted NDJSON audit log) under `.daemon/`
  (`DAEMON_DIR_NAME = ".daemon"`). This is the established place for daemon-local, non-DeepLake on-disk state.

## Goals

- A SQLite database in the daemon runtime path (under `$HONEYCOMB_WORKSPACE/.daemon/`) that persists every
  `RequestLogRecord` and `EventLogRecord` `RequestLogger` produces, surviving daemon restarts.
- `RequestLogger.log` / `RequestLogger.event` **write through** to SQLite in addition to the existing
  in-memory ring buffer — the buffer and the SSE tail behave exactly as today.
- A `GET /api/logs/history` endpoint that queries the store with filters (time range, level/status, path,
  harness/org) and pagination, attached onto the existing `/api/logs` group (no `server.ts` edit).
- Retention/rotation so the store is bounded (by row count and/or age), and never grows without limit.
- The persisted shape carries **exactly** the existing record fields — no header, token, body, or secret —
  preserving the `logger.ts` security invariant on disk.

## Non-Goals

- Persisting any new sensitive field. The store's columns are a 1:1 mapping of `RequestLogRecord` /
  `EventLogRecord` (D-2). No request/response body, header, or token is ever written.
- Moving `memory` / `sessions` / any product data out of DeepLake. SQLite holds the **operational log only**.
- A general-purpose query language. `/api/logs/history` exposes a fixed, validated filter set (FR-4), not
  arbitrary SQL.
- Cross-host / shared log storage. The store is single-daemon, local-first, on-disk (matches `.daemon/`).
- Changing `GET /api/logs` or `GET /api/logs/stream`. They keep reading the in-memory ring buffer (D-3).

## User Story

As an operator debugging Hivemind, after I restart the daemon I can still query the request log from before
the restart — filtered by time, status, path, and harness — so I can answer "what failed an hour ago"
instead of staring at an empty in-memory buffer.

## Why SQLite (and not DeepLake, and not staying in-memory)

Hivemind is **local-first**: the daemon already keeps local, non-DeepLake state on disk under `.daemon/`
(the redacted secrets audit NDJSON). The operational log is a perfect fit for SQLite over the alternatives:

- **vs. staying in-memory (today):** the ring buffer is capped at 500 records and dies on restart — it
  structurally cannot back a history view. Persistence is the whole point of this PRD.
- **vs. DeepLake:** request logs are high-frequency, ephemeral, single-tenant operational telemetry. Pushing
  every request into DeepLake would add network round-trips on the hot logging path, consume the versioned
  append-only dataset with churn, and inherit DeepLake's eventual-consistency flap (a logged request must be
  immediately queryable, not poll-until-converged). DeepLake is the system of record for **memories and
  turns**; it is the wrong store for a local request log.
- **SQLite is local, fast, queryable, and offline.** A single embedded file under `.daemon/`, synchronous
  append on the logging path, indexed filtering for the history query, zero network, works with no
  credentials and no connectivity — exactly the local-first posture the daemon already takes for `.daemon/`
  state. It gives the filter/pagination query API "for free" via indexed `WHERE`/`ORDER BY`/`LIMIT`.

## Proposed schema (illustrative — confirm naming in build)

A single SQLite database file (e.g. `$HONEYCOMB_WORKSPACE/.daemon/logs.db`) with two append-only tables that
mirror the two record types verbatim:

`request_log` — one row per `RequestLogRecord`:

| column | source field | notes |
|---|---|---|
| `id` | (rowid) | autoincrement, pagination cursor |
| `time` | `record.time` | ISO-8601; indexed for time-range filter |
| `method` | `record.method` | indexed-ish (low cardinality) |
| `path` | `record.path` | no query string (already stripped by logger); indexed for path filter |
| `status` | `record.status` | indexed for level/status filter |
| `duration_ms` | `record.durationMs` | |
| `mode` | `record.mode` | `local` \| `team` \| `hybrid` |
| `org` | `record.org` | nullable; the harness/org filter dimension |
| `workspace` | `record.workspace` | nullable |

`event_log` — one row per `EventLogRecord`: `id`, `time`, `event` (the greppable name, e.g. `recall.degraded`),
`fields` (the caller-scrubbed coarse JSON bag — subsystem state only, never a secret per logger D-5).

Indexes on `time`, `status`, and `path` back the `/api/logs/history` filters. No column captures a header,
token, or body — the table shape **cannot** hold a secret because no such field is ever passed in.

## Functional Requirements

- **FR-1 — On-disk store.** Open/create a SQLite database under `$HONEYCOMB_WORKSPACE/.daemon/` (e.g.
  `logs.db`) at daemon assembly, creating the `request_log` / `event_log` tables and indexes if absent
  (idempotent, additive — same posture as the `.daemon/` audit log).
- **FR-2 — Write-through logger.** `RequestLogger.log(record)` appends the record to `request_log` AND keeps
  its existing in-memory ring buffer + stderr write; `RequestLogger.event(name, fields)` appends to
  `event_log` likewise. The SQLite write must not throw into the request path — a store failure degrades to
  the current in-memory behavior (fail-soft), logged once.
- **FR-3 — Query endpoint.** `GET /api/logs/history` attaches onto the existing `/api/logs` group via
  `daemon.group(LOGS_GROUP)` (no `server.ts` edit) and returns a paginated page of `request_log` rows as
  the same `RequestLogRecord` shape, newest first.
- **FR-4 — Filters.** `/api/logs/history` accepts validated query params: time range (`?since=`/`?until=`
  ISO-8601), level/status (`?status=` exact or class, e.g. `5xx`), path (`?path=` exact/prefix), and
  harness/org (`?org=`). Unknown/garbage params are ignored or rejected; the `?limit=` is clamped exactly
  like `resolveLimit` (≤ `MAX_LOGS_LIMIT`).
- **FR-5 — Pagination.** A stable cursor (rowid/`id` or `time`+`id`) with a bounded page size; the response
  carries the page plus a `nextCursor` (or equivalent) so the page can fetch older rows deterministically.
- **FR-6 — Retention / rotation.** The store is bounded by row count and/or age (e.g. keep N days or M rows);
  old rows are pruned on a schedule or on write so the file cannot grow without limit. The retention bound is
  configurable with a sane default.
- **FR-7 — Secret-free on disk.** The persisted columns are exactly the `RequestLogRecord` / `EventLogRecord`
  fields; no header, bearer token, or body is ever written (the `logger.ts` invariant, now on disk).

## Acceptance Criteria

- [ ] **AC-1 — Survives restart.** Records written via `RequestLogger.log` are present in `/api/logs/history`
      after the daemon process is stopped and a fresh daemon opens the same `.daemon/logs.db`. A test writes
      records, simulates restart (re-open the store), and reads them back.
- [ ] **AC-2 — Filterable + paginated history.** `GET /api/logs/history` returns rows filtered by time range,
      status, path, and org, with working pagination (a second page returns the next older window, no
      duplicates, no gaps). An unfiltered call returns the newest page.
- [ ] **AC-3 — Write-through, no regression.** `GET /api/logs` and `GET /api/logs/stream` still serve the
      in-memory ring buffer unchanged; the existing PRD-021d logs tests still pass. The SQLite append does not
      alter the snapshot/stream behavior or block the request path.
- [ ] **AC-4 — Fail-soft.** If the SQLite store cannot be opened or a write fails, the daemon still logs to
      the in-memory buffer + stderr and serves `/api/logs` / `/api/logs/stream`; the failure is surfaced once,
      not on every request.
- [ ] **AC-5 — Bounded store.** With retention configured, writing beyond the bound prunes the oldest rows so
      the row count / age stays within the limit (proven by a test that writes past the bound).
- [ ] **AC-6 — No secret persisted.** A grep / schema assertion proves `request_log` / `event_log` carry only
      the record fields; no column or row ever holds a header, token, or body.
- [ ] **AC-7 — Gate green.** `npm run ci` / `build` / `audit:sql` / `audit:openclaw` / invariant are green;
      `/api/logs/history` inherits the `/api/logs` group auth/RBAC and is local-gated.

## Implementation Notes

- Touch points: `src/daemon/runtime/logger.ts` (write-through in `log`/`event`; inject a store seam so a test
  uses a temp/in-memory DB and the unit logger stays pure), a new store module under
  `src/daemon/runtime/logs/` (the SQLite open/migrate/query/prune), `src/daemon/runtime/logs/api.ts`
  (`GET /api/logs/history` handler + a `resolveHistoryQuery` filter parser mirroring `resolveLimit`),
  `src/daemon/runtime/logs/index.ts` (barrel export), and the daemon assembly (`assemble.ts`) to construct
  the store with the `$HONEYCOMB_WORKSPACE/.daemon/` base dir and inject it into the logger.
- Keep the store injectable + the base dir/clock injected (mirror the secrets `store.ts` pattern) so tests run
  against a temp dir with a fixed clock and never touch the real workspace.
- Do NOT edit `server.ts`; attach via `daemon.group(LOGS_GROUP)` exactly as `mountLogsApi` does today.

## Open Questions

- **OQ-1 — SQLite driver: `node:sqlite` vs `better-sqlite3`.** Node 22 (the repo's `engines` floor) ships a
  built-in `node:sqlite` module — **zero new dependency, no native build/ABI risk, no `ensure-tree-sitter`-
  style postinstall to heal across the Node matrix**, which is a strong fit for the lean-deps publish posture.
  `node:sqlite` is still marked experimental in Node 22, so confirm it is acceptable (and whether the
  cross-node-install smoke covers it) before committing. The alternative, `better-sqlite3`, is mature and
  synchronous but adds a **native dependency with a prebuilt/compile step** — a real supply-chain + multi-node
  ABI concern (the same class of risk as the tree-sitter optionalDependency). **Recommendation:** prefer the
  built-in `node:sqlite` to avoid an added native dep; confirm with typescript-node-worker-bee /
  ci-release-worker-bee / dependency-audit-worker-bee before build. Either way, the store module hides the
  driver behind a seam so the choice does not leak into the logger or the API.
- **OQ-2 — Retention default.** What is the default bound — N days, M rows, or both? Proposed: a row cap
  (e.g. 100k) plus an age cap (e.g. 30 days), whichever is hit first. Confirm against expected request volume.
- **OQ-3 — Prune cadence.** Prune on write (cheap, amortized) vs. a periodic timer vs. on daemon startup?
  Proposed: opportunistic prune on write plus a startup sweep. Confirm there is no hot-path cost.
- **OQ-4 — Does `event_log` back a history view now, or just `request_log`?** 043b's page is request-log-first;
  the `event_log` table is persisted in this sub-PRD but its UI surface may be deferred. Confirm whether
  `/api/logs/history` should expose events in this slice or only requests.
- **OQ-5 — One DB file or two (requests vs events)?** Proposed: one `logs.db` with two tables (simpler
  lifecycle, one open/migrate/prune path). Confirm.
