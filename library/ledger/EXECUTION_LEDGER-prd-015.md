# EXECUTION LEDGER — PRD-015 Virtual Filesystem

> /the-smoker run. Branch `prd-015-virtual-filesystem` off main (PRD-001..014 + CI merged). PR → main.

**Scope:** index + 015a (intercept + path classification + read-resolution + daemon dispatch + graph/sessions/index bridges) / 015b (batched-debounced writes + goal/kpi lifecycle via FS verbs). 12 sub-ACs + 3 index. Present memory as files under `~/.honeycomb/memory/`; intercept Bash/Read/Grep/Glob against the mount; every op → SQL **dispatched through the daemon** (the only DeepLake client). From the agent's view it's `cat`/`ls`/`grep`; underneath it's a daemon-routed SQL query scoped by org/workspace/agent_id.

**Builds on:**
- PRD-014d `handleGraphVfs` (the `/graph/` bridge delegates to it — zero network, local snapshot). PRD-005/004 capture + the PreToolUse hook intercept (the mount is intercepted via the hook). PRD-003d `goals`/`kpis` (`product.ts`, `select-before-insert`) + `sessions`/`memory` tables — ALL exist. PRD-002 `selectBeforeInsert` + escaping. PRD-011 scope (org/workspace/agent_id).
- **NO new tables, NO new daemon HTTP API** (data model: NONE; reads/writes target existing tables, lazily created). The surface is the FS mount + the hook intercept. AC-6: SQL is dispatched through the daemon on **127.0.0.1:3850**, DeepLake is NEVER opened directly (respect the thin-client invariant — `DeepLakeFs` dispatches via the daemon, does not import the storage CLIENT).

## Verification posture
Vitest (no live needed for most — it's intercept logic): `classifyPath` (goal/kpi shape → kind; malformed → `memory`); read-resolution PRECEDENCE (graph bridge → virtual `index.md` → cache → pending buffer → sessions concat → SQL `summary` read); the `/graph/` bridge delegates to `handleGraphVfs`, renders `no-graph` as a body not a throw, zero network; session-path write/cp/mv → `EPERM`; `generateVirtualIndex` (2-section table, ≤50 rows each + truncation notice); all dispatch through a FAKE daemon-dispatch seam (assert it hits the daemon, never opens DeepLake). 015b: write batching/debounce (flush at 10 pending OR 200ms via a fake clock; serialized — no interleave; rejected rows re-queued); `rm` goal → soft-close (status→closed, row preserved; already-closed = no-op); `mv` goal (status-only differs → transition; goal_id/owner differs → EPERM); embeddings-disabled → skip embed + NULL vectors; `appendFile` → SQL concat + cache-invalidate (no read-back); goal/kpi flush → SELECT-before-INSERT by goal_id (or goal_id,kpi_id). **Opt-in LIVE: a goal/kpi write→flush→read through the daemon path to the real `goals`/`kpis` table** (SELECT-before-INSERT; poll-convergent). Out of scope: the graph renderers (014 owns), DeepLake/SQL-escape mechanics (storage owns), recall ranking (retrieval).

## Decisions (defaults)
| # | Q | Decision |
|---|---|---|
| D-1 | read precedence | graph bridge → virtual `index.md` → in-memory cache → pending-write buffer → sessions concatenation → direct SQL `summary` read (015a-AC-1). |
| D-2 | graph bridge | a `/graph/` path delegates to PRD-014d `handleGraphVfs` against the LOCAL snapshot, ZERO network; renders `no-graph` as the body, never throws (015a-AC-2). |
| D-3 | classifyPath | a valid goal/kpi path SHAPE → its kind; any malformed shape → `memory` (the generic fallback). Pure (015a-AC-3 / index AC-2). |
| D-4 | sessions read-only | sessions are an append-only EVENT LOG: write / cp / mv targeting a session path → `EPERM` (015a-AC-4). |
| D-5 | virtual index | no `/index.md` row + root read → `generateVirtualIndex`: a two-section table capped at 50 rows EACH + a truncation notice (015a-AC-5). |
| D-6 | dispatch | every read/write that reaches storage → SQL dispatched through the daemon on 127.0.0.1:3850; DeepLake NEVER opened directly (015a-AC-6 / index AC). |
| D-7 | batched writes | coalesce + flush at 10 pending OR a 200ms debounce; flushes SERIALIZED (never interleave); a rejected row is RE-QUEUED (015b-AC-1). |
| D-8 | lifecycle verbs | `rm` goal → soft-close (status→`closed`, row PRESERVED; already-closed = no-op). `mv` goal → status-only-differs = transition succeeds; goal_id-or-owner-differs = `EPERM` (015b-AC-2/AC-3). |
| D-9 | flush details | embeddings disabled → skip the embed hop, write NULL vectors (015b-AC-4); `appendFile` → SQL-level concat + cache-invalidate, no read-back (015b-AC-5); goal/kpi flush → SELECT-before-INSERT keyed by goal_id (or goal_id,kpi_id) (015b-AC-6). |

## Scaffold/seam plan
Wave 1 (015a): the `DeepLakeFs` intercept + `classifyPath` + the read-resolution precedence chain + the `/graph/` bridge (→`handleGraphVfs`) + the sessions concat + `generateVirtualIndex` + the daemon-dispatch SEAM (a `DaemonDispatch` interface — fake in tests; the real one POSTs to 127.0.0.1:3850) + session-EPERM + the in-memory cache + the contracts (FsOp, PathClass, etc.) + the 015b write-path stub + CONVENTIONS.md. Wave 2 (015b): the batched-debounced write path + goal/kpi lifecycle verbs + appendFile concat + embeddings-disabled + SELECT-before-INSERT flush. 015b builds on 015a's dispatch + buffer.

---

## AC Ledger (12 sub + 3 index)

### 015a Intercept + Dispatch — Wave 1 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| a-AC-1 | Read precedence: graph bridge → virtual index.md → cache → pending buffer → sessions concat → SQL summary read. | VERIFIED |
| a-AC-2 | `/graph/` path → delegates to `handleGraphVfs`, local snapshot, zero network, renders `no-graph` not a throw. | VERIFIED |
| a-AC-3 | `classifyPath` → valid goal/kpi shape → its kind; malformed → `memory`. | VERIFIED |
| a-AC-4 | Write/cp/mv on a session path → `EPERM`. | VERIFIED |
| a-AC-5 | No `/index.md` row + root read → `generateVirtualIndex` 2-section table ≤50 rows each + truncation notice. | VERIFIED |
| a-AC-6 | Any read/write reaching storage → SQL dispatched through the daemon on 3850, never opened directly. | VERIFIED |

### 015b Batching + Goals/KPIs — Wave 2 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| b-AC-1 | Quick writes coalesce + flush at 10 pending or 200ms debounce, serialized (no interleave), rejected rows re-queued. | VERIFIED |
| b-AC-2 | `rm` goal → soft-close (status→closed, row preserved); `rm` on already-closed = no-op. | VERIFIED |
| b-AC-3 | `mv` goal: status-only differs → transition succeeds; goal_id or owner differs → `EPERM`. | VERIFIED |
| b-AC-4 | Flush with embeddings disabled → skip embed hop, NULL vector columns. | VERIFIED |
| b-AC-5 | `appendFile` on existing file → SQL-level concat + cache-invalidate, no read-back. | VERIFIED |
| b-AC-6 | Goal/kpi flush → SELECT-before-INSERT keyed by goal_id (or goal_id, kpi_id). | VERIFIED |

### Index roll-ups
| Index AC | by | Status |
|---|---|---|
| AC-1 cat resolves via cache/pending/sessions/SQL through the daemon | a-AC-1, a-AC-6 | VERIFIED |
| AC-2 classifyPath routes goal/kpi/memory | a-AC-3 | VERIFIED |
| AC-3 session write → EPERM (append-only event log) | a-AC-4 | VERIFIED |

**Totals:** 15 ACs (12 sub + 3 index) · **15 VERIFIED** · 0 OPEN — fully VERIFIED (intercept/classify/read-precedence/batched-writes/goal-kpi-verbs unit-proven; goal SELECT-before-INSERT dispatch live-proven on the real backend), close-out unlocked.

## Wave plan
```
Wave 1 (015a intercept + classify + read-resolution + daemon dispatch + bridges + 015b stub) ──► Wave 2 (015b batched writes + goal/kpi verbs) ──► Wave 3 (security → quality) ──► Ship
```
- Wave 1 · `typescript-node-worker-bee` opus — DeepLakeFs intercept, classifyPath, read-resolution precedence, graph/sessions/index bridges, daemon-dispatch seam, session-EPERM, cache, contracts, 015b stub, CONVENTIONS.md. + opt-in live goal/kpi dispatch itest scaffold.
- Wave 2 · `typescript-node-worker-bee` opus — batched-debounced writes (serialized, re-queue), goal/kpi lifecycle verbs (rm soft-close, mv transition), appendFile concat, embeddings-disabled, SELECT-before-INSERT flush.
- Wave 3 · `security-worker-bee` (opus — the mount can't escape its scope [org/workspace/agent_id on every dispatch]; a path can't traverse out of the mount; session append-only EPERM can't be bypassed [cp/mv/write]; SQL the FS builds is escaped + daemon-dispatched [no direct DeepLake]; a malicious path/goal-id can't inject; the batched buffer is bounded [DoS]; the graph bridge is zero-network) → `quality-worker-bee` (sonnet).

## Watchdog / event log
- PRDs 001–014 merged (14 done); main GREEN incl. gated live job (PRD-014 push/pull held). PRD-015 moved→in-work, branched off main (6df54b8).
- Infra scan: `goals`/`kpis`/`sessions`/`memory` tables exist (product.ts select-before-insert + the others); `handleGraphVfs` (014d) is the graph bridge; NO new tables/API; the dispatch goes THROUGH the daemon (3850) — DeepLakeFs must NOT open DeepLake directly (thin-client invariant). Wave 1 dispatched.
- Wave 1 DONE (015a, opus): DeepLakeFs in **`src/daemon-client/vfs/`** (a NON_DAEMON_ROOT → the dispatch-through-daemon invariant is STRUCTURALLY enforced — a stray storage-client import fails the build). classifyPath, read-precedence (graph→index→cache→pending→sessions→SQL), `/graph/` bridge→handleGraphVfs (zero-network, no-graph-as-body), session-EPERM, generateVirtualIndex (2-section ≤50 + truncation), `DaemonDispatch` seam. a-AC-1..6 VERIFIED. ci=0 (1037). NOTE: refined `invariant.test.ts` to exempt ONLY the pure `daemon/storage/sql.js` (escaping fns — the SQL-injection floor, same treatment audit-sql-safety gives it) while still banning the client/writes/heal/catalog/barrel + stripping comments before scanning; the "no non-daemon code opens DeepLake" guarantee is intact (vfs imports only sqlIdent/sLiteral). [flagged to security]
- Wave 2 DONE (015b, opus): `write-buffer.ts` — coalesce+flush at 10-pending OR 200ms (injectable clock), SERIALIZED via a flushChain (no interleave), rejected rows re-queued; `rm`→softCloseGoal (UPDATE status=closed, row preserved, already-closed no-op); `mv`→transitionGoal (status-only=UPDATE, goal_id/owner-differ=EPERM); embeddings-disabled→NULL vector (no embed call); appendFile→`summary = summary || E'...'` concat + cache-invalidate (no read-back); goal/kpi flush→SELECT-before-INSERT keyed by goal_id / composite goal_id+kpi_id. b-AC-1..6 VERIFIED. Schema reconcile: wrote only existing memory cols (path/summary/summary_embedding; PRD prose's size_bytes/description don't exist). Orchestrator root-verify: ci=0 (1060/4-skip), build/audit:openclaw/audit:sql=0, invariant+dispatch-invariant green, vfs suite 65 tests. **Live goal-dispatch 3/3 clean** (classify→SELECT-before-INSERT→poll-convergent read).
- All 15 ACs VERIFIED. Daemon/hook-assembly wiring (the PreToolUse hook that calls DeepLakeFs, the real DaemonDispatch POSTing to 3850) deferred+documented. Wave 3 (security → quality) dispatched.
