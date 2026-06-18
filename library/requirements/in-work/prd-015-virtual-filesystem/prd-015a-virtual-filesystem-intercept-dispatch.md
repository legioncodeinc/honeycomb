# PRD-015a: Intercept and Dispatch

> **Parent:** [PRD-015](./prd-015-virtual-filesystem-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** M

## Scope

The `DeepLakeFs` intercept and the stateless PreToolUse hook that present `~/.honeycomb/memory/` as files, classify each path into goal/kpi/memory, and dispatch every read and write as SQL through the daemon, including the read-only sessions, `index.md`, and `graph/` bridges.

## Goals

- Present the team-shared DeepLake store as a browsable directory at `~/.honeycomb/memory/` so agents recall through shell fluency rather than a new API.
- Intercept Bash, Read, Grep, and Glob against the mount in two consumers (the long-lived `DeepLakeFs` and the one-shot PreToolUse hook) that produce the same view.
- Classify every path with `classifyPath` and dispatch the resulting read or write as SQL through the honeycomb daemon, the only DeepLake client.
- Resolve reads through a fixed precedence so the agent always sees its own pending writes and never a stale cache.
- Bridge the read-only sessions table, the synthesized `index.md`, and the `graph/` subtree without inventing real files on disk.

## Non-Goals

- The write batching, flush chain, and goal/kpi lifecycle verbs (PRD-015b).
- The codebase-graph renderers behind `handleGraphVfs` (PRD-014 owns them; this module owns only the bridge wiring).
- DeepLake storage mechanics, SQL escaping helpers, and retry policy (consumed here; owned by the storage module).

## User stories

- As an agent, I want to `ls` and `cat` memory like a directory so that I use recall through shell fluency I already have rather than a new API.
- As an agent, I want a `cat` right after a `Write` to show my own change so that buffered writes are invisible to me.
- As an agent, I want `~/.honeycomb/memory/graph/` to read the local codebase graph so that I can inspect structure without a network call.

## Functional requirements

- **FR-1 Dual intercept, one renderer.** The PreToolUse hook rewrites Claude Code Bash/Read/Grep/Glob one-shot and stateless; the standalone deeplake-shell exposes the same mount through a long-lived `DeepLakeFs` implementing the `just-bash` `IFileSystem`. Both share `buildVirtualIndexContent` (in `src/hooks/virtual-table-query.ts`) as the single rendering source of truth.
- **FR-2 Daemon-only SQL.** Neither consumer opens DeepLake directly; both route every SELECT, INSERT, and flush through the honeycomb daemon on port 3850, scoped by `org`, `workspace`, and `agent_id`.
- **FR-3 Bootstrap in parallel.** `DeepLakeFs.create()` runs `ensureTable`/`ensureGoalsTable`/`ensureKpisTable`, then bootstraps the memory, sessions, goals, and kpis sources in parallel so `ls` and `cat` work immediately against the in-memory tree (the `files`, `meta`, `dirs`, `pending` maps).
- **FR-4 Goal/kpi rows excluded from generic surfacing.** The memory bootstrap registers each row as an unfetched file (`files.set(p, null)`) but skips any goal-shaped or kpi-shaped path when the dedicated tables are configured, so the VFS namespace never re-injects phantom goals the `honeycomb goal list` CLI would not see.
- **FR-5 Path classification.** `classifyPath` (in `src/shell/goal-paths.ts`) strips the mount prefix by the last `/memory/` occurrence and returns `goal` for `memory/goal/<owner>/<status>/<goal_id>.md` (status in `opened`/`in_progress`/`closed`, filename `.md`), `kpi` for `memory/kpi/<goal_id>/<kpi_id>.md`, and `memory` for anything malformed or otherwise.
- **FR-6 Read precedence.** `readFile` resolves content in order: graph VFS bridge, synthesized `index.md`, content cache, pending-write buffer, sessions concatenation, then a direct SQL read of the `summary` column.
- **FR-7 Sessions are read-only.** A session "file" is the many session rows for that path concatenated (`SELECT message ... ORDER BY creation_date ASC`, normalized, newline-joined). `writeFile`, `appendFile`, `rm`, `cp`, and `mv` all reject session paths with `EPERM`.
- **FR-8 Virtual index.** When no real `/index.md` row exists, `generateVirtualIndex` fetches the 50 most-recent summary rows (plus one to detect "more available") and the 50 most-recent session rows grouped by path, and renders a two-section table with per-section truncation notices pointing the agent at Grep.
- **FR-9 Graph bridge.** `DeepLakeFs` detects the `/graph/` prefix before its cache check, strips it, and delegates to `handleGraphVfs` against the local snapshot for the shell's cwd with zero network calls; a `no-graph` result renders as the file body, an unknown endpoint throws `ENOENT`, and `/graph`, `/graph/find`, `/graph/show` are always-true directories.
- **FR-10 Prefetch.** `prefetch` warms the cache for many paths with one query each for the memory and sessions tables, batched at 50 paths per `IN (...)` clause, so a directory walk does not fan out into one query per file.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a read, when it resolves, then precedence is graph bridge, then virtual `index.md`, then cache, then pending buffer, then sessions concatenation, then a direct SQL `summary` read. |
| AC-2 | Given a `/graph/` path, when read, then it delegates to `handleGraphVfs` against the local snapshot with zero network calls, rendering `no-graph` as the body rather than throwing. |
| AC-3 | Given a path, when `classifyPath` runs, then a valid goal/kpi shape returns its kind and any malformed shape returns `memory`. |
| AC-4 | Given a write, `cp`, or `mv` targeting a session path, when attempted, then it is rejected with `EPERM`. |
| AC-5 | Given no `/index.md` row, when the mount root is read, then `generateVirtualIndex` returns a two-section table capped at 50 rows each with a truncation notice. |
| AC-6 | Given any read or write, when it reaches storage, then the SQL is dispatched through the daemon on port 3850, never opened directly. |

## Implementation notes

- Both consumers share the renderer; `classifyPath` strips the mount prefix by the last `/memory/` to accept mount-relative, test-mount, shell-redirect, and host-absolute path shapes.
- The mount is not a literal directory: every read hits cache, pending buffer, or SQL, and no real files exist. The `ensureTable` family is DeepLake lazy schema healing on first touch.
- Sessions bootstrap groups by `path` and takes `MAX(size_bytes)` to work around DeepLake returning NULL for `SUM(size_bytes)` with `GROUP BY`.

## Dependencies

- The honeycomb daemon (port 3850) as the only DeepLake client.
- `handleGraphVfs` and the local codebase-graph snapshot (PRD-014).
- The `sessions`, `memory`, `goals`, and `kpis` tables (created lazily on first touch).

## Open questions

- [ ] Should `prefetch` batching (50 paths per `IN`) adapt to very large directories?

## Related

- [parent index](./prd-015-virtual-filesystem-index.md)
- [Memory Virtual Filesystem](../../../knowledge/private/data/memory-virtual-filesystem.md)
- [Codebase Graph](../../../knowledge/private/data/codebase-graph.md)
