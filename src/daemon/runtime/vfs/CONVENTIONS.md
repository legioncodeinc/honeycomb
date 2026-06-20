# VFS browse API (daemon side) — CONVENTIONS (PRD-022b)

`mountVfsApi` (`api.ts`) is the daemon-side seam serving the `/memory/*` browse READS. It mirrors
`mountDashboardApi` (020b): the daemon assembly (022d `assembleSeams`) calls it ONCE after
`createDaemon(...)`, and it attaches handlers onto the ALREADY-MOUNTED `/memory` route group via
`daemon.group("/memory")` — ZERO `server.ts` edits. The `/memory` group is scaffolded + protected as
a SESSION group in `server.ts` (runtime-path negotiation + permission), so attaching inherits
auth/RBAC + the session middleware. A session-scoped request therefore carries
`x-honeycomb-runtime-path` (`plugin`/`legacy`) AND `x-honeycomb-session` in addition to
`x-honeycomb-org`/`-workspace`.

**Who dispatches here.** The PRD-015 `DeepLakeFs` client, the hooks pre-tool-use VFS intercept, and
the MCP browse trio (`honeycomb_search` / `honeycomb_read` / `honeycomb_index`) all dispatch to these
routes. This is the single daemon-side `/memory/*` read surface.

**The routes (b-AC-1..6).**

| AC | Route | Reads | Engine |
|----|-------|-------|--------|
| b-AC-1 cat | `GET /memory/cat?path=<p>` | `memory.summary` for the path | `memory` table row read |
| b-AC-2 grep | `GET /memory/grep?q=<q>` | hybrid search → hydrate `memories.content` | PRD-007 recall `collectCandidates` |
| b-AC-3 ls | `GET /memory/ls?prefix=<p>` | `memory` entries under the prefix | `memory` table prefix `ILIKE` |
| b-AC-4 find | `GET /memory/find?pattern=<p>` | `memory` rows whose path matches | `memory` table path `ILIKE` |
| b-AC-5 classify | `GET /memory/classify?path=<p>` | — (pure) | PRD-015 `classifyPath` |
| b-AC-6 write-deny | `POST\|PUT\|PATCH\|DELETE /memory/*` | — | 405 + guidance → `/api/memories` |

**The two tables.** `cat`/`ls`/`find` read the **`memory`** table (PRD-003c MEMORY_COLUMNS:
`path`/`summary`/`filename`), the SAME table the PRD-015 client `read.ts` (`buildMemorySummarySql`)
and `index-gen.ts` (`buildRecentMemoriesSql`) read — so daemon-side browse is byte-consistent with the
thin-client VFS. `grep` is the ONE handler that reuses the recall engine: PRD-007 ranks over the
**`memories`** ENGINE table's `content`, because grep is a hybrid SEARCH, not a path read (FR-3).

**Classification parity (b-AC-5).** The daemon-side router imports the PURE `classifyPath` from the
PRD-015 client (`src/daemon-client/vfs/classify.ts`) — the SAME contract the client uses, so a path
classifies identically on both sides. Importing `classifyPath` is safe: it is pure (no IO, no storage,
no daemon-dispatch). The daemon-client VFS DISPATCH (`fs.ts` / `read.ts`) is NOT imported here.

**The silent fallback (b-AC-2).** `grep` reuses `collectCandidates` with NO embed client injected, so
the vector channel is skipped and recall runs the BM25/ILIKE lexical floor — `degraded:true` is carried
through to the `GrepResult` so the silent fallback is observable, never a silent failure (D-4 /
PRD-007 a-AC-3). A follow-up wires the embed seam for semantic browse.

**Read-only (b-AC-6).** The `/memory` VFS is a read-only projection. Every mutating method on any
`/memory/*` path is denied with a 405 + actionable guidance naming the audited `/api/memories` write
routes (022a), which record provenance in `memory_history`. The write-deny guard is registered FIRST
so a write verb can never fall through to a read handler.

**Storage-correct.** This lives under `src/daemon/` (the only DeepLake client). Each handler reads
through the injected `StorageQuery`, building guarded SQL with the pure `sql.ts` helpers (`sqlIdent` /
`sLiteral` / `sqlLike`). No handler opens a raw connection; every interpolated value goes through a
guard. `audit:sql` scans `src/daemon`; `invariant.test.ts` stays green.

**Fail-closed / fail-soft.** No resolvable org → 400 (fail-closed; an unscoped browse never falls back
to a broad read). A missing required query param → 400. A non-ok storage result → empty rows (fail-soft;
one storage hiccup never throws the whole browse).

**Deferred assembly (D-2 / 022d).** `mountVfsApi` is constructed-and-tested here against a fake (but
real) `StorageQuery`; nothing auto-invokes it by importing the daemon. 022d fires it once in
`assembleSeams`.

**The `mountVfsApi` signature (the 022d contract).**

```ts
mountVfsApi(daemon: Daemon, options: {
  storage: StorageQuery;        // required — the read seam
  recallConfig?: RecallConfig;  // defaults to resolveRecallConfig() (env)
  hints?: HintSource;           // defaults to the recall empty hint source
}): void
```
