# `src/daemon/runtime/memories` — CONVENTIONS (PRD-022a)

The `/api/memories/*` data-access API: the mount seam + the thin adapters that wire
the EXISTING recall and write engines to their HTTP routes. This is **wiring only**
(ledger D-1): no new business logic, no new write policy, no new DeepLake schema.

## What lives here

| File | Owns |
|---|---|
| `api.ts` | `mountMemoriesApi(daemon, { storage, ... })` — the mount seam (mirrors `mountDashboardApi`). Zod bodies, scope resolution, route handlers. |
| `recall.ts` | `recallMemories` — the lexical UNION ALL over `memories` + `memory` + `sessions` (BM25/ILIKE fallback, embeddings off). The recall engine adapter for `POST /api/memories/recall`. |
| `store.ts` | `storeMemory` / `modifyMemory` / `forgetMemory` — call the existing `controlled-writes.ts` engine; modify/forget are version-bumped + write an audited `memory_history` row. |
| `reads.ts` | `getMemory` / `listMemories` — guarded reads of the `memories` table. |
| `index.ts` | The barrel. 022d imports `mountMemoriesApi` from here. |

## The mount seam (022d calls this)

```ts
mountMemoriesApi(daemon, { storage /* StorageQuery */, embed? /* EmbedClient */ });
```

- Call ONCE after `createDaemon(...)`, exactly like `mountDashboardApi(daemon, { storage })`.
- The `/api/memories` route group is ALREADY mounted in `server.ts` (`ROUTE_GROUPS`,
  `protect: true, session: true`). The seam attaches via `daemon.group("/api/memories")`
  and inherits the runtime-path + permission middleware with zero re-wiring. No `server.ts` edit.
- `embed` defaults to the no-op (`noopEmbedClient`) so a stored row lands with
  `content_embedding` NULL and stays lexically recallable (embeddings off, ledger D-4).

## ⚠️ Session-group requirement — `x-honeycomb-session` (a-AC-6 / FR-8)

`/api/memories` is a **SESSION group**. The runtime-path middleware in front of it
**requires the `x-honeycomb-session` header**. A request without it is rejected by the
middleware **before any handler here runs**.

**022d MUST make the clients stamp `x-honeycomb-session`** (a synthetic per-invocation id
for the stateless one-shot CLI verbs): `honeycomb recall`, the SDK `recall()`, and the MCP
`memory_search`/store. This is the root of the 022d session-header client bug noted in the
ledger. The unit tests + the live itest in this PRD stamp the header.

## Routes

| Method + path | Engine | AC |
|---|---|---|
| `POST /api/memories/recall` | `recallMemories` (lexical UNION ALL) | a-AC-2 |
| `POST /api/memories` | `storeMemory` → controlled-writes ADD | a-AC-3 |
| `GET /api/memories` | `listMemories` (scoped, newest first) | FR-4 |
| `GET /api/memories/:id` | `getMemory` (latest version, not tombstoned) | FR-4 |
| `POST /api/memories/:id/modify` | `modifyMemory` (version-bump + audit) | a-AC-4 |
| `POST /api/memories/:id/forget` | `forgetMemory` (soft-delete + audit) | a-AC-4 |

## Hard rules

- **Zod at the boundary (a-AC-5):** every body is `safeParse`'d; a malformed body is a
  400 BEFORE the engine. `modify`/`forget` require a non-empty `reason` (zod-enforced).
- **Reason-gated + audited mutations (a-AC-4):** modify/forget write an append-only
  `memory_history` row (`changed_by = 'harness'`, the operation, the reason). No silent mutation.
- **Append-only, never in-place UPDATE:** modify/forget go through the controlled-writes
  version-bump path (the DeepLake-coalesces-UPDATE lesson). `forget` is a tombstone
  (`is_deleted = 1`), not a row delete.
- **Tenancy fail-closed (FR-7):** scope is resolved from `x-honeycomb-org` /
  `x-honeycomb-workspace`; no org → 400. Every read/write rides the resolved `QueryScope`.
- **SQL safety (`audit:sql`):** every value through `sqlIdent` / `sqlLike` / `sLiteral` /
  `val.*`; no hand-quoted SQL; storage reached ONLY through the injected `StorageQuery`.
- **Daemon-only:** this dir may import `daemon/storage`; it is daemon-side and stays
  behind the daemon-only invariant (`tests/daemon/storage/invariant.test.ts`).

## Not owned here

- The `assembleSeams()` call site that fires `mountMemoriesApi` once → **022d**.
- The `/memory/*` VFS browse reads → **022b**.
- The goals/KPIs/skills/rules/sources/secrets routes → **022c**.
- The CLI/SDK/MCP client fixes (the session-header stamp) + the dogfood proof → **022d/022e**.
