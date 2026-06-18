# Dashboard data API (daemon side) — CONVENTIONS (PRD-020b)

`mountDashboardApi` (`api.ts`) is the daemon-side seam serving the 020b dashboard view-models. It
mirrors `attachHooksHandlers` (019b): the daemon assembly calls it ONCE after `createDaemon(...)`,
and it attaches handlers onto the ALREADY-MOUNTED route groups via `daemon.group(path)` — ZERO
`server.ts` edits. The groups (`/api/kpis`, `/api/sessions`, `/api/diagnostics`, `/api/graph`,
`/api/rules`, `/api/skills`) are scaffolded + protected in `server.ts`, so attaching inherits
auth/RBAC.

**Storage-correct.** This lives under `src/daemon/` (the only DeepLake client). Each Wave-2 handler
reads through the injected `StorageQuery` and returns the matching 020b view-model
(`KpisView`/`SessionsView`/...). The 020b dashboard (a NON_DAEMON_ROOT thin client) fetches these
endpoints — it never opens DeepLake.

**Filled handlers (Wave 2).** `mountDashboardApi` registers six read handlers, each resolving the
per-request scope from the `x-honeycomb-*` headers (fail-closed: no org → 400), reading rows through
the injected `StorageQuery` with guarded SQL (`sqlIdent` / `sLiteral`), and returning the matching
020b view-model. A non-ok query result is fail-soft (empty rows) so one storage hiccup never throws
the whole dashboard.

**No standalone `/api/sessions` group.** `server.ts` mounts NO `/api/sessions` route group (sessions
capture lives under `/api/memories` / `/api/hooks`). This seam NEVER edits `server.ts`, so the
sessions AND settings views attach off the already-mounted `/api/diagnostics` group:
`GET /api/diagnostics/sessions` (FR-3) and `GET /api/diagnostics/settings` (FR-4). KPIs / graph /
rules / skills attach at `/` under their own mounted groups (`/api/kpis`, `/api/graph`, `/api/rules`,
`/api/skills`). `DASHBOARD_GROUPS` documents the group each view fills.

**a-AC-6 empty-state:** the `/api/graph` handler returns `{ built: false, nodes: [], edges: [] }`
when no codebase snapshot exists for the workspace; the 020b `buildGraphView` renders the
`honeycomb graph build` prompt from the flag (HTTP 200, not an error).

**Deferred assembly (D-7):** the production daemon assembly that owns the live storage client calls
`mountDashboardApi` once. It is constructed-and-tested here against a fake `StorageQuery`
(`tests/daemon/runtime/dashboard/api.test.ts` drives `app.request(...)`); importing the daemon does
not auto-invoke it.
