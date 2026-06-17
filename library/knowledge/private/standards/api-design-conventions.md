# API Design Conventions

> Category: Standards | Version: 1.0 | Date: June 2026 | Status: Active

How the Honeycomb daemon's HTTP API is shaped: route grouping, the error and status-code conventions, and the scoping and runtime-path contracts every route honors.

**Related:**
- [Coding Standards (TypeScript)](coding-standards-typescript.md)
- [System Overview](../architecture/system-overview.md)
- [Auth Architecture](../auth/auth-architecture.md)
- [DeepLake Storage](../data/deeplake-storage.md)

---

## One service, grouped routes

The Honeycomb daemon serves everything from one Hono server on port 3850. The root `/` serves the dashboard, `/api/*` is the working API, `/memory/*` keeps search and similarity aliases, `/health` is the cheap liveness check, and `/mcp` and `/v1/*` carry MCP and the OpenAI-compatible gateway. The full surface is enumerated in the [System Overview](../architecture/system-overview.md); this doc covers the conventions behind it.

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
| knowledge-ontology | knowledge navigation, ontology proposals, dreaming, checkpoints |
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

Upstream errors are masked behind client-safe messages. Rate-limited operations surface a dedicated rate-limit error with a `Retry-After` header, and dead-lettered jobs are not retried.

## The contracts every route honors

Two contracts cut across the whole API.

Scoping: every route that touches user data threads `agent_id` (or `agentId`) and threads `visibility` where the data model supports it, all within the caller's org and workspace tenancy. A scoped path never hardcodes `"default"` when a real agent id is known. The enforcement lives in the storage scope clause documented in [DeepLake Storage](../data/deeplake-storage.md), and the tenancy model that wraps it is in [Auth Architecture](../auth/auth-architecture.md).

Runtime path: a session uses one active runtime path. Connectors send `x-honeycomb-runtime-path: plugin|legacy`, and a conflicting path on the same session returns `409`. This is what stops two integration surfaces from writing into one session.

## Auth at the route layer

Authorization is mode-aware. In `local` mode every route is open. In `team` and `hybrid`, each protected route checks a required permission against the caller's role (admin, operator, agent, readonly), validates token scope against the resource within its org and workspace, and applies a rate-limit bucket for expensive or abuse-prone operations. The model is documented in [Auth Architecture](../auth/auth-architecture.md). The rule of thumb is that admin, token, diagnostics, source, connector, secret, and mutation routes always carry an explicit permission check.

## Keeping the API and its docs honest

`docs/API.md` and the per-group `docs/api/*.md` files are kept accurate to the daemon routes, and route changes update them in the same PR. Root docs duplicated into `docs/` are generated artifacts: the root source is edited and the sync script regenerates the copies, so the docs do not drift from the routes they describe. This is the API-surface case of the broader docs-drift rule in [Coding Standards (TypeScript)](coding-standards-typescript.md): code is the authority, and the documented surface is refreshed from implementation truth.
