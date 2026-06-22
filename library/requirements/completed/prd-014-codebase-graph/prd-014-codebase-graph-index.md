# PRD-014: Codebase Graph

> **Status:** Completed
> **Priority:** P2
> **Effort:** L
> **Schema changes:** Additive

---

## Overview

Recall over conversation traces tells an agent what was discussed; a code graph tells it how the code is actually wired. This module builds a live, AST-only graph of files, symbols, and edges directly from source so an agent can ask who calls a function, what the blast radius of a change is, or walk a subsystem and get answers grounded in the current checkout. The build is owned by the honeycomb daemon, which runs the codebase-graph worker: it discovers source files honoring `.gitignore`, extracts each with tree-sitter across nine languages, content-addresses a per-file cache, aggregates a snapshot, runs cross-file resolution, and canonicalizes for deterministic hashing. The snapshot mirrors NetworkX node-link JSON so any NetworkX-aware tool can consume it. Successful builds push to the `codebase` table through the daemon (the only DeepLake client) with SELECT-before-INSERT drift detection, and a teammate can pull the freshest snapshot for the current HEAD. Agents read it through the synthesized `graph/` query surface.

## Goals

- Build a deterministic, content-addressed snapshot from tree-sitter extraction across nine languages, owned by the daemon worker.
- Resolve cross-file calls, imports, and heritage with high confidence only, dropping ambiguous cases rather than guessing.
- Push and pull snapshots through the daemon to the `codebase` table with drift detection and hash revalidation.
- Expose a read-only `graph/` query surface (find, impact, neighborhood, tour, and more) over the local snapshot.

## Non-Goals

- LSP, type checking, or LLM-assisted extraction; the feature is AST-only for speed and determinism.
- Ingesting `.d.ts` declarations or non-source files.
- The VFS bridge mechanics that mount `graph/` (PRD-015 owns the intercept; this module owns the renderers).

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-014a-codebase-graph-extractors`](./prd-014a-codebase-graph-extractors.md) | Tree-sitter extractors and content-addressed per-file cache. | Draft |
| [`prd-014b-codebase-graph-resolution-snapshot`](./prd-014b-codebase-graph-resolution-snapshot.md) | Cross-file resolution and deterministic snapshot hashing. | Draft |
| [`prd-014c-codebase-graph-push-pull`](./prd-014c-codebase-graph-push-pull.md) | `codebase` table push/pull and drift detection. | Draft |
| [`prd-014d-codebase-graph-query-surface`](./prd-014d-codebase-graph-query-surface.md) | find/impact/neighborhood/tour query endpoints. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given identical source content on two different worktrees or branches, when both are built, then they produce the same `snapshot_sha256` because the volatile `observation` fields are excluded from the hash. |
| AC-2 | Given an unresolved call site, when resolution runs, then an edge is emitted only for a high-confidence named or namespace import; default imports, barrels, and dynamic imports are skipped. |
| AC-3 | Given a build for a `(org, workspace, repo, user, worktree, commit)` whose existing row has a different `snapshot_sha256`, when push runs, then it logs a `drift` warning and refuses to overwrite. |
| AC-4 | Given a built snapshot, when an agent reads `graph/impact/<pattern>`, then it returns the transitive dependents (blast radius) of the matching symbol. |

## Data model changes

Additive: `codebase` table storing canonical snapshot bytes in a `snapshot_jsonb` column keyed by the identity tuple. Local on-disk snapshots, cache, and history under `~/.honeycomb/graphs/<repo-key>/`.

## API changes

Additive: daemon graph-build/push/pull endpoints and `honeycomb graph build|diff|history|init|pull` CLI verbs. The `graph/` query surface is served through the memory mount.

## Open questions

- [ ] Should edge `confidence` ever rise above `EXTRACTED` (i.e., admit `INFERRED` edges) for cross-file calls that today are dropped?
- [ ] How should the `codebase` table prune old snapshots to bound storage given append-only writes?
- [ ] Should non-default languages (beyond the nine) be pluggable, or is the set fixed?

## Related

- [Codebase Graph](../../../knowledge/private/data/codebase-graph.md)
- [Memory Virtual Filesystem](../../../knowledge/private/data/memory-virtual-filesystem.md)
- [Schema](../../../knowledge/private/data/schema.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
