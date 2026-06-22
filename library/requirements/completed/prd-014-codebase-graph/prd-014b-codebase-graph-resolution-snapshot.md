# PRD-014b: Resolution and Snapshot

> **Parent:** [PRD-014](./prd-014-codebase-graph-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** L

## Scope

The three cross-file resolution passes (calls, imports, heritage) that turn per-file placeholders into real edges with high-confidence-only matching, plus snapshot canonicalization and content-addressed sha256 hashing that excludes volatile observation fields. The snapshot mirrors NetworkX node-link JSON (a directed multigraph). The build is owned by the daemon; the worker produces canonical bytes.

## Goals

- Resolve per-file call, import, and heritage placeholders into real cross-file edges, emitting only high-confidence matches.
- Produce deterministic snapshots so identical code dedups to one stored row regardless of worktree, branch, or build time.
- Annotate node degrees from the complete edge set so fan-in/fan-out reflect cross-file reality.

## Non-Goals

- Per-file extraction (covered by PRD-014a).
- Cloud push and pull (covered by PRD-014c).
- Guessing ambiguous edges; resolution is high-confidence only.

## User stories

- As an agent, I want deterministic snapshots so that identical code always dedups to one stored row regardless of worktree, branch, or build time.
- As an operator, I want ambiguous edges dropped rather than guessed so that the graph stays trustworthy.
- As a developer, I want fan-in/fan-out and entrypoint flags computed after resolution so that degrees reflect cross-file relationships.

## Functional requirements

- FR-1: The calls pass (`resolveCrossFileCalls`) MUST match each unresolved `raw_call` against the file's import bindings and the global export index, emitting an edge only for a named import (including `as` aliases) whose matching export exists in a resolvable local file, or a namespace call `ns.foo()` where `ns` is `import * as ns` from a local file exporting `foo`.
- FR-2: The calls pass MUST deliberately skip default imports, bare (npm) specifiers, tsconfig path aliases, barrel re-exports, instance dispatch, and dynamic `import()`.
- FR-3: The imports pass (`repointImportEdges`) MUST repoint an `imports` edge from a placeholder `external:<specifier>` to the real module node when the specifier is relative and resolves to a known repo file, and MUST keep the `external:` target for bare or unresolvable specifiers.
- FR-4: The heritage pass (`resolveHeritageEdges`) MUST resolve `extends` and `implements` placeholders to a same-file declaration or a named-import cross-file base type.
- FR-5: Module resolution (`resolveModule`) MUST try common TS suffixes in a deterministic order (explicit extension first, then importer's family, then the other) and fall through to `index` files; Python files MUST route to `resolvePythonModule`, dropping ambiguous suffix matches.
- FR-6: `annotateNodeDegrees` MUST set `fan_in`, `fan_out`, and `is_entrypoint` (`exported && fan_in === 0`) from the complete resolved edge set.
- FR-7: Each edge MUST carry a `relation` of `imports`, `calls`, `extends`, `implements`, or `method_of`, a `confidence` of `EXTRACTED`, `INFERRED`, or `AMBIGUOUS`, and an optional `ord` to disambiguate multigraph edges sharing source, target, and relation.
- FR-8: `buildSnapshot` MUST sort nodes by `id` and edges by `(source, target, relation, ord)`, and `canonicalJSON` MUST serialize with object keys sorted at every nesting level and no inserted whitespace.
- FR-9: `computeSnapshotSha256` MUST hash only the stable fields (`directed`, `multigraph`, `graph`, `nodes`, `links`) and MUST exclude the `observation` field (timestamp, branch, worktree path, generator version, file counts).
- FR-10: `writeSnapshot` MUST write atomically (temp file plus `renameSync` in the same directory) so a crash leaves either the old or the new file, never a partial; the snapshot MUST land at `<baseDir>/snapshots/<commit-sha>.json`, or `<snapshot-sha256>.json` with no commit context.
- FR-11: Per-worktree singletons (`latest-commit.txt`, `.last-build.json`) MUST live under `worktrees/<worktree-id>/` where the worktree id is a sha256 of the absolute worktree path truncated to 16 chars, while snapshots, cache, and `history.jsonl` stay shared at the repo level.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given unresolved calls, imports, and heritage, when resolution runs, then only high-confidence matches emit edges and ambiguous cases are dropped, not guessed. |
| AC-2 | Given two builds of identical content, when `computeSnapshotSha256` runs, then both yield the same hash because only stable fields are hashed and `observation` is excluded. |
| AC-3 | Given a default import or bare specifier call site, when the calls pass runs, then no edge is emitted for it. |
| AC-4 | Given a relative import resolving to a repo file, when the imports pass runs, then the edge is repointed to the real module node; an unresolvable specifier keeps its `external:` target. |
| AC-5 | Given a fully resolved edge set, when `annotateNodeDegrees` runs, then `fan_in`, `fan_out`, and `is_entrypoint` reflect cross-file edges. |
| AC-6 | Given a crash during write, when recovery occurs, then the snapshot file is either the prior version or the new one, never partial. |

## Implementation notes

- `buildSnapshot` sorts nodes by id and edges by `(source, target, relation, ord)`; `canonicalJSON` sorts keys at every level. `annotateNodeDegrees` sets `fan_in`/`fan_out`/`is_entrypoint` after resolution.
- `writeSnapshot` is atomic (temp file plus rename). Any new volatile field must go into `observation` or dedup breaks.
- Resolution is high-confidence only; current edges are almost entirely `EXTRACTED`.

## Dependencies

- PRD-014a `FileExtraction` outputs, including `raw_calls` and `import_bindings`.
- The global export index built during the build pass.
- PRD-014c consumes canonical snapshot bytes and the stable-field hash.

## Open questions

- [ ] Confirm Python module resolution edge cases (namespace packages, ambiguous dotted-absolute suffixes).

## Related

- [parent index](./prd-014-codebase-graph-index.md)
- [Codebase Graph](../../../knowledge/private/data/codebase-graph.md)
