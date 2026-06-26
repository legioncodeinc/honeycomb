/**
 * PRD-058e, the access-event log: `recordAccess` + the denormalized cache it
 * maintains + compaction.
 *
 * This is the WRITE + READ seam for the `memory_access` table (`catalog/memory-
 * lifecycle.ts`). Three responsibilities:
 *
 *  1. {@link recordAccess}, append ONE `(at, usefulness, kind)` event for a
 *     memory (append-only, never an in-place edit DeepLake can coalesce), and
 *     maintain the `memories` denormalized cache (`last_reinforced_at` /
 *     `access_count`) so activation has a fast frequency + reinforcement signal
 *     even after the raw log is compacted. NO public write endpoint, this is the
 *     daemon-internal call (PRD-058e API spec: reinforcement cannot be spoofed by
 *     a client).
 *  2. {@link readAccessHistory}, read a memory's access series (oldest-first),
 *     mapped to the {@link import("./activation.js").AccessEvent}[] the ACT-R
 *     activation sums over. FAIL-SOFT: a missing table / any query error yields an
 *     EMPTY history, so a daemon with no `memory_access` table yet (fresh
 *     partition, embeddings-off dogfood) degrades activation to the cold floor,
 *     never throws.
 *  3. {@link compactAccessLog}, the retention worker's pruning step: keep the
 *     last `N = 32` raw events per memory, advance `last_reinforced_at` + the
 *     compaction watermark for the older ones, then delete those raw rows. So the
 *     log does not grow without bound (PRD-058e Risks / open question). NOTE
 *     compaction does NOT touch `access_count`: that counter is owned solely by the
 *     append path (`+1` per access), counted ONCE at append and left untouched by
 *     pruning (the single-owner model — see {@link accumulateCache}). Pruning only
 *     discards the raw rows; the reinforcement-count signal was already persisted.
 *
 * ── Append-only / version-bump-consistent (the one rule that cannot bend) ─────
 * The raw event INSERT is `appendOnlyInsert` (PRD-002d). The `memories` cache
 * maintenance is the `update-or-insert` pattern `memories` ALREADY uses (a keyed
 * upsert of scalar columns), NOT a destructive rewrite of the row, it only
 * advances `last_reinforced_at` forward and the `access_count` counter (at append),
 * leaving every other column intact. Reinforcement / compaction is off the capture hot
 * path (the session-end worker + the retention worker call these); the capture
 * write is never blocked by an access-log write (PRD-058e Technical
 * Considerations: "no model or aggregation step can cost the user a memory").
 *
 * ── SQL safety ───────────────────────────────────────────────────────────────
 * Every value routes through the `writes.ts` `val.*` constructors + the
 * `sql.ts` helpers; every identifier through `sqlIdent`. No value is hand-quoted
 * (`audit:sql` scans `src/daemon`). All storage access is through the injected
 * {@link StorageQuery}, never a raw fetch.
 */

import { randomUUID } from "node:crypto";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { appendOnlyInsert, val, type RowValues } from "../../storage/writes.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { healTargetFor } from "../../storage/catalog/index.js";
import {
	buildAccessHistorySql,
	MEMORY_ACCESS_TABLE,
	type MemoryAccessKind,
} from "../../storage/catalog/memory-lifecycle.js";
import type { AccessEvent } from "./activation.js";

/** The `memories` table identifier the cache-maintenance upsert targets. */
const MEMORIES_TABLE = "memories" as const;

/**
 * The default `agent_id` an engine-table row falls back to when the caller does not thread a memory's
 * real agent scope (mirrors the `'default'` schema default + `memoriesScopeFilter`). The PARTITION
 * (org/workspace) rides {@link QueryScope}; `agent_id` + `visibility` are the engine table's only scope
 * COLUMNS (D-2), so they must be carried on the row + ANDed into every cache read/update so an access
 * event is recorded against — and the derived activation read from — the OWNING agent's partition slice,
 * never another agent's (PRD-058e D-2 / catalog/memory-lifecycle.ts scope contract).
 */
const DEFAULT_AGENT_ID = "default" as const;
/** The default `visibility` for an engine-table row (mirrors the schema `'global'` default). */
const DEFAULT_VISIBILITY = "global" as const;

/**
 * A memory's AGENT scope (the engine-table scope COLUMNS, NOT the org/workspace partition — that rides
 * {@link QueryScope}). `recordAccess` writes these onto the `memory_access` row AND ANDs them into the
 * `memories` cache read/update, so an event is attributed to the owning agent and a cache bump cannot
 * cross agents (PRD-058e D-2). ABSENT → the schema defaults (`'default'` / `'global'`), so an un-scoped
 * caller still writes a consistent (self-consistent) row rather than a partial one.
 */
export interface AgentScope {
	/** The owning agent id (`memory_access.agent_id` / `memories.agent_id`). */
	readonly agentId?: string;
	/** The row visibility (`memory_access.visibility` / `memories.visibility`). */
	readonly visibility?: string;
}

/** Resolve an {@link AgentScope} to its concrete `(agentId, visibility)`, applying the schema defaults. */
function resolveAgentScope(agent?: AgentScope): { agentId: string; visibility: string } {
	const agentId = agent?.agentId !== undefined && agent.agentId !== "" ? agent.agentId : DEFAULT_AGENT_ID;
	const visibility = agent?.visibility !== undefined && agent.visibility !== "" ? agent.visibility : DEFAULT_VISIBILITY;
	return { agentId, visibility };
}

/**
 * Build the `agent_id = … AND visibility = …` conjunct every cache read/update appends so a bump is
 * confined to the OWNING agent's row (PRD-058e D-2). Every value routes through `sLiteral`, every
 * identifier through `sqlIdent` (the SQL-safety floor — `audit:sql` clean).
 */
function agentScopeClause(agent: { agentId: string; visibility: string }): string {
	return `${sqlIdent("agent_id")} = ${sLiteral(agent.agentId)} AND ${sqlIdent("visibility")} = ${sLiteral(agent.visibility)}`;
}

/**
 * The compaction horizon: how many RAW access events to keep per memory before
 * folding the older ones into the `access_count` + `last_reinforced_at` cache
 * (PRD-058e open question, "start at the last N = 32 events per memory"). A
 * single named, tunable knob.
 */
export const DEFAULT_ACCESS_COMPACTION_KEEP = 32;

/** Construction deps for the access-log writes (injectable clock + id for determinism). */
export interface AccessLogDeps {
	/** The DeepLake storage client (daemon-only). Every read + write runs through this. */
	readonly storage: StorageQuery;
	/** A clock for the event `at` stamp; defaults to wall-clock. A test injects a fixed clock. */
	readonly now?: () => Date;
	/** An id generator for the event row; defaults to a UUID. A test injects a deterministic one. */
	readonly newId?: () => string;
}

/**
 * Record ONE access event for a memory (PRD-058e). Appends `(id, memory_id, at,
 * usefulness, kind, agent_id, visibility)` to `memory_access` (append-only) and
 * maintains the `memories` denormalized cache:
 *   - `access_count` is bumped `+1` (atomic relative increment, never a read-modify-
 *     write). This is the SOLE writer of `access_count` (the single-owner model,
 *     round-3 #1): every access is counted EXACTLY ONCE here at append, and
 *     compaction never re-adds it. So `access_count` is the lifetime total accesses;
 *   - `last_reinforced_at` is advanced to `at` for a `reinforce` event (a recall
 *     confirmed useful is the freshness reference 058a's `t_ref` reads); a
 *     `recall`/`create`/`downweight` event bumps the count but does NOT move
 *     `last_reinforced_at` (only a CONFIRMED-useful access reinforces).
 *
 * `usefulness` is clamped into `[0,1]` (defense in depth; the grader already
 * bounds it). The cache maintenance is best-effort + FAIL-SOFT: if the
 * `memories` upsert fails (missing row on a fresh partition, a transient flap),
 * the raw event STILL landed, so activation can rebuild from the log, the cache
 * is an optimization, never the source of truth. Returns whether the raw event
 * was appended (the load-bearing write). Never throws.
 */
export async function recordAccess(
	memoryId: string,
	usefulness: number,
	kind: MemoryAccessKind,
	deps: AccessLogDeps,
	scope: QueryScope,
	agent?: AgentScope,
): Promise<{ appended: boolean }> {
	const now = (deps.now ?? (() => new Date()))();
	const at = now.toISOString();
	const id = (deps.newId ?? randomUUID)();
	const u = clampUnit(usefulness);
	const agentScope = resolveAgentScope(agent);

	// Carry the memory's REAL agent scope onto the event row (PRD-058e D-2): without it every row
	// falls back to the schema defaults and the agent-scoped contract breaks once readers honor the
	// stored scope (memory-lifecycle.ts). The org/workspace partition rides `scope`; these two are
	// the engine table's scope COLUMNS.
	const row: RowValues = [
		["id", val.str(id)],
		["memory_id", val.str(memoryId)],
		["at", val.str(at)],
		["usefulness", val.num(u)],
		["kind", val.str(kind)],
		["agent_id", val.str(agentScope.agentId)],
		["visibility", val.str(agentScope.visibility)],
	];
	const target = healTargetFor(MEMORY_ACCESS_TABLE);
	const res = await appendOnlyInsert(deps.storage, target, scope, row);
	const appended = isOk(res);

	// Best-effort cache maintenance, never blocks/fails the load-bearing event append — but ONLY after
	// a SUCCESSFUL append, so the denormalized cache (`access_count` / `last_reinforced_at`) never
	// advances past the append-only source of truth (a failed event must not leave the cache claiming a
	// reinforcement that has no `memory_access` row). Only a `reinforce` advances last_reinforced_at (a
	// CONFIRMED-useful access is the freshness reference 058a's t_ref = max(created_at, last_reinforced_at)
	// reads). The bump is scoped to the SAME agent row the event was attributed to.
	if (appended) {
		await maintainMemoryCache(memoryId, kind === "reinforce" ? at : null, deps, scope, agentScope);
	}

	return { appended };
}

/**
 * Maintain the `memories` denormalized cache for a memory (PRD-058e): bump
 * `access_count` by one and, when `reinforcedAt` is non-null, advance
 * `last_reinforced_at` to it. SET only the two cache columns (NOT a destructive
 * rewrite, every other column is left intact).
 *
 * ── Atomic in-statement increment (no read-modify-write) ──────────────────────
 * The count is advanced with an ATOMIC relative SQL expression
 * `access_count = COALESCE(access_count, 0) + 1` — NOT a `SELECT` of the prior
 * value followed by an `UPDATE` to a computed constant. A read-then-write loses
 * increments under concurrency (two concurrent `recordAccess` appends read the same
 * count and overwrite each other). The relative form composes: each apply adds
 * exactly one regardless of interleaving. (It is, by construction, a NON-idempotent
 * UPDATE — `statementRetryability` classifies a relative SET as `unsafe-write`, so
 * the storage client runs it SINGLE-ATTEMPT and never blindly re-issues it after an
 * ambiguous flap, which is exactly the at-most-once semantics a `+1` needs.)
 * `last_reinforced_at` advances with a `GREATEST`/`CASE` MAX so a concurrent later
 * reinforcement is never clobbered by an older one.
 *
 * The `WHERE` confines the bump to the OWNING agent's live row (PRD-058e D-2):
 * `id` + the `agent_id`/`visibility` scope conjunct + `is_deleted = 0`. FAIL-SOFT:
 * a non-ok result (no live row on a fresh partition, a transient flap) is swallowed
 * — the raw event log is the source of truth, the cache is an optimization. Never
 * throws.
 */
async function maintainMemoryCache(
	memoryId: string,
	reinforcedAt: string | null,
	deps: AccessLogDeps,
	scope: QueryScope,
	agent: { agentId: string; visibility: string },
): Promise<void> {
	const tbl = sqlIdent(MEMORIES_TABLE);
	const idCol = sqlIdent("id");
	const accessCountCol = sqlIdent("access_count");
	const lastReinforcedCol = sqlIdent("last_reinforced_at");
	const isDeletedCol = sqlIdent("is_deleted");

	// Atomic relative increment: COALESCE handles a NULL (pre-058e / un-backfilled) cell. No prior read.
	const countClause = `${accessCountCol} = COALESCE(${accessCountCol}, 0) + 1`;
	// last_reinforced_at advances to the LATER of the stored value and this event (a CASE MAX so a
	// concurrent later reinforcement is never overwritten by an older one).
	const reinforceClause =
		reinforcedAt === null
			? ""
			: `, ${lastReinforcedCol} = CASE WHEN ${lastReinforcedCol} IS NULL OR ${lastReinforcedCol} < ${sLiteral(reinforcedAt)} ` +
				`THEN ${sLiteral(reinforcedAt)} ELSE ${lastReinforcedCol} END`;

	const updateSql =
		`UPDATE "${tbl}" SET ${countClause}${reinforceClause} ` +
		`WHERE ${idCol} = ${sLiteral(memoryId)} AND ${agentScopeClause(agent)} AND ${isDeletedCol} = 0`;
	await deps.storage.query(updateSql, scope); // fail-soft: a non-ok result is swallowed (cache is best-effort).
}

/**
 * Read a memory's access history as the {@link AccessEvent}[] the ACT-R activation
 * sums over (PRD-058e), oldest-first. FAIL-SOFT: a missing `memory_access` table
 * (fresh partition) or any query error yields an EMPTY history, the activation
 * then floors at `A_min` (a cold memory), never throws. Rows with an unparseable
 * `at` are skipped (they cannot enter the time-weighted sum). THIS reader returns
 * only the RETAINED raw rows, which is exactly what the ACT-R activation math
 * (`activation.ts`) sums over. The denormalized `access_count` (the lifetime total
 * accesses) is a SEPARATE signal: it is surfaced as the displayed reinforcement
 * count (`recall.ts` `MemoryRecallHit.accessCount`), NOT folded back into the
 * activation sum — the two are never combined, so a folded-away event is counted
 * once in `access_count` and never re-enters the activation history (no double count).
 */
export async function readAccessHistory(
	memoryId: string,
	deps: AccessLogDeps,
	scope: QueryScope,
): Promise<AccessEvent[]> {
	const res = await deps.storage.query(buildAccessHistorySql(memoryId), scope);
	if (!isOk(res)) return []; // missing table / any error → cold floor, never a throw.
	const events: AccessEvent[] = [];
	for (const row of res.rows as StorageRow[]) {
		const atMs = Date.parse(String(row.at ?? ""));
		if (!Number.isFinite(atMs)) continue; // unparseable stamp → cannot weight by time; skip.
		events.push({ atMs, usefulness: clampUnit(readFloat(row.usefulness, 1)) });
	}
	return events;
}

/**
 * Compact a memory's access log (PRD-058e retention step). Keeps the most recent
 * `keepN` raw events, FOLDS the older ones (advances `last_reinforced_at` to the
 * newest folded reinforcing event when later than the stored value, and advances
 * the compaction watermark), then DELETEs those raw rows so the log stays bounded.
 *
 * ── SINGLE-OWNER `access_count` (round-3 #1) ─────────────────────────────────
 * Compaction does NOT add to `access_count`. `access_count` is the TOTAL-accesses
 * counter, incremented `+1` per access at APPEND ({@link maintainMemoryCache}) and
 * NEVER re-touched here. An aged-out event was already counted once at append;
 * pruning its raw row discards an optimization detail, not the reinforcement
 * signal. The activation MATH reads the RETAINED raw rows, not `access_count`;
 * `access_count` is surfaced only as the displayed lifetime reinforcement total
 * (`recall.ts`). The two are never summed, so an access contributes EXACTLY ONCE
 * end to end — no double count, no loss.
 *
 * ── IDEMPOTENT across a partial failure (the load-bearing invariant) ──────────
 * DeepLake has NO multi-statement transaction, so the fold-then-delete pair can be
 * interrupted. This compaction is made idempotent by a persisted WATERMARK CURSOR,
 * the TOTAL-ORDER position `(at, id)` of the newest event already FOLDED
 * (`memories.access_compacted_at` + `access_compacted_id`):
 *  - the fold set is exactly the events OLDER than the keep-horizon AND STRICTLY
 *    AFTER the `(at, id)` cursor (events at-or-before the cursor were already
 *    processed, so they are never re-folded). The cursor is the COMPOSITE `(at, id)`,
 *    not `at` alone: several events can share one `at`, and an `at`-only cursor
 *    could not tell an already-folded row from a not-yet-folded same-`at` sibling:
 *    it would treat the sibling as folded (`at === watermark`, not `>`) and delete
 *    it WITHOUT processing it (a silent loss of the reinforce/freshness advance).
 *    Pairing `at` with `id` gives a strict total order so a same-`at` sibling still
 *    compares "after" the cursor;
 *  - BOTH cursor halves advance in the SAME atomic cache UPDATE as the
 *    reinforcement advance, so the cursor always reflects precisely what was folded;
 *  - the raw-row DELETE runs AFTER. A failed delete leaves the (now-folded) rows in
 *    place, but they are at-or-before the cursor so the NEXT run does not re-fold
 *    them — it merely re-issues the idempotent DELETE. A failed cache UPDATE leaves
 *    the cursor UNADVANCED and the rows present, so the next run retries cleanly.
 *
 * RULES:
 *  - A memory with `≤ keepN` events is left UNTOUCHED (nothing to fold).
 *  - FAIL-SOFT: a read/cache/delete error aborts the compaction for that memory
 *    without throwing; the next run retries with no double count and no loss. An
 *    UNREADABLE watermark (a query error, distinct from a genuinely-absent one)
 *    ABORTS rather than re-folding from the start. An ABSENT memories row likewise
 *    ABORTS (no fold, NO delete) — deleting raw rows the cache UPDATE could not
 *    persist a watermark for would silently lose them (round-3 #2).
 * Returns the count of raw events folded THIS run (0 when nothing new was folded —
 * including a re-run over already-folded-but-undeleted rows, or an aborted run).
 */
export async function compactAccessLog(
	memoryId: string,
	deps: AccessLogDeps,
	scope: QueryScope,
	keepN: number = DEFAULT_ACCESS_COMPACTION_KEEP,
): Promise<{ folded: number }> {
	const keep = Math.max(0, Math.trunc(keepN));
	const tbl = sqlIdent(MEMORY_ACCESS_TABLE);
	const idCol = sqlIdent("id");
	const memoryIdCol = sqlIdent("memory_id");
	const atCol = sqlIdent("at");

	// Read the full ordered event set (id + at + kind) so we can pick the fold horizon. The order is the
	// TOTAL ORDER (at, id), NOT `at` alone, so same-timestamp siblings have a stable, deterministic rank
	// the keep-horizon slice and the watermark cursor agree on (see the (at, id) cursor note below).
	const readSql =
		`SELECT ${idCol} AS id, ${atCol} AS at, ${sqlIdent("kind")} AS kind ` +
		`FROM "${tbl}" WHERE ${memoryIdCol} = ${sLiteral(memoryId)} ORDER BY ${atCol} ASC, ${idCol} ASC`;
	const read = await deps.storage.query(readSql, scope);
	if (!isOk(read)) return { folded: 0 }; // fail-soft: retry next run.

	const rows = read.rows as StorageRow[];
	if (rows.length <= keep) return { folded: 0 }; // nothing to fold.

	// The compaction watermark: the (at, id) of the newest event ALREADY folded into the count. This read
	// also probes the memories ROW so the fold cannot delete raw events without a row to persist the
	// watermark to. Two abort cases, BOTH before any cache write or delete:
	//  - `error`: an unreadable watermark (a transient read failure). Re-folding from "the start" would
	//    double-count rows a prior run already folded but had not yet deleted (round-2 #1).
	//  - `missing`: the memories row is absent. The fold's UPDATE would match 0 rows (a silent no-op), so
	//    the watermark never persists, yet the DELETE would still fire → a silent reinforcement LOSS
	//    (round-3 #2). Abort with folded:0 and NO delete so the raw rows survive for a clean retry.
	const watermarkRead = await readCompactionWatermark(memoryId, deps, scope);
	if (watermarkRead.kind === "error" || watermarkRead.kind === "missing") return { folded: 0 };
	const watermark = watermarkRead.value; // null ⇒ row exists but genuinely never compacted (every event is "after" it).

	// The horizon set is the OLDEST `rows.length - keep` events (in (at, id) order); from those, the rows
	// STRICTLY AFTER the watermark cursor are the NOT-YET-folded set this run counts. The comparison is on
	// the COMPOSITE (at, id), not `at` alone: when several events share an `at`, comparing on `at` alone
	// would treat a same-`at` sibling of an already-folded row as also folded (`at === watermarkAt`, not
	// `>`) and DELETE it without ever counting it: a silent loss. (at, id) gives a strict total order so a
	// same-`at` sibling that was NOT yet folded still compares "after" the cursor and is counted.
	const horizon = rows.slice(0, rows.length - keep);
	const foldRows = horizon.filter((r) => {
		const at = String(r.at ?? "");
		const id = String(r.id ?? "");
		return at !== "" && (watermark === null || isAfterCursor(at, id, watermark));
	});

	// Delete every horizon id whose row is at-or-before the watermark too (re-issue a prior failed
	// delete), plus the newly-folded rows — the DELETE is idempotent, so re-targeting an already-gone
	// row is a no-op that simply converges the log.
	const deleteRows = horizon;

	if (foldRows.length === 0) {
		// Nothing NEW to fold — but a prior run may have folded without deleting. Re-issue the delete so
		// the log converges, then report 0 folded (no count change this run).
		await deleteFoldedRows(memoryId, deleteRows, deps, scope);
		return { folded: 0 };
	}

	const foldCount = foldRows.length;

	// The newest event in the fold set is the new watermark CURSOR (at, id), advanced in the SAME write as
	// the count. The "newest" is by the COMPOSITE (at, id): among same-`at` siblings the larger `id` wins,
	// so the persisted cursor pins the exact last-folded row and the next run resumes strictly after it.
	let newestFoldedAt = "";
	let newestFoldedId = "";
	let newestReinforceAt: string | null = null;
	for (const r of foldRows) {
		const at = String(r.at ?? "");
		const id = String(r.id ?? "");
		if (at !== "" && isAfterCursor(at, id, { at: newestFoldedAt, id: newestFoldedId })) {
			newestFoldedAt = at;
			newestFoldedId = id;
		}
		if (String(r.kind ?? "") === "reinforce" && at !== "" && (newestReinforceAt === null || at > newestReinforceAt)) {
			newestReinforceAt = at;
		}
	}

	// Advance (optional) reinforcement + the watermark CURSOR into the cache as ONE atomic UPDATE BEFORE
	// deleting the raw rows. `access_count` is NOT touched here: it is the total-accesses counter owned
	// solely by the append path (`+1` per `recordAccess`), so an aged-out event keeps the single count it
	// got at append and compaction never re-counts it (round-3 finding #1 — no double count). If this fails,
	// the watermark is unadvanced and the rows are present → the next run re-folds cleanly (no loss). If it
	// succeeds but the delete then fails, the rows are now at-or-before the watermark → the next run does
	// NOT re-fold (no double count). `foldCount` remains the count of rows pruned this run, reported below.
	const accumulated = await accumulateCache(memoryId, newestReinforceAt, newestFoldedAt, newestFoldedId, deps, scope);
	if (!accumulated) return { folded: 0 }; // cache write failed → no watermark advance, retry next run.

	await deleteFoldedRows(memoryId, deleteRows, deps, scope);
	return { folded: foldCount };
}

/**
 * The compaction watermark CURSOR: the TOTAL-ORDER position `(at, id)` of the newest raw access event
 * already folded into `access_count`. `id` may be `""` for a legacy watermark written before the
 * companion `access_compacted_id` column existed (an `at`-only watermark heals forward on the next fold).
 */
interface CompactionCursor {
	readonly at: string;
	readonly id: string;
}

/**
 * The result of reading the compaction watermark. THREE distinct cases the caller must tell apart so a
 * fold never deletes raw rows without persisting the count/watermark (PRD-058e idempotent compaction):
 *  - `ok`: the memories row EXISTS; `value` is the stored cursor, or `null` when the row exists but the
 *    watermark is genuinely absent (never compacted → fold from the start).
 *  - `missing`: the memories row is ABSENT. The fold's cache UPDATE would match 0 rows (a silent no-op),
 *    so persisting neither the watermark nor — under the single-owner count model — the reinforcement,
 *    yet the subsequent raw-row DELETE would still fire and LOSE those events. The caller MUST ABORT.
 *  - `error`: the read FAILED (a transient query error). The caller MUST ABORT rather than treat an
 *    unreadable watermark as "never compacted": re-folding from the start after a transient read error
 *    would double-count rows a prior run already folded but had not yet deleted.
 * Collapsing `missing`/`error` into the `ok null` ("never compacted") case is the round-3 finding #2 loss
 * (delete-without-persist) and the round-2 finding #1 double-count respectively. (CodeRabbit r2 #1 / r3 #2.)
 */
type WatermarkRead =
	| { readonly kind: "ok"; readonly value: CompactionCursor | null }
	| { readonly kind: "missing" }
	| { readonly kind: "error" };

/**
 * Strict total-order comparison on `(at, id)`: is `(at, id)` AFTER the `cursor`? Lexicographic, `at` then
 * `id`. LEGACY watermark guard: a cursor with an EMPTY `id` (a pre-companion-column at-only watermark)
 * compares conservatively on `at` ALONE: a same-`at` row is treated as at-or-before (NOT re-folded), so
 * migrating from a legacy at-only watermark never double-counts a same-`at` sibling. Once the cursor has a
 * real `id` (the next fold heals it forward) the strict `(at, id)` comparison applies.
 */
function isAfterCursor(at: string, id: string, cursor: CompactionCursor): boolean {
	if (at !== cursor.at) return at > cursor.at;
	if (cursor.id === "") return false; // legacy at-only cursor: same-`at` rows are at-or-before (no re-fold).
	return id > cursor.id;
}

/**
 * Read the compaction WATERMARK cursor (`memories.access_compacted_at` + `access_compacted_id`) for a
 * memory: the `(at, id)` of the newest raw access event already folded into `access_count` (PRD-058e
 * idempotent compaction). This read DOUBLES as the existence probe for the memories row, so the caller can
 * abort BEFORE a fold deletes raw rows that no UPDATE could persist a count/watermark for. RETURNS a
 * discriminated result:
 *  - `{ kind: "ok", value: null }`: the row EXISTS but the watermark is absent/empty (genuinely never
 *    compacted, so every event is "after" it, fold from the start).
 *  - `{ kind: "ok", value: { at, id } }`: the row exists with a stored cursor.
 *  - `{ kind: "missing" }`: the memories row is ABSENT (`rows.length === 0`). DISTINCT from "never
 *    compacted": the fold's cache UPDATE would match 0 rows (a silent no-op), so the watermark would never
 *    persist, yet the raw-row DELETE would still fire → a silent reinforcement LOSS. The caller MUST ABORT.
 *  - `{ kind: "error" }`: the read FAILED (a query/connection error). The caller MUST ABORT rather than
 *    treat an unreadable watermark as "never compacted": re-folding from the start after a transient read
 *    error would double-count rows a prior run already folded but had not deleted. Never throws.
 */
async function readCompactionWatermark(memoryId: string, deps: AccessLogDeps, scope: QueryScope): Promise<WatermarkRead> {
	const tbl = sqlIdent(MEMORIES_TABLE);
	const idCol = sqlIdent("id");
	const watermarkCol = sqlIdent("access_compacted_at");
	const watermarkIdCol = sqlIdent("access_compacted_id");
	const readSql =
		`SELECT ${watermarkCol} AS access_compacted_at, ${watermarkIdCol} AS access_compacted_id FROM "${tbl}" ` +
		`WHERE ${idCol} = ${sLiteral(memoryId)} LIMIT 1`;
	const read = await deps.storage.query(readSql, scope);
	if (!isOk(read)) return { kind: "error" }; // read FAILED → abort (do NOT degrade to "never compacted").
	if (read.rows.length === 0) return { kind: "missing" }; // no memories row → abort (delete-without-persist guard).
	const row = read.rows[0] as StorageRow;
	const at = String(row.access_compacted_at ?? "");
	if (at === "") return { kind: "ok", value: null }; // present but empty → nothing folded yet.
	const id = String(row.access_compacted_id ?? ""); // "" for a legacy at-only watermark; heals on next fold.
	return { kind: "ok", value: { at, id } };
}

/** Delete a batch of folded raw access rows (idempotent — re-deleting a gone row converges the log). FAIL-SOFT. */
async function deleteFoldedRows(memoryId: string, foldRows: readonly StorageRow[], deps: AccessLogDeps, scope: QueryScope): Promise<void> {
	const tbl = sqlIdent(MEMORY_ACCESS_TABLE);
	const idCol = sqlIdent("id");
	const memoryIdCol = sqlIdent("memory_id");
	const foldIds = foldRows.map((r) => String(r.id ?? "")).filter((id) => id !== "");
	if (foldIds.length === 0) return;
	const inList = foldIds.map((id) => sLiteral(id)).join(", ");
	const delSql = `DELETE FROM "${tbl}" WHERE ${memoryIdCol} = ${sLiteral(memoryId)} AND ${idCol} IN (${inList})`;
	await deps.storage.query(delSql, scope); // fail-soft: a failed delete is retried next run (idempotent).
}

/**
 * Advance the `memories` cache for a folded batch (compaction helper) as ONE ATOMIC UPDATE:
 * advance `last_reinforced_at` to `reinforcedAt` only when strictly later (a `CASE` MAX) and advance the
 * compaction watermark CURSOR `(access_compacted_at, access_compacted_id)` to `(newestFoldedAt,
 * newestFoldedId)`, in the SAME statement so BOTH cursor halves commit together (the idempotency
 * invariant: the cursor always pins exactly the last-folded row, and the `id` half disambiguates same-`at`
 * siblings).
 *
 * ── SINGLE-OWNER `access_count` (round-3 finding #1) ─────────────────────────────────────────────────
 * Compaction does NOT touch `access_count`. `access_count` is the TOTAL number of accesses ever, and its
 * SOLE writer is the append path ({@link maintainMemoryCache}, `+1` per `recordAccess`). An access is
 * counted EXACTLY ONCE — at append — and that single count survives compaction untouched, because
 * compaction only PRUNES the raw `memory_access` rows (an optimization), it does not re-observe the events.
 * Folding the count here too (`access_count += foldCount`) DOUBLE-COUNTED every aged-out event: once at
 * append and again at fold. The activation MATH ({@link import("./activation.js").actrActivation}) reads
 * the RETAINED raw rows, never `access_count`; `access_count` is surfaced only as the displayed total
 * reinforcement count (`recall.ts` `MemoryRecallHit.accessCount`). The two signals never overlap, so the
 * count and the retained rows are not added together anywhere — no double count, no loss.
 *
 * Returns whether the cache write landed (the caller gates the subsequent delete on it). FAIL-SOFT: a
 * non-ok result returns `false` (no watermark advance → the next run retries the fold, no loss). When the
 * batch carries no advanceable signal (no reinforcement and an empty `newestFoldedAt`), this is a no-op
 * that returns `true` (the rows carry nothing to persist, so the delete may proceed).
 */
async function accumulateCache(
	memoryId: string,
	reinforcedAt: string | null,
	newestFoldedAt: string,
	newestFoldedId: string,
	deps: AccessLogDeps,
	scope: QueryScope,
): Promise<boolean> {
	const tbl = sqlIdent(MEMORIES_TABLE);
	const idCol = sqlIdent("id");
	const lastReinforcedCol = sqlIdent("last_reinforced_at");
	const watermarkCol = sqlIdent("access_compacted_at");
	const watermarkIdCol = sqlIdent("access_compacted_id");

	const setClauses: string[] = [];
	// last_reinforced_at advances to the LATER of the stored value and the folded reinforcement.
	if (reinforcedAt !== null) {
		setClauses.push(
			`${lastReinforcedCol} = CASE WHEN ${lastReinforcedCol} IS NULL OR ${lastReinforcedCol} < ${sLiteral(reinforcedAt)} ` +
				`THEN ${sLiteral(reinforcedAt)} ELSE ${lastReinforcedCol} END`,
		);
	}
	// The watermark CURSOR advances to the newest folded `(at, id)`: monotone, never backward. Both halves
	// advance together GATED on the SAME `at`-monotonicity guard so the (at, id) pair stays consistent (the
	// id is only meaningful relative to its `at`): when `at` strictly advances OR ties the stored `at`, the
	// companion id is set to the newly-folded id; both cursor halves commit in one statement so the persisted
	// cursor always pins exactly the last-folded row (the idempotency invariant).
	if (newestFoldedAt !== "") {
		const watermarkAdvances =
			`${watermarkCol} IS NULL OR ${watermarkCol} < ${sLiteral(newestFoldedAt)} ` +
			`OR (${watermarkCol} = ${sLiteral(newestFoldedAt)} AND (${watermarkIdCol} IS NULL OR ${watermarkIdCol} < ${sLiteral(newestFoldedId)}))`;
		setClauses.push(`${watermarkCol} = CASE WHEN ${watermarkAdvances} THEN ${sLiteral(newestFoldedAt)} ELSE ${watermarkCol} END`);
		setClauses.push(`${watermarkIdCol} = CASE WHEN ${watermarkAdvances} THEN ${sLiteral(newestFoldedId)} ELSE ${watermarkIdCol} END`);
	}

	// Nothing advanceable (no reinforcement, no datable fold row) → no-op success: the rows carry no signal
	// to persist, so the caller's delete may proceed without leaving the cache behind.
	if (setClauses.length === 0) return true;

	const updateSql = `UPDATE "${tbl}" SET ${setClauses.join(", ")} WHERE ${idCol} = ${sLiteral(memoryId)}`;
	const res = await deps.storage.query(updateSql, scope);
	return isOk(res);
}

/** Clamp a value into `[0,1]` (the usefulness unit interval); non-finite → 0. */
function clampUnit(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

/** Read a stored float cell, defaulting when absent/garbage. */
function readFloat(value: unknown, def: number): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : def;
}
