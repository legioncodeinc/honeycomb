# PRD-014c: Push and Pull

> **Parent:** [PRD-014](./prd-014-codebase-graph-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** M

## Scope

Best-effort cloud sync of snapshots to the `codebase` table through the daemon: `pushSnapshot` with SELECT-before-INSERT drift detection, and `pullSnapshot` fetching the freshest snapshot for the current HEAD with hash revalidation before writing to disk. The daemon (port 3850) owns the DeepLake connection; the local snapshot is the source of truth and push never blocks the build. Scoping is org/workspace plus user.

## Goals

- Share snapshots across a team so a teammate can pull the code graph for the current HEAD without rebuilding.
- Detect extractor-version drift on push rather than silently overwriting a differing snapshot for the same commit.
- Refuse corrupt payloads on pull so a bad row never poisons the local cache.

## Non-Goals

- The build pipeline itself (covered by PRD-014a/b).
- The local query surface (covered by PRD-014d).
- Making the local read depend on the cloud; the local snapshot is authoritative.

## User stories

- As a teammate, I want to pull a colleague's snapshot for the current HEAD so that I get the code graph without rebuilding it locally.
- As an operator, I want drift between the same commit and a differing hash flagged so that extractor-version skew is investigated by a human.
- As a developer, I want push to never block my build so that cloud sync is invisible when it works and harmless when it fails.

## Functional requirements

- FR-1: A successful build MUST push the snapshot to the `codebase` table through the daemon when the user is authenticated; the worker hands the daemon canonical bytes and never opens its own DeepLake connection.
- FR-2: Push MUST be best-effort: any failure MUST log without blocking the build, and the local snapshot MUST remain the source of truth.
- FR-3: Push MUST be skipped silently when there is no auth, no commit context, or `HONEYCOMB_GRAPH_PUSH=0`.
- FR-4: `pushSnapshot` MUST use SELECT-before-INSERT with drift detection, selecting the row for the full identity key `(org, workspace, repo, user, worktree, commit)`.
- FR-5: A matching `snapshot_sha256` MUST be a no-op reported as `already-current`; a differing hash MUST log a `drift` warning and MUST refuse to overwrite.
- FR-6: With no existing row, push MUST insert, storing canonical bytes in the `snapshot_jsonb` jsonb column, then re-select; finding more than one row MUST be reported as `inserted-with-duplicate-race` so the race is observable.
- FR-7: The SessionEnd auto-build path MUST take a cross-process build lock to serialize the most common concurrent caller.
- FR-8: `pullSnapshot` MUST fetch the freshest snapshot of the current HEAD for this user from any worktree, relaxing the identity key to drop `worktree_id` and taking `ORDER BY ts DESC LIMIT 1`.
- FR-9: Before writing to disk, `pullSnapshot` MUST validate the payload shape and recompute the stable-field hash, refusing any payload whose hash does not match the claimed `snapshot_sha256`.
- FR-10: The local-newer comparison MUST be gated on the local build referring to the same commit, so checking out an older commit pulls rather than wrongly reporting "local newer".
- FR-11: All rows MUST be scoped to org and workspace; only the daemon writes to or reads from DeepLake.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given an existing row with a matching `snapshot_sha256`, when push runs, then it is a no-op (`already-current`); a differing hash logs `drift` and refuses to overwrite. |
| AC-2 | Given a pulled payload, when it is validated, then its recomputed stable-field hash must match the claimed `snapshot_sha256` or the payload is refused so a corrupt row never poisons the local cache. |
| AC-3 | Given no auth, no commit context, or `HONEYCOMB_GRAPH_PUSH=0`, when a build completes, then push is skipped silently. |
| AC-4 | Given a push failure, when it occurs, then it logs without blocking the build and the local snapshot remains authoritative. |
| AC-5 | Given more than one row after insert, when push re-selects, then it reports `inserted-with-duplicate-race`. |
| AC-6 | Given an older commit checked out locally, when pull runs, then it pulls rather than reporting "local newer". |

## Implementation notes

- Push identity key is `(org, workspace, repo, user, worktree, commit)`; pull relaxes it to drop `worktree_id` and takes `ORDER BY ts DESC LIMIT 1`. The daemon owns the DeepLake connection.
- Push is skipped silently with no auth, no commit context, or `HONEYCOMB_GRAPH_PUSH=0`; SessionEnd auto-build takes a cross-process lock.
- SELECT-before-INSERT is the standard pattern for DeepLake's UPDATE-coalescing quirk and the absence of a server-side UNIQUE constraint.

## Dependencies

- PRD-014b canonical snapshot bytes and the stable-field hash.
- The `codebase` table (see Schema) and the DeepLake daemon.
- Auth state for the authenticated-user gate.

## Open questions

- [ ] Confirm race-report semantics: whether `inserted-with-duplicate-race` triggers a follow-up dedup or only surfaces a warning.

## Related

- [parent index](./prd-014-codebase-graph-index.md)
- [Codebase Graph](../../../knowledge/private/data/codebase-graph.md)
- [Schema](../../../knowledge/private/data/schema.md)
