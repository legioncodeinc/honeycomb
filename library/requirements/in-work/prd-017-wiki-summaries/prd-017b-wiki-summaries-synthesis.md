# PRD-017b: MEMORY.md Synthesis and Thread Heads

> **Parent:** [PRD-017](./prd-017-wiki-summaries-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

Synthesize a top-level `MEMORY.md` index and per-thread heads from the per-session summary rows, so recall and link-following surface structure rather than a flat list of sessions.

## Goals

- Build a top-level `MEMORY.md` that links to the relevant per-session summaries so recall navigates by structure.
- Maintain per-thread heads that group related work above the flat list of sessions.
- Keep synthesis consistent under DeepLake's UPDATE-coalescing behavior by reusing the summary worker's write path.
- Handle resumed sessions so a thread head reflects the merged session rather than duplicating an entry.

## Non-Goals

- Generating the per-session summaries themselves (PRD-017a).
- The retrieval ranking that orders results (owned by the retrieval module).
- The VFS read precedence that surfaces these files (owned by PRD-015).

## User stories

- As an agent, I want a synthesized `MEMORY.md` and thread heads so that I can navigate prior work by topic instead of scanning every session summary.
- As an agent, I want a resumed session to update its existing thread head so that the index does not show duplicate entries.
- As an operator, I want synthesis to go through the daemon so that there is still exactly one DeepLake client.

## Functional requirements

- **FR-1 Read summaries through the daemon.** Synthesis reads existing per-session summary rows from the `memory` table (under `/summaries/<userName>/<sessionId>.md`) through the honeycomb daemon (port 3850); it never opens DeepLake directly.
- **FR-2 Write `MEMORY.md`.** When one or more session summaries exist, synthesis writes a top-level `MEMORY.md` under the memory path that links to the relevant summaries, surfaced by the VFS link-following and Grep surface.
- **FR-3 Thread heads.** Synthesis writes per-thread head rows that group related sessions, so an agent can navigate by topic rather than scanning a flat session list.
- **FR-4 Resume dedup.** When a session is resumed across `--resume`/`--continue`, synthesis updates the existing thread head to reflect the merged session rather than creating a duplicate entry, keyed by the stable session identifier.
- **FR-5 Consistent write path.** Synthesis reuses the summary worker's SELECT-before-INSERT write path so it stays consistent under DeepLake's UPDATE coalescing against freshly written rows.
- **FR-6 Daemon-only writes.** Both the `MEMORY.md` index and the thread-head rows are written back through the daemon; the worker never opens DeepLake directly.
- **FR-7 Link format.** `MEMORY.md` links use the mount-relative summary paths so an agent following a link lands on the per-session summary via the VFS read precedence.
- **FR-8 Tenancy scoping.** Synthesis reads and writes are scoped by `org`, `workspace`, and `agent_id` so each tenant sees only its own index and thread heads.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given one or more session summaries exist, when synthesis runs, then a `MEMORY.md` is written under the memory path linking to the relevant summaries. |
| AC-2 | Given a session is resumed across `--resume`/`--continue`, when synthesis runs, then its thread head reflects the merged session rather than duplicating an entry. |
| AC-3 | Given synthesis runs, when it reads and writes, then every operation is dispatched through the daemon, never a direct DeepLake connection. |
| AC-4 | Given an existing `MEMORY.md` or thread-head row, when synthesis re-runs, then it uses SELECT-before-INSERT rather than an in-place UPDATE. |
| AC-5 | Given a `MEMORY.md` link, when an agent follows it, then it resolves to the linked per-session summary through the VFS read precedence. |
| AC-6 | Given two tenants, when each runs synthesis, then each `MEMORY.md` reflects only its own org/workspace/agent-scoped summaries. |

## Implementation notes

- Synthesis reads existing summary rows from the `memory` table through the daemon and writes the index and thread-head rows back through the daemon; it never opens DeepLake directly.
- Reuse the same SELECT-before-INSERT write path as the summary worker to stay consistent under DeepLake UPDATE coalescing.
- Thread heads are keyed by the stable session identifier so resumed sessions merge rather than duplicate; the index link format uses mount-relative summary paths.

## Dependencies

- PRD-017a for the per-session summary rows.
- The honeycomb daemon (port 3850) and the `memory` table.
- PRD-015 for the VFS read precedence that surfaces `MEMORY.md` and its links.

## Open questions

- [ ] Should `MEMORY.md` synthesis run on every summary write or on its own debounced schedule?
- [ ] How are thread heads keyed when a session is resumed across `--resume`/`--continue`?

## Related

- [parent index](./prd-017-wiki-summaries-index.md)
- [Wiki Summary Workers](../../../knowledge/private/ai/wiki-summary-workers.md)
- [Memory Virtual Filesystem](../../../knowledge/private/data/memory-virtual-filesystem.md)
