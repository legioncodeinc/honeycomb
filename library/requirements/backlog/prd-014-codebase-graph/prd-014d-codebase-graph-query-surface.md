# PRD-014d: Query Surface

> **Parent:** [PRD-014](./prd-014-codebase-graph-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** M

## Scope

The synthesized read-only `graph/` query surface rendered on the fly from the local snapshot: find, query, show, impact, neighborhood, layers, tour, and path, with ranked search, fuzzy fallback, and persisted numbered handles. `handleGraphVfs` reads only the local snapshot and makes zero network calls. The query surface is the read half; the CLI history commands round it out.

## Goals

- Let an agent reason about a change grounded in the current checkout: who calls a symbol, its blast radius, and its neighborhood.
- Render every endpoint on the fly from the local snapshot with no network dependency.
- Keep search useful with ranked matching, a fuzzy fallback for typos, and stable numbered handles.

## Non-Goals

- Building or resolving the snapshot (covered by PRD-014a/b).
- Cloud push and pull (covered by PRD-014c).
- Writing to the graph; the surface is read-only.

## User stories

- As an agent, I want to ask for a symbol's blast radius and neighborhood so that I can reason about a change grounded in the current checkout.
- As a developer, I want a fuzzy fallback so that a small typo in a symbol name still finds the node.
- As an agent, I want a follow-up `show/<N>` to resolve the handle from a prior `find/` so that I can drill in without re-typing the pattern.

## Functional requirements

- FR-1: `handleGraphVfs` MUST read only the local snapshot and make zero network calls, rendering text on the fly.
- FR-2: `index.md` MUST return an overview: commit, node and edge counts, node and edge kind breakdowns, top files, and limitations.
- FR-3: `find/<pattern>` MUST do a case-insensitive substring search on node id and label, return numbered handles, and fall back to fuzzy matching on no match.
- FR-4: `query/<pattern>` MUST return find results plus a 1-hop neighbor expansion of the top matches grouped by relation.
- FR-5: `show/<handle-or-pattern>` MUST return full node detail plus incoming and outgoing edges grouped by relation, and MUST re-validate that a numbered handle still points at a node present in the current snapshot.
- FR-6: `impact/<pattern>` MUST return transitive dependents (blast radius); `neighborhood/<file>` MUST return a file's symbols plus their cross-file neighbors.
- FR-7: `layers` MUST group by architectural subsystem via a path heuristic; `tour` MUST return a deterministic dependency-ordered walkthrough; `path/<from>/<to>` MUST return the shortest path between two symbol patterns.
- FR-8: Search ranking MUST be exact label over prefix over id-contains over label-contains, tie-broken by id.
- FR-9: A single token with no substring hit MUST fall back to a bounded zero-dependency Levenshtein fuzzy match (typo tolerance like `pushSnaphot` to `pushSnapshot`).
- FR-10: `find/` MUST persist numbered handles per worktree in `.find-handles.json` so a follow-up `show/<N>` resolves the right node.
- FR-11: Renderers MUST carry the honest caveat that cross-file `calls` resolve only for relative named and namespace imports, so an "Incoming (0)" is not proof of dead code and a snapshot stale against edited source should be cross-checked.
- FR-12: The CLI MUST expose the build record: `honeycomb graph diff <sha1> <sha2>`, `honeycomb graph history`, `honeycomb graph init` (post-commit hook), and `honeycomb graph pull`.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a built snapshot, when an agent reads `graph/find/<pattern>`, then it returns ranked substring matches with numbered handles and a fuzzy fallback on no match. |
| AC-2 | Given `graph/impact/<pattern>`, when it renders, then it returns transitive dependents, and `graph/neighborhood/<file>` returns a file's symbols plus their cross-file neighbors. |
| AC-3 | Given a prior `find/`, when an agent reads `show/<N>`, then the handle resolves to the right node and is re-validated against the current snapshot. |
| AC-4 | Given a one-character typo in a single-token pattern, when `find/` runs, then the Levenshtein fallback returns the intended node. |
| AC-5 | Given any endpoint, when it renders, then `handleGraphVfs` makes zero network calls and reads only the local snapshot. |
| AC-6 | Given a node with no resolved incoming edges, when `show/` renders, then the caveat that "Incoming (0)" is not proof of dead code is shown. |

## Implementation notes

- `handleGraphVfs` reads only the local snapshot and makes zero network calls; search ranks exact label > prefix > id-contains > label-contains, tie-broken by id.
- Renderers carry an honest caveat that "Incoming (0)" is not proof of dead code given unresolved imports.
- The surface is exposed through the synthesized `graph/` subtree of the memory mount.

## Dependencies

- PRD-014b local snapshot on disk and its node/edge model.
- The memory virtual filesystem bridge that surfaces the `graph/` subtree.
- PRD-014c `pull` for fetching a teammate's snapshot before reading.

## Open questions

- [ ] Confirm handle persistence behavior across worktrees when two checkouts share a repo-level snapshot.

## Related

- [parent index](./prd-014-codebase-graph-index.md)
- [Codebase Graph](../../../knowledge/private/data/codebase-graph.md)
- [Memory Virtual Filesystem](../../../knowledge/private/data/memory-virtual-filesystem.md)
