# Dashboard data API (daemon side) — CONVENTIONS (PRD-020b)

`mountDashboardApi` (`api.ts`) is the daemon-side seam serving the 020b dashboard view-models. It
mirrors `attachHooksHandlers` (019b): the daemon assembly calls it ONCE after `createDaemon(...)`,
and it attaches handlers onto the ALREADY-MOUNTED route groups via `daemon.group(path)` — ZERO
`server.ts` edits. The groups (`/api/diagnostics`, `/api/graph`) are scaffolded + protected in
`server.ts`, so attaching inherits auth/RBAC. The kpis/rules/skills VIEW-MODELS are served UNDER the
diagnostics group (see below), NOT on the canonical `/api/kpis|rules|skills` resource paths — those
belong to the PRD-022 product-data data-access API.

**Storage-correct.** This lives under `src/daemon/` (the only DeepLake client). Each Wave-2 handler
reads through the injected `StorageQuery` and returns the matching 020b view-model
(`KpisView`/`SessionsView`/...). The 020b dashboard (a NON_DAEMON_ROOT thin client) fetches these
endpoints — it never opens DeepLake.

**Filled handlers (Wave 2).** `mountDashboardApi` registers six read handlers, each resolving the
per-request scope from the `x-honeycomb-*` headers (fail-closed: no org → 400), reading rows through
the injected `StorageQuery` with guarded SQL (`sqlIdent` / `sLiteral`), and returning the matching
020b view-model. A non-ok query result is fail-soft (empty rows) so one storage hiccup never throws
the whole dashboard.

**The diagnostics namespace owns five view-models; the canonical resource paths yield.** `server.ts`
mounts NO `/api/sessions` route group (sessions capture lives under `/api/memories` / `/api/hooks`).
This seam NEVER edits `server.ts`, so the sessions AND settings views attach off the already-mounted
`/api/diagnostics` group: `GET /api/diagnostics/sessions` (FR-3) and `GET /api/diagnostics/settings`
(FR-4). The kpis/rules/skills VIEW-MODELS attach there too — `GET /api/diagnostics/kpis`,
`GET /api/diagnostics/rules`, `GET /api/diagnostics/skills` — because the canonical `/api/kpis`,
`/api/rules`, `/api/skills` resource paths are owned by the PRD-022 product-data data-access API (the
rows the CLI/SDK/MCP read). A dashboard view-model is a presentation concern and yields to the
resource it shares a name with. `DASHBOARD_GROUPS` documents the group each view fills.

**`GET /api/graph` is owned elsewhere (route-collision resolution):** the codebase-graph view is
served by `mountGraphApi` (`codebase/api.ts`), the SINGLE owner of the `/api/graph` group. It returns
the FULL `{ built, nodes, edges }` GraphView from the freshest LOCAL snapshot (`built:false`
empty-state when no snapshot exists), so the PRD-041a "Build graph" re-read is immediate + consistent
(no DeepLake eventual-consistency flap). This seam's former DeepLake-read graph handler was retired to
clear the latent `/api/graph` double-registration. The MEMORY-graph view this seam DOES own is served
at `GET /api/diagnostics/memory-graph` (a distinct path — no collision) and returns
`{ built: false, nodes: [], edges: [] }` until the PRD-008 ontology is populated.

**Deferred assembly (D-7):** the production daemon assembly that owns the live storage client calls
`mountDashboardApi` once. It is constructed-and-tested here against a fake `StorageQuery`
(`tests/daemon/runtime/dashboard/api.test.ts` drives `app.request(...)`); importing the daemon does
not auto-invoke it.

## Dashboard host note

`mountDashboardHost` no longer lives in this repo. The dashboard host and onboarding portal now live
in the hive repository, and honeycomb no longer mounts `GET /dashboard` locally.
