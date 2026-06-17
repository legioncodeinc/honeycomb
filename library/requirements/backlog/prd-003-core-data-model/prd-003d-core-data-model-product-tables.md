# PRD-003d: Product Tables

> **Parent:** [PRD-003](./prd-003-core-data-model-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

Define the product tables carried from hivemind onto DeepLake: `skills` (mined `SKILL.md` versions), `rules` (org-wide principles), `goals` and `kpis` (keyed product state), and `codebase` (per-identity graph snapshots). All are `USING deeplake` tables written only by the daemon on port 3850. `skills`/`rules` are append-only version-bumped; `goals`/`kpis` are UPDATE-or-INSERT by logical key; `codebase` uses SELECT-before-INSERT and carries explicit `org_id`/`workspace_id`.

## Goals

- Declare `skills` and `rules` as append-only version-bumped tables where the current state of a logical key is the highest version.
- Declare `goals` and `kpis` as UPDATE-or-INSERT-by-key tables backed by the virtual-filesystem path conventions.
- Declare `codebase` with the `(org, workspace, repo, user, worktree, commit)` identity, `snapshot_jsonb`, and `snapshot_sha256` for dedup and extractor-drift detection.
- Keep all tables converging through the shared column-definition array and lazy heal pass.

## Non-Goals

- The skillify miner and team-sharing logic that write `skills` (PRD-006/product modules).
- The codebase graph extractor and pull/query lifecycle (codebase-graph module); this declares only the snapshot table.
- The goals/KPIs tracking and VFS dispatch behavior; this declares only the backing tables.
- The storage adapter primitives (PRD-002).

## User stories

- As skillify, I want an append-only version-bumped `skills` table so the current state of a `(project_key, name)` pair is the highest version.
- As an operator, I want `rules` version-bumped so an org principle's edit history is preserved and the active rule is the latest.
- As the codebase graph worker, I want a `codebase` snapshot table keyed by identity with a content hash so identical pushes dedup and extractor drift is detectable.

## Functional requirements

- FR-1: The catalog defines `skills` with `id`, `name`, `project_key`, `scope` (default `'me'`), `install` (default `'project'`), `author`, `contributors` (default `'[]'`), `source_sessions` (default `'[]'`), `description`, `trigger_text`, `body`, `version` (BIGINT default `1`), `created_at`, `updated_at`.
- FR-2: `skills` is append-only version-bumped; the current skill for a `(project_key, name)` pair is `ORDER BY version DESC LIMIT 1`; every edit INSERTs version N+1.
- FR-3: The catalog defines `rules` as append-only version-bumped org-wide principles with `id`, `name`/`key`, `body`, `scope`, `version`, `created_at`, `updated_at`; the active rule is the highest version.
- FR-4: The catalog defines `goals` and `kpis` as UPDATE-or-INSERT-by-logical-key tables, one row per key, backed by VFS path conventions.
- FR-5: The catalog defines `codebase` with `org_id`, `workspace_id`, `repo_slug`, `user_id`, `worktree_id`, `commit_sha`, `branch`, `snapshot_sha256`, `snapshot_jsonb`, `node_count`, `edge_count`, `generator_version`, `schema_version`.
- FR-6: `codebase` push uses SELECT-before-INSERT on the identity key, INSERTs only if absent, and re-verifies after to make concurrent-writer races observable; `snapshot_sha256` dedups identical content.
- FR-7: `codebase` carries explicit `org_id`/`workspace_id` because it is cross-cutting, while engine tables rely on storage-layer partitioning plus `agent_id`.
- FR-8: All writes go through the daemon escaping helpers and lazy heal; each table is created on first write from its column-definition array.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a skill or rule edit, when written, then it INSERTs version N+1 and readers take `ORDER BY version DESC LIMIT 1`. |
| AC-2 | Given a codebase snapshot, when stored, then `codebase` carries the `(org, workspace, repo, user, worktree, commit)` identity plus `snapshot_jsonb` and `snapshot_sha256` for dedup and drift detection. |
| AC-3 | Given a goal or KPI write, when applied, then it is UPDATE-or-INSERT by logical key with one row per key. |
| AC-4 | Given two identical codebase pushes, when the second runs, then `snapshot_sha256` matches and the SELECT-before-INSERT skips the duplicate row. |
| AC-5 | Given a `skills` row, when defined, then it carries `scope`, `author`, `contributors`, `source_sessions`, `trigger_text`, `body`, and `version`. |
| AC-6 | Given a concurrent codebase push race, when both writers run, then the re-verify after INSERT makes the race observable rather than silently double-writing. |
| AC-7 | Given any product table does not exist, when the first write runs, then it is created from its column-definition array and the write retries once. |

## Implementation notes

- Daemon modules: schema definition module owns the five column-definition arrays; the skillify miner, rules manager, goals/KPIs manager, and codebase graph worker are the respective writers.
- DeepLake write patterns: `skills`/`rules` append-only version-bumped; `goals`/`kpis` UPDATE-or-INSERT by key; `codebase` SELECT-before-INSERT with re-verify.
- `goals` and `kpis` share the UPDATE-or-INSERT-by-key shape with a logical key column plus value/target/status fields backed by VFS paths; exact value columns are a tracked open question below.
- Edge cases: `contributors` and `source_sessions` are JSON-encoded text defaulting to `'[]'`; a `codebase` snapshot whose `snapshot_sha256` differs for the same identity signals extractor drift and is recorded as a new row.
- Failure handling: missing-table or missing-column writes heal and retry once; a `NOT NULL` column without a `DEFAULT` is rejected by the heal guard.

## Dependencies

- PRD-002 storage adapter and SQL helpers.
- Skillify, rules, goals/KPIs, and codebase graph modules (producers).
- PRD-007 retrieval (reads `skills`/`rules`/`goals` into session-start injection).

## Open questions

- [ ] What are the exact value, target, and status column shapes for `goals` and `kpis`?
- [ ] Should `codebase` retain superseded snapshots per identity or keep only the latest plus drift markers?

## Related

- [parent index](./prd-003-core-data-model-index.md)
- [Schema](../../../knowledge/private/data/schema.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
- [Codebase Graph](../../../knowledge/private/data/codebase-graph.md)
