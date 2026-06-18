# Security Audit — PRD-015 Virtual Filesystem

- **Date:** 2026-06-18
- **Auditor:** security-worker-bee (proactive penultimate step, before quality-worker-bee)
- **Branch:** `prd-015-virtual-filesystem`
- **Scope audited:** `src/daemon-client/vfs/` (contracts.ts, classify.ts, read.ts, index-gen.ts, fs.ts, write-buffer.ts, index.ts), the modified `tests/daemon/storage/invariant.test.ts`, `tests/daemon-client/vfs/dispatch-invariant.test.ts`, the SQL floor `src/daemon/storage/sql.ts`, and the graph bridge `src/daemon/runtime/codebase/query.ts`.

## Executive Summary

**VERDICT: PASS. quality-worker-bee is CLEARED to run.**

PRD-015's VFS is a structurally-sound thin client. The headline concern — that the refined
`invariant.test.ts` exemption opened a hole letting non-daemon code reach DeepLake — is
**unfounded**: the exemption is sound and the invariant still holds, doubly enforced. Scope
isolation, path-traversal containment, session append-only EPERM, SQL-injection escaping,
goal/kpi lifecycle integrity, and the zero-network graph bridge all hold affirmatively and
adversarially.

**0 Critical · 0 High · 1 Medium · 2 Low.** One defense-in-depth fix applied (the only one
warranted): the `audit:sql` CI gate did not scan `src/daemon-client/`, the new home of the
VFS SQL builders — fixed so the gate now covers them. No Critical/High findings existed to
remediate. Coverage is FULL (no reduced-coverage flag).

Ordering check: no prior `quality-worker-bee` report exists for this branch — security ran
first, correctly. Gates re-run clean after the fix (see Gate Results).

---

## Severity Counts

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 1 (fixed) |
| Low | 2 (documented) |

---

## The Invariant-Change Verdict (#1 priority) — SOUND, not a hole

The PRD-015 refinement to `tests/daemon/storage/invariant.test.ts` exempts ONLY the pure
`daemon/storage/sql.ts` from the no-storage-import ban, strips comments before scanning, and
keeps the client/barrel/writes/heal/catalog banned. I scrutinized it both ways.

**Affirmative proof the guarantee "no non-daemon code can open a DeepLake connection" still holds:**

- `src/daemon/storage/sql.ts:1-138` is **pure and import-free** — verified zero `import`/`require`
  (`grep` returns nothing). It is string escaping only (`sqlStr`/`sqlLike`/`sqlIdent`/`sLiteral`/
  `eLiteral`/`sqlColumnList`). Importing it pulls in **no** connection, transport, or `node:` IO.
  So the exemption cannot transitively import a client.
- The VFS imports from the daemon are EXACTLY three, all connection-free (verified by grep over
  `src/daemon-client/vfs/`):
  - `daemon/storage/sql.js` — pure escaping (read.ts:21, index-gen.ts:23, write-buffer.ts:48).
  - `daemon/runtime/codebase/query.js` — the pure `handleGraphVfs` renderer (read.ts:19).
  - `daemon/runtime/codebase/contracts.js` — a `type Snapshot` import only (read.ts:20).
- `handleGraphVfs` (`query.ts:148`) is pure: grep for `readFile|fetch|http|fs.|node:net|process.|spawn|exec`
  returns **nothing** — it renders from the in-memory `Snapshot`, no FS/network/process.

**Adversarial proof the regex can't be bypassed.** The deny-regex
`/from\s+["'][^"']*daemon\/storage\/(?!sql(?:\.js)?["'])[^"']*["']/` exempts only an exact
`…/sql` or `…/sql.js` specifier. I tested 14 import shapes against the real regex + comment-strip:

| Import attempt | Result | Correct? |
|---|---|---|
| `daemon/storage/sql.js` / `…/sql` | allowed | yes (pure) |
| `…/storage/client.js`, `…/writes.js`, `…/heal.js`, `…/vector`, `…/result` | **banned** | yes |
| `…/storage` (bare barrel), `…/storage/index.js` | **banned** | yes (barrel re-exports client) |
| `…/storage/catalog/foo.js` | **banned** | yes |
| `…/storage/sqlx.js` (sql-PREFIXED name) | **banned** | yes — lookahead requires `sql` then `.js"`/quote; `x` fails it |
| `…/storage/sql/client.js` (sql-named DIR) | **banned** | yes — `sql/` fails the lookahead |
| `…/storage/client.sql.js` (sql-SUFFIXED) | **banned** | yes |
| `daemon/storage/client` mentioned in `//` or `/* */` comment | allowed | yes — comment-strip removes prose mentions, not real imports |
| multiline `import {\n createStorageClient\n} from "…/client.js"` | **banned** | yes |

The comment-strip cannot hide a real import: it removes only `//…` and `/*…*/` spans; a live
`import … from "…"` statement is never inside a comment. The only exempted specifier is the
exact pure module.

**Belt-and-braces:** `tests/daemon-client/vfs/dispatch-invariant.test.ts` enforces the same
property a SECOND time with a stricter **allowlist** (positive match): every `daemon/` import
in the VFS must match `daemon/storage/sql\.js | daemon/runtime/codebase/(query|contracts)\.js`.
A malicious import that somehow evaded the deny-regex would still fail this allowlist. The
invariant is doubly enforced. **Conclusion: SOUND — no hole.**

---

## Dimension Conclusions

### 1. Scope isolation (org/workspace/agent_id) — SOUND
Every `dispatch.query(sql, scope)` call passes the **trusted, constructor-injected** `scope`
(`DeepLakeFsOptions.scope` → `ReadDeps.scope` / `WriteBufferDeps.scope`). Verified: all 14
dispatch sites pass `scope`/`deps.scope`; there is **no** code path that derives or mutates the
scope from the path or body (grep for scope assignment returns only the injected wiring). A
crafted path changes only the SQL `WHERE path = …` predicate, never the tenancy partition — the
daemon applies org/workspace/agent as a partition filter alongside the dispatched SQL. A crafted
path cannot widen scope. (Note: the `agent_id` written in `buildGoalInsertSql` is the goal's
*owner* path segment — a data column, escaped via `sLiteral` — distinct from the tenancy
`scope.agentId`; not a scope-isolation concern.)

### 2. Path traversal / mount escape — SOUND
`toMountRelative` does not normalize `..`, but the mount-relative remainder is **never used as a
host FS path**. It is only ever (a) an `sLiteral`-escaped SQL **value** in `WHERE path = …`, or
(b) input to the pure `classifyPath` router. Adversarial inputs (`../../etc/passwd`,
`/etc/passwd`, `goal/../../../etc/passwd.md`, `memory/../sessions/x`) reduce to literal strings
that match no row and route to `memory`/empty — there is no `fs.readFile`, so no host file is
reachable. The **table name is always a hardcoded `sqlIdent` literal** (`memory`/`goals`/`kpis`/
`sessions`) — the path never selects the table, so no out-of-mount table is addressable. The
graph tier (`resolveGraph`) loads via `SnapshotLoader.load()` which takes **no path argument**
(cwd-scoped) and renders via the pure, FS-free `handleGraphVfs`. No traversal escape.

### 3. Session append-only EPERM (a-AC-4) — SOUND
`guardSession` runs at the TOP of every mutating verb BEFORE any dispatch (fs.ts:158-162), and
cp/mv guard BOTH `from` and `to` (fs.ts:133-150). Adversarial session paths in every accepted
shape (`sessions/…`, host-absolute `/…/memory/sessions/…`, `memory/sessions/…`, leading-slash,
bare `sessions`) all classify `session` → EPERM. **Structural backstop:** the `sessions` table
is referenced by exactly two builders, both **read-only SELECTs** (`buildSessionsConcatSql`,
`buildRecentSessionsSql`) — there is **no** INSERT/UPDATE/DELETE against `sessions` anywhere in
the VFS. Even an uppercase `SESSIONS/x` that classifies `memory` writes to the `memory` table,
never the append-only log. A session can never be mutated through the VFS.

### 4. SQL injection — SOUND
The escaping floor (`sql.ts`) doubles backslashes then quotes and strips control chars, so
`'; DROP TABLE goals; --` collapses to one inert literal. In the VFS, **every** value goes
through `sLiteral`/`eLiteral` and **every** identifier is a hardcoded string literal through
`sqlIdent` (verified: no `sqlIdent` call takes a non-literal arg). Adversarial payloads in
`goal_id`/`owner`/`path`/`kpi_id`/append-body are escaped at the literal boundary. The
`appendFile` concat `summary = summary || E'…'` (write-buffer.ts:486-490) escapes the appended
tail via `eLiteral` — the only interpolated part is the pre-escaped tail; `summary` and the
table/column are identifiers. `floatArrayLiteral` filters to finite numbers via `String(n)` — no
string interpolation surface. `npm run audit:sql` passes over the VFS (see Medium-1 for the
gate-coverage fix).

### 5. Goal/kpi lifecycle integrity — SOUND
`mv` cannot re-key or re-own: `transitionGoal` throws `GoalTransitionError` (EPERM) when
`goalId` or `owner` differ (write-buffer.ts:420-425); only a status-only move dispatches an
UPDATE. `rm` soft-closes: `softCloseGoal` issues `UPDATE … SET status='closed'` preserving the
row, and is a no-op on an already-closed goal (write-buffer.ts:391-404). **Zero hard deletes:**
grep for `DELETE FROM|DROP TABLE|TRUNCATE` across the VFS returns nothing. No path hard-deletes a
row.

### 6. Zero-network graph bridge (a-AC-2) — SOUND
`resolveGraph` (read.ts:120-132) loads only a LOCAL snapshot via the injected `SnapshotLoader`
and delegates to the pure `handleGraphVfs`. `query.ts` has no FS/network/process access (proven
in the invariant section). `null` snapshot renders a `no-graph` BODY, never throws. Detected as
tier 1 BEFORE the cache so a graph path is never cached as a stale memory body.

---

## Findings

### MEDIUM-1 (FIXED) — `audit:sql` CI gate did not cover the VFS SQL builders
- **Where:** `scripts/audit-sql-safety.mjs:48` (default `SCAN_DIR = "src/daemon"`); the VFS builds
  all its SQL in `src/daemon-client/vfs/{read,index-gen,write-buffer}.ts`, **outside** `src/daemon`.
- **Issue:** PRD-015 moved SQL-string construction into `src/daemon-client/`, but the CI gate that
  is "the teeth behind the escaping convention" only scanned `src/daemon`. The VFS SQL is safe
  **today** (verified manually + by running the gate against the dir explicitly: 0 findings), but a
  future raw-interpolation regression in a VFS builder would **not** fail CI. Defense-in-depth gap.
- **Severity rationale:** Medium, not High — no live injection exists; this is a missing guardrail
  over correct code, not a present vulnerability. Fix is <5 lines, so remediated in-session per the
  Medium rule.
- **Fix applied:** `scripts/audit-sql-safety.mjs` now scans BOTH `src/daemon` and
  `src/daemon-client` by default (`SCAN_DIRS = ["src/daemon", "src/daemon-client"]`); an explicit
  dir argument still narrows for a focused re-scan. Gate now scans 121 files (was 112), incl. the 9
  VFS files, and passes. Intent: lock the escaping property over the thin-client SQL builders going
  forward. (file:line — `scripts/audit-sql-safety.mjs:47-56` and `:438-447`.)

### LOW-1 (DOCUMENTED) — sessions-concat read has no `LIMIT`
- **Where:** `src/daemon-client/vfs/read.ts:143-153` (`buildSessionsConcatSql`).
- **Issue:** The sessions-concat tier SELECTs **every** `message` row for a path (`ORDER BY
  creation_date ASC`, no `LIMIT`). `generateVirtualIndex` is correctly capped (≤51 fetch / ≤50
  render + truncation notice, a-AC-5) and `buildMemorySummarySql` has `LIMIT 1`, but a long-running
  session's `cat` loads the entire turn history into client memory and joins it.
- **Severity rationale:** Low. The threat actor is the local agent reading its own tenant-scoped
  session (not a remote party); row count is bounded by real session length. Not changed in this
  pass because a `LIMIT` alters AC-adjacent observable behavior (silent truncation of a session
  `cat` without a notice) — a product decision, not a pure security fix. Minimal-blast-radius
  principle: documented, not silently altered.
- **Recommendation:** consider a bounded fetch + truncation notice mirroring `generateVirtualIndex`,
  decided alongside the product owner.

### LOW-2 (DOCUMENTED) — write buffer has no absolute size cap / per-flush concurrency cap
- **Where:** `src/daemon-client/vfs/write-buffer.ts:235-300` (`enqueue`/`doFlush`).
- **Issue:** The pending map is keyed by path (same-path writes coalesce) and flushes immediately at
  ≥10 pending or after a 200ms debounce, so it is bounded under normal operation. But there is no
  **absolute** cap on the number of DISTINCT pending paths, and `doFlush` dispatches the entire
  batch via `Promise.allSettled` with no per-flush concurrency limit (unlike the daemon's
  `Semaphore(5)`). A flood of writes to many distinct paths (or a permanently-rejecting backend that
  re-queues) could grow the map and fan out many concurrent daemon POSTs.
- **No infinite loop:** confirmed — a re-queued reject does NOT re-arm a flush or recurse; it waits
  for the next natural `enqueue`/`flush`. The re-queue is a bounded retry, not a spin.
- **Severity rationale:** Low. Client-side, per-shell-session, driven by the agent's own writes; the
  daemon enforces its own `Semaphore(5)` + rate limiting downstream; appends coalesce into one
  entry. Real blast radius is small.
- **Recommendation:** optional hardening — an absolute pending-size ceiling (back-pressure) and a
  concurrency cap on the flush fan-out.

---

## Gate Results (re-run after the fix)

| Gate | Command | Exit |
|---|---|---|
| Full CI | `npm run ci` (typecheck + jscpd + vitest + audit:sql) | **0** — 1060 passed / 4 skipped |
| Build | `npm run build` (tsc + esbuild) | **0** — 1 daemon + 5 hook + 1 OpenClaw + 1 MCP + 1 CLI + 1 embed bundle |
| OpenClaw bundle scan | `npm run audit:openclaw` | **0** — no findings |
| SQL safety | `npm run audit:sql` | **0** — 121 files (incl. VFS) clean |
| Invariant tests | `vitest run tests/daemon/storage/invariant.test.ts tests/daemon-client/vfs/` | **0** — invariant (3) + dispatch-invariant (2) + 65 VFS tests pass |

No AC test was weakened. The only file I changed is `scripts/audit-sql-safety.mjs` (the
`invariant.test.ts` and prd-015 index `.md` working-copy changes are the branch's own PRD-015
implementation, not mine). `git diff scripts/audit-sql-safety.mjs` is the clean, minimal artifact.

---

## Verdict

**PASS — 0 Critical, 0 High, 1 Medium (fixed), 2 Low (documented). quality-worker-bee is CLEARED.**

The invariant change is sound (not a hole); scope isolation, path-traversal containment, session
EPERM, SQL escaping, lifecycle integrity, and the zero-network graph bridge all hold. The single
applied fix closes a CI defense-in-depth gap over correct code. All gates green.
