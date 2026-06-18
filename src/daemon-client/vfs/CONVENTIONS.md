# Virtual Filesystem module — CONVENTIONS (PRD-015)

The VFS intercept lives under `src/daemon-client/vfs/`. It presents team memory as files
at `~/.honeycomb/memory/`, classifies each path, and dispatches every read/write as SQL
**through the daemon** on `127.0.0.1:3850`. Wave 1 (015a) shipped the READ side end-to-end
+ the seams; Wave 2 (015b) fills the WRITE path (`write-buffer.ts`).

**Read this file before extending the module.** It is the contract 015b follows.

## The central invariant: dispatch THROUGH the daemon, NEVER open DeepLake directly

This is the one rule the whole PRD is built around (a-AC-6 / D-6 / FR-2), and the security
audit's (Wave 3) first target. `DeepLakeFs` is a THIN CLIENT.

- **Module home = `src/daemon-client/vfs/` ON PURPOSE.** `src/daemon-client` is one of the
  NON-daemon roots `tests/daemon/storage/invariant.test.ts` scans. A stray
  `from ".../daemon/storage"` import here FAILS the build. So the thin-client invariant is
  ENFORCED, not merely a convention — `DeepLakeFs` *cannot compile* if it opens DeepLake.
- **The `DaemonDispatch` seam is the ONLY path out to storage.**
  `interface DaemonDispatch { query(sql, scope): Promise<Rows> }` (`contracts.ts`). The real
  impl POSTs the SQL + scope to the daemon; the fake (`createFakeDaemonDispatch`) records
  every call. There is no other storage path, so a test can assert storage was reached ONLY
  through the seam (and that earlier tiers short-circuited by asserting `.calls` is empty).
- **OK to import (pure, storage-free):** `sqlIdent` / `sLiteral` / `sqlStr`
  (`daemon/storage/sql.ts` — pure string fns, the SQL-injection floor) and `handleGraphVfs`
  (`daemon/runtime/codebase/query.ts` — a pure renderer, zero network). Importing these does
  NOT pull in the storage CLIENT. `npm run audit:sql` proves the SQL we build is escaped.
- **NEVER import** `createStorageClient`, `StorageClient`, or anything under `daemon/storage`
  that opens a connection. Carry `VfsScope` (org/workspace/agent_id) on EVERY dispatch — a
  read/write can never escape its scope because the daemon applies it as a partition filter.

If you find yourself importing the storage client, adding a second path to storage, or
building SQL by hand around the escaping helpers — STOP. That is the wrong direction and a
Critical security finding.

## Read precedence (a-AC-1 / a-AC-2 / FR-6) — `read.ts`

`resolveRead(path, deps)` resolves in a FIXED order; the first tier that can answer wins and
no later tier runs (a cache/pending hit dispatches NO SQL — assert `dispatch.calls` empty):

1. **graph bridge** — a `graph/...` path → render the LOCAL snapshot via `handleGraphVfs`,
   ZERO network, `no-graph` as a BODY (never a throw). Detected BEFORE the cache so the graph
   subtree is never cached as a stale memory body.
2. **virtual `index.md`** — root `index.md` with no real row → `generateVirtualIndex`. A REAL
   `/index.md` memory row wins over the synthesized one.
3. **in-memory cache** — a resolved body already cached → return it (no SQL).
4. **pending-write buffer** — the agent's OWN un-flushed write → return it (cat-after-write).
5. **sessions concatenation** — a `sessions/...` path → concat `message` rows
   `ORDER BY creation_date ASC`.
6. **direct SQL summary** — fall through → `SELECT summary FROM memory WHERE path = ...`.

Tiers 5 and 6 are the only tiers that reach storage; both via the dispatch seam. A missing
memory/session row resolves to `""` (an empty file), never a throw.

## The graph bridge stays zero-network (a-AC-2 / FR-9)

`handleGraphVfs` (PRD-014d) is a PURE renderer that takes an already-loaded `Snapshot`. The
bridge loads the snapshot via the injected `SnapshotLoader` seam (LOCAL disk read; a network
call here would violate the invariant) and hands it to the renderer. When the loader returns
`null` (no built graph), the bridge renders a `no-graph` BODY — it never throws. PRD-014 owns
the renderers; this module owns ONLY the bridge wiring + the local-load seam.

## Sessions are an append-only event log → EPERM (a-AC-4 / D-4 / FR-7)

`write` / `append` / `rm` / `cp` / `mv` targeting a session path (classified `session`) reject
with `SessionPermissionError` (`code === "EPERM"`), at the TOP of every mutating verb, BEFORE
any dispatch — so a session mutation never reaches storage. A session "file" READS as the many
session rows for that path concatenated (tier 5). Do NOT add a session write path.

## Path classification (a-AC-3 / index AC-2 / FR-5) — `classify.ts`

`classifyPath` is PURE. It strips the mount prefix by the LAST `/memory/` (so host-absolute,
test-mount, mount-relative, and shell-redirect shapes all reduce to the same remainder), then:

- `goal/<owner>/<status>/<goal_id>.md` (status in `opened`/`in_progress`/`closed`, `.md`) → `goal`
- `kpi/<goal_id>/<kpi_id>.md` → `kpi`
- `sessions/...` → `session`; `graph/...` → `graph`; root `index.md` → `index`
- **anything malformed or otherwise → `memory`** (the generic fallback — a malformed goal path
  is a memory file, NOT a broken goal; never silently dropped).

## The seam boundaries (what is injected)

`DeepLakeFs` injects all of: `DaemonDispatch` (storage), `VfsScope` (tenancy), `SnapshotLoader`
(graph), and seeds the `ContentCache` + `PendingBuffer` maps (the in-memory tree, FR-3). A test
drives the whole module against a FAKE dispatch + a fixture snapshot — no daemon, no DeepLake.

## What 015b owns — `write-buffer.ts` (STUBBED this wave)

The write path is wired NOW (the buffer shares the SAME dispatch seam + scope + pending map),
so 015b fills the bodies WITHOUT touching `fs.ts`. Each stub throws `notImplemented` so an early
call FAILS LOUD. The 015b contract (D-7 / D-8 / D-9):

- **`enqueue` + `flush` (b-AC-1):** coalesce + flush at 10 pending OR a 200ms debounce
  (`FLUSH_AT_PENDING` / `FLUSH_DEBOUNCE_MS`), SERIALIZED (never interleave), a rejected row
  RE-QUEUED.
- **memory write:** `memory` update-or-insert by `path`. **goal/kpi write (b-AC-6):**
  SELECT-before-INSERT keyed by goal_id (or goal_id, kpi_id). **append (b-AC-5):** SQL-level
  concat + cache-invalidate, NO read-back. **embeddings disabled (b-AC-4):** skip the embed hop,
  write NULL vector columns.
- **`softCloseGoal` (b-AC-2):** `rm` a goal → status→`closed`, row PRESERVED; already-closed =
  no-op. **`transitionGoal` (b-AC-3):** `mv` a goal → status-only differs = transition;
  goal_id or owner differs = EPERM.

Keep every export's signature stable so 015b is a pure fill, not a refactor.

## Daemon + hook assembly is DEFERRED (mirrors PRD-010/011/012 D-9)

Wave 1 is constructed-and-tested, not wired into the running daemon or the PreToolUse hook.
The deferred assembly steps:

1. **The real `DaemonDispatch`** — a thin POST to `127.0.0.1:3850` (the `daemon-client` RPC),
   replacing the fake. SQL in, rows out, scope alongside.
2. **The PreToolUse hook** — the one-shot, stateless intercept that rewrites Claude Code
   Bash/Read/Grep/Glob against the mount, lowers each into an `FsOp`, and calls `DeepLakeFs`
   (or the shared renderer). It produces the SAME view as the long-lived shell (FR-1).
3. **The real `SnapshotLoader`** — reads the atomic snapshot file the PRD-014 build wrote for
   the shell's cwd (LOCAL disk), replacing the fake.

These are pure wiring steps; no module body changes.
