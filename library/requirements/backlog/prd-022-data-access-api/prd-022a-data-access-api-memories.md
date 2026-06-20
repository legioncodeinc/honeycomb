# PRD-022a: Memories API (recall, remember, get, list, modify, forget)

> **Parent:** [PRD-022](./prd-022-data-access-api-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** L

## Scope

The `/api/memories/*` HTTP API: a `mountMemoriesApi(daemon, { storage, ... })` mount seam, mirroring `mountDashboardApi` and `attachHooksHandlers`, that attaches the memory read and write handlers to the daemon. This sub-PRD owns wiring `POST /api/memories/recall` to the existing recall engine (`src/daemon/runtime/recall/`), wiring `POST /api/memories` (remember and store) to the existing controlled-writes engine (`src/daemon/runtime/pipeline/controlled-writes.ts`), and wiring `memory_get`, `memory_list`, `memory_modify`, and `memory_forget`, with Zod-validated bodies and tenancy scoping. It replaces the PRD-004 `501 not_implemented` scaffold bodies on recall and remember with real engine calls. It does not own the composition root that fires the seam (022d), the `/memory/*` VFS browse routes (022b), the product-data routes (022c), or the dogfood proof (022e).

## Goals

- A `mountMemoriesApi(daemon, { storage, ... })` mount seam, shaped like the existing `mountDashboardApi` and `attachHooksHandlers` seams, that the composition root fires once.
- `POST /api/memories/recall` wired to the recall engine in `src/daemon/runtime/recall/`, returning real hybrid lexical and semantic results, with the embeddings-off BM25 and ILIKE fallback intact.
- `POST /api/memories` (remember and store) wired to `src/daemon/runtime/pipeline/controlled-writes.ts`, landing a real row.
- `memory_get`, `memory_list`, `memory_modify`, and `memory_forget` handlers, where modify and forget require a `reason` and are audited.
- Zod-validated request bodies on every memory route, and tenancy-scoped reads and writes.
- The `/api/memories` group correctly handled as a session group behind the runtime-path middleware, so the handlers and the clients account for the `x-honeycomb-session` requirement.

## Non-Goals

- The `assembleSeams()` call site that fires `mountMemoriesApi` once (022d).
- The `/memory/*` VFS browse reads (022b), even though they share the recall engine.
- The product-data routes for goals, KPIs, skills, rules, sources, and secrets (022c).
- The CLI, SDK, and MCP client correctness fixes (022d) and the dogfood proof (022e).
- Any new recall ranking, write policy, retention rule, or DeepLake schema. The engines exist; this wires them.

## User stories

- As a developer, I want `honeycomb recall "<term>"` to return real memory through the daemon so that recall is a real tool, not a 501 scaffold.
- As a developer, I want `honeycomb remember "<note>"` to land a row I can recall later so that storing memory actually persists.
- As a developer, I want `memory_get` and `memory_list` to read individual and listed memories so that I can inspect what the system has stored.
- As a maintainer, I want modify and forget to require a reason and write an audit record so that every mutation to memory is accountable.
- As a maintainer, I want every memory request body Zod-validated and tenancy-scoped so that a malformed or cross-tenant request is rejected at the edge.

## Functional requirements

- FR-1: A `mountMemoriesApi(daemon, { storage, ... })` mount seam is added, mirroring the shape of `mountDashboardApi` (`src/daemon/runtime/dashboard/api.ts`) and `attachHooksHandlers` (`src/daemon/runtime/capture/attach.ts`), attaching the `/api/memories/*` handlers to the daemon when called.
- FR-2: `POST /api/memories/recall` is wired to the existing recall engine in `src/daemon/runtime/recall/`, running hybrid lexical and semantic recall, and falling back to BM25 and ILIKE when embeddings are off, replacing the PRD-004 `501 not_implemented` scaffold body.
- FR-3: `POST /api/memories` (remember and store) is wired to `src/daemon/runtime/pipeline/controlled-writes.ts`, landing a real row through the existing controlled-writes engine, replacing the PRD-004 `501 not_implemented` scaffold body.
- FR-4: `memory_get` reads a single memory by id, and `memory_list` lists memories for the scoped tenant, both reading the existing `memory` and `sessions` tables through the storage client.
- FR-5: `memory_modify` and `memory_forget` require a `reason` in the request body, perform the mutation through the existing engine, and write an audit record, so no memory mutation is silent.
- FR-6: Every memory route validates its request body with Zod and rejects a malformed body with a 400 before reaching the engine.
- FR-7: Every memory read and write is tenancy-scoped, so a request only reads and writes within its resolved tenant and never crosses a tenant boundary.
- FR-8: The `/api/memories` group is a session group behind the runtime-path middleware, requiring the `x-honeycomb-session` header; the handlers account for this, and this requirement is documented so the 022d clients stamp the header.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given `mountMemoriesApi(daemon, { storage })`, when it is called, then the `/api/memories/*` handlers are attached to the daemon, mirroring the existing mount-seam shape. |
| AC-2 | Given a captured turn, when `POST /api/memories/recall` runs, then the recall engine returns it (no 501), using hybrid recall or the BM25 and ILIKE fallback when embeddings are off. |
| AC-3 | Given `POST /api/memories` with a valid body, when it runs, then the controlled-writes engine lands a real row (no 501) that is then recallable. |
| AC-4 | Given `memory_modify` or `memory_forget` without a `reason`, when it runs, then it is rejected, and given a valid `reason`, the mutation is performed and audited. |
| AC-5 | Given any memory route with a malformed body, when it runs, then Zod validation rejects it with a 400 before the engine is reached. |
| AC-6 | Given the `/api/memories` session group behind the runtime-path middleware, when a request arrives without `x-honeycomb-session`, then the middleware rejects it, and the requirement is documented for the clients. |

## Implementation notes

- The recall engine and the controlled-writes engine already exist and are individually tested; this sub-PRD calls them from the HTTP handlers rather than re-deriving them. The recall engine was proven by the golden-path itest via direct SQL, so wiring it to the route is the missing edge, not new logic.
- The BM25 and ILIKE fallback is the embeddings-off path and is sufficient for the data-API proof; do not require the embed daemon here. The semantic path lights up when embeddings are on, which is a separate follow-up.
- Modify and forget are mutations, so the `reason` requirement and the audit record are part of the contract, not optional. The audit follows the existing audited-write pattern.
- The `/api/memories` session-group placement is the root of the 022d session-header client bug: the runtime-path middleware requires `x-honeycomb-session`, so a one-shot CLI verb must stamp it. Document this clearly so 022d fixes the client. American spelling, direct prose, no em dashes.

## Dependencies

- PRD-004 daemon runtime and the `/api/memories/recall` and `/api/memories` route scaffold this replaces.
- PRD-007 recall engine (`src/daemon/runtime/recall/`) that `POST /api/memories/recall` calls.
- PRD-006 memory pipeline controlled-writes engine (`src/daemon/runtime/pipeline/controlled-writes.ts`) that `POST /api/memories` calls.
- PRD-003a memory data model and PRD-003c sessions and summaries tables that the handlers read and write.
- PRD-011 tenancy and auth for the tenancy scoping and the runtime-path session middleware.
- PRD-021a composition root that will fire `mountMemoriesApi` once (consumed by 022d).

## Open questions

- [ ] Should `/api/memories` stay a session group, or become a non-session group for stateless reads (shared with the index session-id question)?
- [ ] Does recall require the embed daemon wired for the acceptance bar, or is the BM25 and ILIKE fallback sufficient here (shared with the index)?
- [ ] Should `memory_list` paginate, and what is the default page size for a CLI-facing list?

## Related

- [parent index](./prd-022-data-access-api-index.md)
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md)
- [Request Lifecycle](../../../knowledge/private/architecture/request-lifecycle.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
- [MCP and SDK](../../../knowledge/private/integrations/mcp-and-sdk.md)
