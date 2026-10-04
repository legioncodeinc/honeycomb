# API Design Conventions

> Category: Standards | Version: 1.1 | Date: October 2026 | Status: Active

How the Honeycomb daemon's HTTP API is shaped: route grouping, the error and status-code conventions, and the scoping and runtime-path contracts every route honors.

**Related:**
- [Coding Standards (TypeScript)](coding-standards-typescript.md)
- [System Overview](../architecture/system-overview.md)
- [Auth Architecture](../auth/auth-architecture.md)
- [DeepLake Storage](../data/deeplake-storage.md)

---

## One service, grouped routes

The Honeycomb daemon serves its HTTP API from one Hono server on port 3850 (`src/shared/constants.ts`). `/health` is the cheap liveness check and `/api/*` is the working API. `ROUTE_GROUPS` scaffolds `/mcp` and `/v1`. An unfilled scaffold returns 501. The OpenAI gateway module is `src/daemon/runtime/inference/gateway.ts`, and production `assemble.ts` does not call `group("/v1")`. Production MCP is the stdio server. `ROUTE_GROUPS` also scaffolds a `/` group, and no module attaches a page handler to it. The browser dashboard is the Hive portal on port 3853. The full surface is in [Daemon Surface](../architecture/daemon-surface.md); this doc covers the conventions behind the API.

## Route groups

The API documentation organizes routes into coherent groups, and new routes are expected to land in the right one rather than inventing a parallel namespace.

| Group | Covers |
|---|---|
| health-status | health, status, features |
| core-configuration | auth, config, identity |
| memory | memories, embeddings, recall, similarity |
| documents-sources | document ingest, source-backed recall |
| runtime-extensions | connectors, agents, skills, harnesses, plugins, secrets |
| sessions-hooks | harness hooks, session lifecycle |
| inference | routing, execution, streaming, OpenAI-compatible gateway |
| operations | git sync, updates, diagnostics, repair, pipeline |
| knowledge-ontology | knowledge navigation, ontology proposals, pollinating, checkpoints |
| telemetry-logs | analytics, telemetry, logs, MCP, scheduled tasks |

## Errors and status codes

Errors return a structured shape, by default `{ "error": "human-readable message" }`, never a raw stack or an upstream provider's error verbatim. Status codes carry meaning rather than collapsing to 400 or 500.

| Code | Meaning |
|---|---|
| 401 | missing or invalid auth (team/hybrid) |
| 403 | authenticated but lacks permission or scope |
| 409 | state conflict, including a runtime-path conflict on a claimed session |
| 429 | rate limit exceeded, with `Retry-After` |
| 503 | mutation blocked by a kill switch (frozen mutations) |

Upstream errors are masked behind client-safe messages. The rate-limit middleware returns `429` with a `Retry-After` header. Production assembly leaves that middleware unmounted. Dead-lettered jobs are not retried.

## The contracts every route honors

Two contracts cut across the whole API.

Scoping: every route that touches user data threads `agent_id` (or `agentId`) and threads `visibility` where the data model supports it, all within the caller's org and workspace tenancy. A scoped path never hardcodes `"default"` when a real agent id is known. The enforcement lives in the storage scope clause documented in [DeepLake Storage](../data/deeplake-storage.md), and the tenancy model that wraps it is in [Auth Architecture](../auth/auth-architecture.md).

Runtime path: a session uses one active runtime path. Connectors send `x-honeycomb-runtime-path: plugin|legacy`, and a conflicting path on the same session returns `409`. This is what stops two integration surfaces from writing into one session.

## Auth at the route layer

Authorization is mode-aware. In `local` mode every route is open. The frozen roles are `admin`, `member`, `readonly`, and `agent`. In `team`, each protected route checks a required permission against that role. In `hybrid`, the middleware skips the authenticator and the policy for a trusted local socket peer. That skip stays unreachable until a probe is wired, so the live server checks `hybrid` the same way it checks `team`. The route layer asks the policy for a capability and a project hint. The middleware stamps the validated identity so handlers can cross-check `x-honeycomb-org`. Production assembly leaves the rate-limit middleware unmounted. The model is documented in [Auth Architecture](../auth/auth-architecture.md). The rule of thumb is that admin, token, diagnostics, source, connector, secret, and mutation routes always carry an explicit permission check.

## Keeping the API and its docs honest

This checkout's `docs/` directory contains `docs/ci.md` and `docs/license-header.txt`. There is no `docs/API.md` and no `docs/api/` tree here. Route changes belong in the daemon source and in these knowledge pages. Code is the authority.
