# PRD-015: Virtual Filesystem

> **Status:** In-Work
> **Priority:** P2
> **Effort:** M
> **Schema changes:** None

---

## Overview

Coding agents already know how to `cat`, `ls`, `grep`, and `find`. The virtual filesystem leans on that fluency: instead of teaching every assistant a new recall API, it presents memory as files under `~/.honeycomb/memory/` and intercepts the shell commands that touch that mount. From the agent's point of view it is browsing files; underneath, each operation is a SQL query, dispatched through the honeycomb daemon (the only DeepLake client), against the team-shared, multi-tenant tables scoped by org, workspace, and `agent_id`. The mount is not a literal directory: every read hits an in-memory cache, a pending-write buffer, or SQL, and every write is buffered and flushed on a timer. This module covers the `DeepLakeFs` intercept and path classification that routes each path to the `goals`, `kpis`, or generic `memory` table, the batched-and-debounced write path, the goal/kpi lifecycle expressed through filesystem verbs (`rm` as soft-close, `mv` as status transition), and the synthesized `index.md`, sessions, and `graph/` bridges.

## Goals

- Present memory as a browsable filesystem and intercept Bash/Read/Grep/Glob against the mount, dispatching every operation as SQL through the daemon.
- Classify each path into goal, kpi, or memory and route reads and writes to the correct backing table.
- Batch and debounce writes (flush at 10 pending or 200 ms) and serialize flushes so they never interleave.
- Express the goal and kpi lifecycle through filesystem verbs, with `rm` as soft-close and `mv` as a status transition.

## Non-Goals

- The codebase-graph renderers behind the `graph/` bridge (PRD-014 owns them; this module owns the bridge wiring).
- DeepLake storage mechanics and SQL escaping helpers (consumed here; owned by the storage module).
- Defining new recall ranking (retrieval module).

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-015a-virtual-filesystem-intercept-dispatch`](./prd-015a-virtual-filesystem-intercept-dispatch.md) | VFS intercept, path classification, and SQL dispatch. | Draft |
| [`prd-015b-virtual-filesystem-batching-goals-kpis`](./prd-015b-virtual-filesystem-batching-goals-kpis.md) | Write batching and the goals/kpis path lifecycle. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a `cat` of a memory path, when it resolves, then content comes from the cache, pending buffer, sessions concatenation, or a direct SQL read, dispatched through the daemon. |
| AC-2 | Given a path, when `classifyPath` runs, then a valid goal/kpi shape routes to the structured table and any malformed shape falls back to the generic `memory` table. |
| AC-3 | Given a write to a session path, when attempted, then it is rejected with `EPERM` because sessions are an append-only event log. |

## Data model changes

None. Reads and writes target the existing `sessions`, `memory`, `goals`, and `kpis` tables; tables are created lazily on first touch.

## API changes

None new at the daemon HTTP level beyond the existing flush dispatch; the surface is the filesystem mount and the PreToolUse hook intercept.

## Open questions

- [ ] Should the batch size (10) and debounce (200 ms) be configurable, or are the defaults fixed?
- [ ] How should the VFS surface conflicts when two agents flush the same generic path concurrently?
- [ ] Should `prefetch` batching (50 paths per `IN`) adapt to very large directories?

## Related

- [Memory Virtual Filesystem](../../../knowledge/private/data/memory-virtual-filesystem.md)
- [Codebase Graph](../../../knowledge/private/data/codebase-graph.md)
- [Schema](../../../knowledge/private/data/schema.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
