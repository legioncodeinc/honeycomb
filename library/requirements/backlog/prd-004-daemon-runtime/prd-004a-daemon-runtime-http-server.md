# PRD-004a: Hono HTTP Server

> **Parent:** [PRD-004](./prd-004-daemon-runtime-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

Stand up the honeycomb daemon's Hono HTTP server on `127.0.0.1:3850` (port, host, and bind overridable), scaffold the route groups, and implement `/health` and `/api/status`. The daemon is the only DeepLake client; every hook, CLI invocation, MCP call, and SDK request reaches storage through this server. Route bodies are filled by later modules; this module establishes the surface, the bind contract, and the two non-protected diagnostics endpoints.

## Goals

- Bind a Hono server on `127.0.0.1:3850` by default, honoring `HONEYCOMB_PORT`, `HONEYCOMB_HOST`, and `HONEYCOMB_BIND` overrides.
- Scaffold the full route-group surface (`/api/*`, `/memory/*`, `/mcp`, `/`) with permission middleware hooks in place.
- Implement `/health` as the cheap liveness check and `/api/status` as the full resolved-config picture.
- Establish the do-not-touch-storage contract: route handlers call daemon services, never DeepLake directly outside the storage adapter.

## Non-Goals

- The capture, pipeline, retrieval, and ontology route bodies (PRD-005 through PRD-008).
- The auth policy internals beyond wiring per-group permission middleware (auth module).
- The dashboard frontend served at `/` (frontend module).
- The job queue, file watcher, and runtime-path logic (PRD-004b, PRD-004c, PRD-004d).

## User stories

- As a thin client, I want a reachable daemon with a health endpoint so I can verify storage access without opening DeepLake myself.
- As an operator, I want `/api/status` to report resolved config, providers, and tenancy so I can confirm a deployment is wired correctly.
- As a team deployment, I want to widen the bind via `HONEYCOMB_BIND` so harnesses on other hosts can reach the daemon.

## Functional requirements

- FR-1: On startup the server binds to `127.0.0.1:3850`; `HONEYCOMB_PORT`, `HONEYCOMB_HOST`, and `HONEYCOMB_BIND` override port, host, and bind address respectively.
- FR-2: The server scaffolds the route groups `/health`, `/api/status`, `/api/auth/*`, `/api/memories` and `/memory/*`, `/api/hooks/*`, `/api/embeddings/*`, `/api/documents/*` and `/api/sources/*`, `/api/connectors/*` and `/api/harnesses`, `/api/skills`/`/api/rules`/`/api/goals`/`/api/kpis`, `/api/graph/*`, `/api/ontology/*`, `/api/secrets/*`, `/api/org/*` and `/api/workspace/*`, `/api/diagnostics` and `/api/pipeline/*` and `/api/repair/*`, `/api/inference/*` and `/v1/*`, `/api/tasks/*`/`/api/logs`/`/api/update/*`/`/api/git/*`, `/mcp`, and `/`.
- FR-3: `/health` and `/api/status` require no permission; every protected route runs permission middleware that, in `team` and `hybrid` modes, checks a role permission and org/workspace and agent scope, while `local` mode leaves routes open.
- FR-4: `/health` returns liveness, uptime, version, and coarse pipeline status as a cheap check that does not query DeepLake heavily.
- FR-5: `/api/status` returns the resolved config, configured providers, and tenancy (resolved org/workspace).
- FR-6: All route handlers reach storage only through the daemon storage adapter; no handler opens DeepLake directly.
- FR-7: The server emits structured per-request logging consumable by `/api/logs` and the diagnostics report.
- FR-8: Permission middleware is mounted per route group so later modules attach handlers without re-wiring auth.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given daemon startup, when the server binds, then it listens on `127.0.0.1:3850` and honors `HONEYCOMB_PORT`/`HONEYCOMB_HOST`/`HONEYCOMB_BIND`. |
| AC-2 | Given `/health` is requested, when the daemon is up, then it returns liveness, uptime, version, and coarse pipeline status without a heavy DeepLake query. |
| AC-3 | Given `/api/status` is requested, when the daemon is up, then it returns resolved config, providers, and tenancy. |
| AC-4 | Given `team` mode, when a protected route is hit without a valid role permission, then permission middleware rejects the request before the handler runs. |
| AC-5 | Given `local` mode, when any route is hit, then it is open and the handler runs without a permission check. |
| AC-6 | Given a scaffolded route group, when a later module attaches a handler, then it inherits the mounted permission middleware without re-wiring. |
| AC-7 | Given `HONEYCOMB_BIND` widens the bind for a team deployment, when a remote harness connects, then it reaches the daemon over the configured address. |

## Implementation notes

- Daemon modules: a server bootstrap module mounts route groups and middleware; a config resolver reads `HONEYCOMB_PORT`/`HONEYCOMB_HOST`/`HONEYCOMB_BIND`; the storage adapter (PRD-002) is the only DeepLake client.
- Endpoint shapes: `/health` is intentionally cheap (no per-request DeepLake round trip); `/api/status` may read cached resolved config and a coarse provider probe.
- Edge cases: a port already in use fails startup loudly rather than silently rebinding; an invalid `HONEYCOMB_BIND` is rejected at config resolution.
- Failure handling: storage unavailable degrades `/health` to a non-200 liveness signal while keeping the process up so clients can distinguish daemon-down from storage-down.
- Default bind posture (resolves parent open question): `127.0.0.1` by default; team deployments widen explicitly via `HONEYCOMB_BIND`.

## Dependencies

- PRD-002 storage adapter (the only DeepLake client).
- PRD-003 table catalog (read by `/api/status` provider/tenancy resolution).
- Auth module (permission middleware semantics).

## Open questions

- [ ] Should `/api/status` include a live storage round-trip or only a cached provider probe to stay cheap?
- [ ] What is the minimum `/health` payload contract the CLI and harness shims depend on?

## Related

- [parent index](./prd-004-daemon-runtime-index.md)
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md)
- [System Overview](../../../knowledge/private/architecture/system-overview.md)
- [Request Lifecycle](../../../knowledge/private/architecture/request-lifecycle.md)
