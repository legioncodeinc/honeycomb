# PRD-022c: Product Data API (goals, KPIs, skills, rules, sources, secrets)

> **Parent:** [PRD-022](./prd-022-data-access-api-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** L

## Scope

The remaining product-data routes the CLI, SDK, and MCP target: `/api/goals` and `/api/kpis` (the PRD-003d update-or-insert-by-key tables), `/api/skills` read (the PRD-016 and PRD-018 skills table), `/api/rules` read, `/api/sources` (wiring the already-built `src/daemon/runtime/sources/api.ts` `mountSourcesApi`, currently unwired), and `/api/secrets` (wiring the already-built `src/daemon/runtime/secrets/api.ts`, names-only and value-safe). Goals and KPIs writes route the `honeycomb goal add` and `honeycomb kpi add` verbs and the MCP `honeycomb_goal_add` and `honeycomb_kpi_add` tools. This sub-PRD owns wiring these routes to their existing engines. It does not own the `/api/memories/*` API (022a), the `/memory/*` browse reads (022b), the seam firing (022d), or the dogfood proof (022e).

## Goals

- `/api/goals` and `/api/kpis` wired to the PRD-003d update-or-insert-by-key tables, serving reads and routing the add writes.
- `/api/skills` read wired to the PRD-016 and PRD-018 skills table.
- `/api/rules` read wired to the rules surface.
- `/api/sources` wired by mounting the already-built `mountSourcesApi` (`src/daemon/runtime/sources/api.ts`), which currently ships unwired.
- `/api/secrets` wired by mounting the already-built secrets `api.ts` (`src/daemon/runtime/secrets/api.ts`), names-only and value-safe.
- The `honeycomb goal add` and `honeycomb kpi add` verbs and the MCP `honeycomb_goal_add` and `honeycomb_kpi_add` tools routed to the wired goals and KPIs writes.

## Non-Goals

- The `/api/memories/*` read and write API (022a) and the `/memory/*` browse reads (022b).
- The `assembleSeams()` call site that fires these mount seams (022d).
- The CLI, SDK, and MCP client correctness fixes (022d) and the dogfood proof (022e).
- Any new product-data business logic, write policy, or DeepLake schema. The engines and tables (PRD-003d, 012, 013, 016, 018) exist; this wires them.
- Returning secret values. The secrets API is names-only and value-safe; this never exposes a secret value over HTTP.

## User stories

- As a developer, I want `honeycomb goal add` to write a goal and `honeycomb goal` reads to return it so that goals are a real product surface, not a stub.
- As a developer, I want `honeycomb kpi add` to upsert a KPI by key so that re-adding the same KPI updates it rather than duplicating it.
- As a developer, I want `/api/skills` and `/api/rules` reads to return my mined skills and rules so that the learning surfaces are queryable.
- As an operator, I want `/api/sources` to answer so that the already-built sources API stops shipping unwired.
- As an operator, I want `/api/secrets` to list secret names without ever returning a value so that I can audit which secrets exist without exposing them.

## Functional requirements

- FR-1: `/api/goals` is wired to the PRD-003d goals table, serving reads and routing the add write through the existing update-or-insert-by-key path.
- FR-2: `/api/kpis` is wired to the PRD-003d KPIs table, serving reads and routing the add write through the existing update-or-insert-by-key path, so re-adding the same key updates rather than duplicates.
- FR-3: `/api/skills` read is wired to the PRD-016 and PRD-018 skills table, returning the mined skills for the scoped tenant.
- FR-4: `/api/rules` read is wired to the rules surface, returning the rules for the scoped tenant.
- FR-5: `/api/sources` is wired by mounting the already-built `mountSourcesApi` (`src/daemon/runtime/sources/api.ts`), which currently exists but is not mounted into the assembled daemon.
- FR-6: `/api/secrets` is wired by mounting the already-built secrets `api.ts` (`src/daemon/runtime/secrets/api.ts`), names-only and value-safe, never returning a secret value over HTTP.
- FR-7: The `honeycomb goal add` and `honeycomb kpi add` CLI verbs and the MCP `honeycomb_goal_add` and `honeycomb_kpi_add` tools route to the wired goals and KPIs write paths.
- FR-8: Every product-data route validates its request body with Zod, is tenancy-scoped, and rejects a malformed or cross-tenant request at the edge.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given `honeycomb goal add`, when it runs, then `/api/goals` lands the goal via the PRD-003d update-or-insert-by-key path and a `/api/goals` read returns it. |
| AC-2 | Given `honeycomb kpi add` with an existing key, when it runs, then `/api/kpis` updates the existing KPI rather than inserting a duplicate. |
| AC-3 | Given `/api/skills` and `/api/rules` reads, when they run, then they return the scoped tenant's mined skills and rules. |
| AC-4 | Given the assembled daemon, when it is inspected, then `mountSourcesApi` is mounted and `/api/sources` answers rather than 404. |
| AC-5 | Given `/api/secrets`, when it is read, then it returns secret names only and never a secret value. |
| AC-6 | Given any product-data route with a malformed or cross-tenant body, when it runs, then Zod validation or the tenancy scope rejects it at the edge. |

## Implementation notes

- `mountSourcesApi` and the secrets `api.ts` are already built and tested; the bug is that they are not mounted into the assembled daemon. Mounting them is the fix, not new handler code. This is the same unwired-seam pattern PRD-021 burned down for the capture and dashboard seams, applied to the product-data surface.
- Goals and KPIs use the PRD-003d update-or-insert-by-key semantics, so the add verbs are upserts: re-adding the same key updates in place. Do not introduce a second insert path that would duplicate by key.
- The secrets API is names-only and value-safe by contract; a value must never cross the HTTP boundary. This is a security-relevant invariant, so it is part of the acceptance, not an implementation detail. American spelling, direct prose, no em dashes.

## Dependencies

- PRD-003d product tables (goals and KPIs) and the update-or-insert-by-key write path.
- PRD-016 skillify and PRD-018 team skill sharing for the skills table `/api/skills` reads.
- PRD-013 sources and documents for the already-built `mountSourcesApi` this mounts.
- PRD-012 secrets for the already-built names-only secrets `api.ts` this mounts.
- PRD-011 tenancy and auth for the tenancy scoping on every product-data route.
- PRD-021a composition root that will fire these mount seams once (consumed by 022d).

## Open questions

- [ ] Should `/api/rules` be read-only in PRD-022, or also accept rule writes (the rule write path may be a fast-follow)?
- [ ] Do `/api/skills` reads need pagination for a large mined-skill set, and what is the default page size?
- [ ] Should `/api/sources` health and purge sub-routes be in PRD-022 scope, or only the read and list?

## Related

- [parent index](./prd-022-data-access-api-index.md)
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md)
- [Request Lifecycle](../../../knowledge/private/architecture/request-lifecycle.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
- [CLI Command Architecture](../../../knowledge/private/operations/cli-command-architecture.md)
- [MCP and SDK](../../../knowledge/private/integrations/mcp-and-sdk.md)
