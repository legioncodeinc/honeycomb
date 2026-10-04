# Daemon runtime lens

Date: 2026-10-04. Lens: daemon-runtime. Read-only. No process was started and no package was installed.

Fact labels: VERIFIED (read in this pass, with path and line), REPORTED (a doc or comment states it; this pass did not re-prove the whole claim), UNVERIFIABLE-HERE (not established from the files read).

## How the daemon is assembled

Two construction steps, then a separate listen step.

1. `createDaemon` in `src/daemon/runtime/server.ts:230` builds a Hono app, wires injected services, and scaffolds every route group. It does not bind a socket (`server.ts:18-21`, `server.ts:227-228`).
2. `assembleDaemon` in `src/daemon/runtime/assemble.ts:3020` is the production composition root. It resolves config, builds the live storage client, calls `createDaemon` (`assemble.ts:3512`), then fires mount and attach functions once. Construction itself does not listen (`assemble.ts:3017-3018`).
3. `startDaemon` in `src/daemon/runtime/listen.ts:34` starts services, then binds with `@hono/node-server` on `daemon.config.host` and `daemon.config.port` (`listen.ts:49-54`).
4. The production entry `runAssembledDaemon` in `src/daemon/index.ts:156` calls `assembleDaemon`, then `assembled.start()`, then `startDaemonListener` (`index.ts:157-164`). Importing the module does not listen (`index.ts:150-151`).

Route registration pattern (VERIFIED, `server.ts:293-327`):

- Middleware is mounted on the root app at `${base}/*` (runtime-path, then permission, for session groups).
- `daemon.group(base)` returns `app.basePath(base)`. Later modules register handlers relative to that base, for example `group.post("/recall", ...)`, which becomes `/api/memories/recall`.
- The code comment rejects `app.route(base, subApp)` because that copies routes at call time and would miss handlers attached after bootstrap (`server.ts:297-303`).
- A known prefix with no handler returns 501. An unknown path returns 404 (`server.ts:399-413`).
- `GET /health` and `GET /api/status` are registered on the root app directly. The group loop skips those two prefixes (`server.ts:309`, `server.ts:331`, `server.ts:356`).

Services injected into `createDaemon` (VERIFIED, `server.ts:113-132`, `server.ts:233-239`). Defaults are no-op stubs. `assembleDaemon` swaps in the real implementations.

| Service | Role |
|---|---|
| `queue` | Durable job queue |
| `watcher` | Identity file watcher |
| `runtimePath` | Session claim map |
| `embed` | Embed-daemon supervisor |
| `telemetry` | Fleet check-in and metrics (local SQLite) |

Start order (VERIFIED, `server.ts:424-438`): queue, watcher, runtime-path, embed, telemetry. Stop is the reverse (`server.ts:440-450`).

## Bind address

VERIFIED. Shared constants:

- `DAEMON_HOST = "127.0.0.1"` at `src/shared/constants.ts:17`.
- `DAEMON_PORT = 3850` at `src/shared/constants.ts:14`.
- `HIVE_HOST = "127.0.0.1"` and `HIVE_PORT = 3853` at `src/shared/constants.ts:20-23`. The hive portal is a different listener.

The resolver defaults host and port to those constants (`src/daemon/runtime/config.ts:31`, `config.ts:67-69`). `HONEYCOMB_PORT`, `HONEYCOMB_HOST`, `HONEYCOMB_BIND`, and `HONEYCOMB_MODE` are read from the environment (`config.ts:113-124`). When `HONEYCOMB_BIND` is a non-empty string it wins over `HONEYCOMB_HOST` and sets `widened` unless the bind is `127.0.0.1`, `::1`, or `localhost` (`config.ts:143-156`, `config.ts:167-168`). The listen call uses the resolved config (`listen.ts:52-53`).

`daemonInfo()` reports the shared constants, not the resolved override (`src/daemon/index.ts:104-105`).

## Do-not-edit list

VERIFIED match on the file list.

`AGENTS.md:56` names `src/daemon/runtime/server.ts`, `index.ts`, `config.ts`, `logger.ts`, `middleware/permission.ts`, and `services/types.ts` as files not to edit in order to add a service.

`src/daemon/runtime/CONVENTIONS.md:225-232` names the same six: `server.ts`, `index.ts` (the daemon public surface and `runDaemon`), `config.ts`, `logger.ts`, `middleware/permission.ts`, and `services/types.ts`.

There is no `src/daemon/runtime/index.ts`. `runDaemon` is `src/daemon/index.ts:123`. CONVENTIONS and AGENTS.md still point at the same seam.

The service roster in CONVENTIONS is behind the code. See finding daemon-runtime-7.

## Route groups

Scaffold list is `ROUTE_GROUPS` in `server.ts:68-106`. `protect: false` only for `/health`, `/api/status`, and `/`. `session: true` only for `/api/memories`, `/memory`, `/api/hooks`, and `/mcp` (`server.ts:72-74`, `server.ts:104`). Those four match CONVENTIONS.md:222-223.

Paths below are full paths. Handlers register the part after the group base.

### Implemented on the root app

| Method | Path | Source |
|---|---|---|
| GET | `/health` | `server.ts:331` |
| GET | `/api/status` | `server.ts:356` |

### Groups with handlers attached after `createDaemon`

| Group | Methods and relative paths | Attach |
|---|---|---|
| `/api/auth` | GET `/status` | `auth/status-api.ts:164` |
| `/api/memories` | POST `/recall`, POST `/`, GET `/`, GET `/resolve`, GET `/calibration`, GET `/prime`, GET `/conflicts`, GET `/stale-refs`, GET `/history`, POST `/conflicts/:id/resolve`, GET `/:id`, POST `/:id/modify`, POST `/:id/forget` | `memories/api.ts:755-1076`, `memories/lifecycle-api.ts:310-329`, `memories/conflicts-api.ts:245` |
| `/memory` | GET `/cat`, `/grep`, `/ls`, `/find`, `/classify`. POST, PUT, PATCH, DELETE on `/*` return 405 | `vfs/api.ts:449-500` |
| `/api/hooks` | POST `/capture`, GET `/conversation`, POST `/context`, POST `/session-end` | `capture/capture-handler.ts:281-282`, `capture/attach.ts:204-205` |
| `/api/documents` | POST `/`, GET `/:id`, DELETE `/:id` | `sources/api.ts:248-297` |
| `/api/sources` | GET `/`, POST `/`, GET `/:id/health`, DELETE `/:id` | `sources/api.ts:180-223` |
| `/api/skills` | GET `/`. POST `/`, `/pull`, `/force`, `/scope`, `/unpull`, `/promote` | `product/api.ts:289`, `skillify/propagation-api.ts:232-307` |
| `/api/rules` | GET `/` | `product/api.ts:327` |
| `/api/goals` | GET `/`, POST `/` | `product/keyed-engine.ts:251-258` |
| `/api/kpis` | GET `/`, POST `/` | same keyed engine |
| `/api/graph` | POST `/build`, GET `/` | `codebase/api.ts:321-341` |
| `/api/ontology` | GET `/`, `/entities`, `/edges`, `/claims`, `/assertions`. POST `/proposals` | `ontology/api.ts:203-278` |
| `/api/secrets` | GET `/`, POST `/:name`, DELETE `/:name`, plus exec and vault-provider routes inside `mountSecretsApi` | `secrets/api.ts:178-263` |
| `/api/settings` | GET `/`, GET `/:key`, POST `/:key` | `vault/api.ts:184-219` |
| `/api/assets` | POST `/publish`, `/pull`, `/tombstone` | `assets/api.ts:104-124` |
| `/api/diagnostics` | See the list under this table | many mounts |
| `/api/actions` | POST `/logout`, `/embeddings`, `/memory`, `/restart`, `/uninstall` | `dashboard/actions-api.ts:232-323` |
| `/api/logs` | GET `/`, `/history`, `/stream` | `logs/api.ts:198-235` |
| `/` | Setup routes, local mode only | `assemble.ts:1447` |

`/api/diagnostics` handlers found in this pass (all under that prefix):

- GET `/health`, `/local-queue`, `/jobs`, `/harnesses`, `/kpis`, `/sessions`, `/settings`, `/memory-graph`, `/rules`, `/skills`, `/installed-assets`, `/roi`, `/roi/trend`, `/notifications`, `/assets`
- GET `/fs/browse`, `/scope/orgs`, `/scope/workspaces`, `/scope/projects`
- POST `/harness-status` (full path constant `src/shared/constants.ts:43`)
- POST `/sync/promote`, `/sync/pull`, `/sync/demote`, `/sync/enable`, `/sync/disable`
- POST `/pollinate`, `/projects-sync`, `/compact`, `/stale-refs`, `/reverify`, `/compact-access-log`, `/calibrate`, `/capture-drain`, `/memory-redrive`, `/sessions/prune`
- POST `/projects/bind`, `/projects/bind-existing`, `/projects/unbind`, `/scope/org-switch`, `/scope/workspace-switch`

`/` handlers, mounted only when `daemon.config.mode === "local"` (`assemble.ts:1447`):

- POST `/setup/login` (`dashboard/setup-login.ts:37`, `setup-login.ts:120`)
- GET `/setup/state` (`dashboard/setup-state.ts:58`)
- POST `/setup/migrate-from-hivemind` and POST `/setup/migrate-from-hivemind/rollback` (`dashboard/setup-migrate.ts:62-65`)
- GET `/setup/tenancy`, GET `/setup/tenancy/orgs`, GET `/setup/tenancy/workspaces`, POST `/setup/tenancy/select`, POST `/setup/tenancy/workspaces` (`dashboard/setup-tenancy.ts:74-80`)

The setup modules resolve `daemon.group("/")` (`setup-login.ts:40`, `setup-tenancy.ts:71`).

### Scaffolded groups with no handler attach found

These prefixes are in `ROUTE_GROUPS` and have no `daemon.group("<prefix>")` attach under `src/daemon`. An unfilled request returns 501 (`server.ts:399-410`).

`/api/embeddings`, `/api/connectors`, `/api/harnesses`, `/api/org`, `/api/workspace`, `/api/pipeline`, `/api/repair`, `/api/tasks`, `/api/update`, `/api/git`, `/mcp`.

`/api/inference` and `/v1` have a mount function (`inference/gateway.ts:103-212`: GET `/status`, POST `/explain`, POST `/execute`, POST `/stream`, GET `/history`, DELETE `/requests/:id`, GET `/models`, POST `/chat/completions`). `assemble.ts` does not call `mountInferenceGateway`. The only call site found is `tests/daemon/runtime/inference/gateway.test.ts:203`.

## File watcher (aligned with the surface doc)

VERIFIED. Canonical names are `agent.yaml`, `AGENTS.md`, `SOUL.md`, `MEMORY.md`, `IDENTITY.md`, `USER.md` (`services/harness-sync.ts:69-76`). Default debounce is 500ms (`services/file-watcher.ts:177`). The surface doc's file list matches.

## Comparison

Aligned:

- Default listen address `127.0.0.1:3850` matches `daemon-surface.md:19`, `system-overview.md:41`, and `system-overview.md:77`.
- Env overrides `HONEYCOMB_PORT`, `HONEYCOMB_HOST`, `HONEYCOMB_BIND` match the comment at `config.ts:10-15` that `daemon-surface.md:19` cites.
- Hive portal `http://127.0.0.1:3853/` matches `constants.ts:20-23`, `src/commands/install.ts:64-74`, and `src/dashboard/launch.ts:168-178`. `system-overview.md:85` says the same split: Hive on 3853, daemon API on 3850.
- `/health` and `/api/status` are unprotected. Session groups match CONVENTIONS.
- `/api/inference` and `/v1` are documented as an external HTTP mount that is deferred (`daemon-surface.md:42`). The gateway function exists and assembly does not mount it. That row matches the code.
- The do-not-edit file list matches. See daemon-runtime-7 for the stale service roster in the same conventions file.

`system-overview.md:23` and `daemon-surface.md:19` say the daemon is the only DeepLake client. `src/daemon/index.ts:4-6` states the same confinement. A full import audit of every package was not completed in this lens. Label: REPORTED.

## Findings

### daemon-runtime-1

The `/` row in the surface table calls that group dashboard static assets. The same page says no module calls `group("/")` to attach a page. The code attaches JSON setup routes on `/`, and no dashboard host remains.

- VERIFIED: table row at `library/knowledge/private/architecture/daemon-surface.md:45` says `/` is "Dashboard static assets".
- VERIFIED: prose at `daemon-surface.md:19` says no module under `src/daemon` calls `group("/")` to attach a page there, and cites `server.ts:105`. Line 105 is the `/` scaffold entry.
- VERIFIED: `setup-login.ts:40`, `setup-state.ts:61`, `setup-migrate.ts:68`, and `setup-tenancy.ts:71` set the group to `"/"`. `assemble.ts:1442-1447` mounts them in local mode and states that hive serves the SPA.
- VERIFIED: no `function mountDashboardHost` exists in the repo. `src/daemon/runtime/dashboard/host.ts` is absent.
- VERIFIED: `system-overview.md:85` places the browser UI on Hive port 3853. That sentence agrees with the code and disagrees with the table row.

### daemon-runtime-2

`/mcp` is documented as the Model Context Protocol endpoint. The daemon scaffolds the group and attaches no handler. The MCP package is a separate process that calls the daemon over loopback.

- VERIFIED: `daemon-surface.md:19` and the route table treat `/mcp` as the MCP endpoint.
- VERIFIED: `server.ts:104` scaffolds `/mcp` with `protect: true` and `session: true`. No `daemon.group("/mcp")` attach was found under `src/daemon`.
- VERIFIED: `mcp/src/daemon-seam.ts:6-7` and `mcp/src/daemon-seam.ts:22` dial `DAEMON_HOST:DAEMON_PORT` as a client.
- REPORTED: `mcp/src/index.ts:109-112` says the daemon owns the HTTP `/mcp` request stream in the in-process case. No in-process attach was found in the daemon runtime.

### daemon-runtime-3

The surface table lists several prefixes as live API groups. Those prefixes are 501 scaffolds. The live harness and tenancy routes sit under `/api/diagnostics`.

- VERIFIED: table rows at `daemon-surface.md:36`, `daemon-surface.md:40-41`, and `daemon-surface.md:43` name `/api/embeddings/*`, `/api/connectors/*`, `/api/harnesses`, `/api/org/*`, `/api/workspace/*`, `/api/pipeline/*`, `/api/repair/*`, `/api/tasks/*`, `/api/update/*`, and `/api/git/*`.
- VERIFIED: each of those prefixes is only a `ROUTE_GROUPS` entry (`server.ts:75-103`). No attach was found.
- VERIFIED: harness read is GET `/api/diagnostics/harnesses` (`dashboard/harness-api.ts:56-59`). Org and workspace switch are POST `/api/diagnostics/scope/org-switch` and POST `/api/diagnostics/scope/workspace-switch` (`projects/scope-switch-api.ts:55-60`). Operator repair-style triggers found in this pass are under `/api/diagnostics` (`/compact`, `/stale-refs`, `/reverify`, `/calibrate`), not `/api/repair`.

### daemon-runtime-4

The surface table describes `/api/graph/*` as find, impact, neighborhood, and tour. The HTTP group exposes build and a snapshot read. Those query names are virtual-filesystem renderers.

- VERIFIED: `daemon-surface.md:37`.
- VERIFIED: HTTP routes are POST `/api/graph/build` and GET `/api/graph` (`codebase/api.ts:321-341`).
- VERIFIED: `codebase/query.ts:1-8` documents `graph/find`, `graph/impact`, `graph/neighborhood`, and `graph/tour` as virtual-filesystem paths rendered from an in-memory snapshot. The mounted `/memory` routes are cat, grep, ls, find, and classify (`vfs/api.ts:454-500`).

### daemon-runtime-5

The hooks row names lifecycle events as if they were route paths. The mounted hook routes are four paths.

- VERIFIED: `daemon-surface.md:32` lists session-start, user-prompt-submit, pre-compaction, compaction-complete, session-end, and synthesis under `/api/hooks/*`.
- VERIFIED: mounted paths are POST `/api/hooks/capture`, GET `/api/hooks/conversation`, POST `/api/hooks/context`, and POST `/api/hooks/session-end` (`capture/capture-handler.ts:103-105`, `capture/attach.ts:55-57`).
- VERIFIED: capture event kinds in `capture/event-contract.ts:92-109` are `user_message`, `tool_call`, and `assistant_message`. No route literal `pre-compaction`, `compaction-complete`, `user-prompt-submit`, or `/synthesis` was found under `src/daemon`.

### daemon-runtime-6

The memories row lists search, similarity, and recover on `/api/memories` and `/memory/*`. The mounted surfaces are the memories CRUD and recall routes, plus the `/memory` browse reads.

- VERIFIED: `daemon-surface.md:30` lists list, search, similarity, remember, recall, forget, modify, recover, and prime.
- VERIFIED: remember, recall, forget, modify, list, and prime exist on `/api/memories` (see the route table above). No `recover` route was found under `src/daemon/runtime/memories`.
- VERIFIED: `/memory/*` is the browse API (`vfs/api.ts:454-500`). No `/search` or `/similarity` route was found on that group.

### daemon-runtime-7

The do-not-edit file list still matches. The conventions document still describes three services and an older start order.

- VERIFIED: file list match, `AGENTS.md:56` and `CONVENTIONS.md:225-232`.
- VERIFIED: CONVENTIONS.md:32-38 and CONVENTIONS.md:12-13 describe queue, watcher, and runtime-path, started queue then watcher then runtime-path.
- VERIFIED: `server.ts:113-132` and `server.ts:424-438` also include `embed` and `telemetry`, started after runtime-path.
- Adding those two services required edits to `server.ts`, which is one of the files the convention says not to edit. The convention text was not updated with them.

### daemon-runtime-8

`/setup/*` is documented as its own route group. It is not a `ROUTE_GROUPS` entry. It hangs off the unprotected `/` group, and only in local mode. `/api/settings` is a live group the surface table omits.

- VERIFIED: `daemon-surface.md:29` lists `/setup/*` as a group with permission "none", local-mode only.
- VERIFIED: `/setup` is absent from `ROUTE_GROUPS` (`server.ts:68-106`). Handlers use group `/` and `assemble.ts:1447` gates them on `mode === "local"`.
- VERIFIED: `/api/settings` is protected in `server.ts:87` and serves GET `/`, GET `/:key`, and POST `/:key` (`vault/api.ts:184-219`). The surface table has no `/api/settings` row.
