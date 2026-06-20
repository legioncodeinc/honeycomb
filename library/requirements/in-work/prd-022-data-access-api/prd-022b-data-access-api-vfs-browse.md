# PRD-022b: VFS Browse API (`/memory/*` read, search, list, find)

> **Parent:** [PRD-022](./prd-022-data-access-api-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

The daemon-side `/memory/*` browse reads: the virtual filesystem surface that the PRD-015 `DeepLakeFs` client, the hooks pre-tool-use intercept, and the MCP browse trio (`honeycomb_search`, `honeycomb_read`, `honeycomb_index`) all dispatch to. This sub-PRD owns wiring `cat` and read to a row read, `grep` and `Glob` to hybrid search, `ls` to a prefix list, and `find` to a pattern query, reusing the PRD-015 `src/daemon-client/vfs/classify.ts` path-classification contract and the PRD-007 recall engine. The surface is read-only; writes on memory paths are denied with guidance, per the PRD-015 rule. It does not own the `/api/memories/*` API (022a), even though both share the recall engine, the product-data routes (022c), the seam firing (022d), or the dogfood proof (022e).

## Goals

- A mounted `/memory/*` browse API attaching the read, search, list, and find handlers the VFS clients dispatch to.
- `cat` and read mapped to a row read through the storage client.
- `grep` and `Glob` mapped to hybrid search through the PRD-007 recall engine.
- `ls` mapped to a prefix list, and `find` mapped to a pattern query.
- Reuse of the PRD-015 `src/daemon-client/vfs/classify.ts` path-classification contract, so the daemon-side routing matches the client-side classification.
- A read-only surface where writes on memory paths are denied with actionable guidance, per the PRD-015 rule.

## Non-Goals

- The `/api/memories/*` read and write API (022a), even though it shares the recall engine.
- The product-data routes for goals, KPIs, skills, rules, sources, and secrets (022c).
- The `assembleSeams()` call site that fires the browse seam (022d).
- The CLI, SDK, and MCP client correctness fixes (022d) and the dogfood proof (022e).
- Any new VFS path contract, classification rule, or recall ranking. PRD-015 owns the classification; PRD-007 owns recall; this wires them to the `/memory/*` routes.

## User stories

- As a developer, I want `cat /memory/<path>` to read the underlying row so that browsing memory by path returns real content.
- As a developer, I want `grep` and `Glob` over `/memory` to run hybrid search so that pattern browsing finds relevant memories, not just exact paths.
- As a developer, I want `ls /memory/<prefix>` to list entries under a prefix so that I can navigate the virtual filesystem like a real one.
- As an agent, I want the pre-tool-use intercept and the MCP browse trio to hit the same daemon routes so that every browse path resolves consistently.
- As a maintainer, I want writes on memory paths denied with guidance so that the VFS stays a read surface and mutations go through the audited `/api/memories` routes instead.

## Functional requirements

- FR-1: A mounted `/memory/*` browse API attaches the read, search, list, and find handlers to the daemon, so the PRD-015 `DeepLakeFs` client, the pre-tool-use intercept, and the MCP browse trio all reach real handlers.
- FR-2: `cat` and read resolve to a row read through the storage client, returning the underlying memory content for the resolved path.
- FR-3: `grep` and `Glob` resolve to hybrid search through the PRD-007 recall engine, returning matching memories with the same BM25 and ILIKE fallback when embeddings are off.
- FR-4: `ls` resolves to a prefix list, returning the entries under the requested path prefix.
- FR-5: `find` resolves to a pattern query, returning the memories matching the requested pattern.
- FR-6: The daemon-side routing reuses the PRD-015 `src/daemon-client/vfs/classify.ts` path-classification contract, so a path classifies the same way on the daemon as on the client.
- FR-7: The `/memory/*` surface is read-only: a write on a memory path is denied with a clear, actionable message that points the caller at the audited `/api/memories` write routes, per the PRD-015 rule.
- FR-8: Every browse read is tenancy-scoped, so a browse only resolves within the caller's resolved tenant.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a `cat` or read on a `/memory/<path>`, when it runs, then the handler reads the underlying row and returns its content. |
| AC-2 | Given a `grep` or `Glob` over `/memory`, when it runs, then the handler runs hybrid search through the recall engine, with the BM25 and ILIKE fallback when embeddings are off. |
| AC-3 | Given an `ls` on a `/memory/<prefix>`, when it runs, then the handler returns the entries under that prefix. |
| AC-4 | Given a `find` with a pattern, when it runs, then the handler returns the memories matching the pattern. |
| AC-5 | Given a path, when it is routed daemon-side, then it classifies via the PRD-015 `classify.ts` contract, matching the client-side classification. |
| AC-6 | Given a write on a memory path, when it is attempted, then it is denied with guidance pointing at the audited `/api/memories` write routes. |

## Implementation notes

- The browse surface is a read-only projection of the same engines the `/api/memories` API uses: `cat` is a row read, `grep` and `find` are recall queries, `ls` is a prefix list. Reuse the recall engine rather than re-deriving search, so the VFS and the recall API stay consistent.
- The `classify.ts` contract is the single source of truth for path classification; the daemon must classify the same way the client does, or a path that the client treats as a search will be read as a row and vice versa.
- The write-denied rule is from PRD-015: memory paths are read-only over the VFS, and the audited writes go through `/api/memories`. The denial message should be actionable, not a bare 405. American spelling, direct prose, no em dashes.

## Dependencies

- PRD-015 virtual filesystem, the `DeepLakeFs` client, the `src/daemon-client/vfs/classify.ts` classification contract, and the read-only-memory-paths rule.
- PRD-007 recall engine that `grep`, `Glob`, and `find` call for search.
- PRD-005 capture and PRD-003 data model whose rows `cat` and `ls` read.
- PRD-019b hook pre-tool-use intercept and PRD-019d MCP browse trio that dispatch to these routes.
- PRD-011 tenancy and auth for the tenancy scoping.
- PRD-021a composition root that will fire the browse mount seam once (consumed by 022d).

## Open questions

- [ ] Should `ls` on a deep prefix paginate, and what is the entry cap for a single listing?
- [ ] Should `grep` and `find` share one query path or stay separate, given both reduce to recall queries?
- [ ] How should a write-denied response distinguish a genuinely unsupported path from a path that maps to an audited write route?

## Related

- [parent index](./prd-022-data-access-api-index.md)
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md)
- [Request Lifecycle](../../../knowledge/private/architecture/request-lifecycle.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
- [MCP and SDK](../../../knowledge/private/integrations/mcp-and-sdk.md)
