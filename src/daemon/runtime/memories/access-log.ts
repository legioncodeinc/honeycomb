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
 *     last `N = 32` raw events per memory, FOLD the older ones into
 *     `access_count` + `last_reinforced_at`, then delete the folded raw rows. So
 *     the log does not grow without bound (PRD-058e Risks / open question), while
 *     the activation frequency signal is preserved in the denormalized cache.
 *
 * ── Append-only / version-bump-consistent (the one rule that cannot bend) ─────
 * The raw event INSERT is `appendOnlyInsert` (PRD-002d). The `memories` cache
 * maintenance is the `update-or-insert` pattern `memories` ALREADY uses (a keyed
 * upsert of two scalar columns), NOT a destructive rewrite of the row, it only
 * advances `last_reinforced_at` forward and the `access_count` counter, leaving
 * every other column intact. Reinforcement / compaction is off the capture hot
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
 *   - `access_count` is bumped (read-modify-write of the keyed row);
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
): Promise<{ appended: boolean }> {
	const now = (deps.now ?? (() => new Date()))();
	const at = now.toISOString();
	const id = (deps.newId ?? randomUUID)();
	const u = clampUnit(usefulness);

	const row: RowValues = [
		["id", val.str(id)],
		["memory_id", val.str(memoryId)],
		["at", val.str(at)],
		["usefulness", val.num(u)],
		["kind", val.str(kind)],
	];
	const target = healTargetFor(MEMORY_ACCESS_TABLE);
	const res = await appendOnlyInsert(deps.storage, target, scope, row);
	const appended = isOk(res);

	// Best-effort cache maintenance, never blocks/fails the load-bearing event append.
	// Only a `reinforce` advances last_reinforced_at (a CONFIRMED-useful access is the
	// freshness reference 058a's t_ref = max(created_at, last_reinforced_at) reads).
	await maintainMemoryCache(memoryId, kind === "reinforce" ? at : null, deps, scope);

	return { appended };
}

/**
 * Maintain the `memories` denormalized cache for a memory (PRD-058e): bump
 * `access_count` by one and, when `reinforcedAt` is non-null, advance
 * `last_reinforced_at` to it. Read-modify-write of the keyed row via the
 * `update-or-insert` pattern `memories` already uses (NOT a destructive rewrite,
 * only the two cache columns are SET, every other column is left intact). The
 * read is FAIL-SOFT: a missing row (the memory was purged, a fresh partition) or
 * any error simply skips the cache update, the raw event log is the source of
 * truth. Never throws.
 */
async function maintainMemoryCache(
	memoryId: string,
	reinforcedAt: string | null,
	deps: AccessLogDeps,
	scope: QueryScope,
): Promise<void> {
	const tbl = sqlIdent(MEMORIES_TABLE);
	const idCol = sqlIdent("id");
	const accessCountCol = sqlIdent("access_count");
	const lastReinforcedCol = sqlIdent("last_reinforced_at");
	const isDeletedCol = sqlIdent("is_deleted");

	// Read the current count (the keyed row). A miss / error → skip the cache update.
	const readSql =
		`SELECT ${accessCountCol} AS access_count FROM "${tbl}" ` +
		`WHERE ${idCol} = ${sLiteral(memoryId)} AND ${isDeletedCol} = 0 LIMIT 1`;
	const read = await deps.storage.query(readSql, scope);
	if (!isOk(read) || read.rows.length === 0) return; // no live row to cache against, fine.

	const current = readCount((read.rows[0] as StorageRow).access_count);
	const next = current + 1;

	// SET only the cache columns (never a full-row rewrite that could coalesce other edits).
	const setClauses =
		reinforcedAt === null
			? `${accessCountCol} = ${String(next)}`
			: `${accessCountCol} = ${String(next)}, ${lastReinforcedCol} = ${sLiteral(reinforcedAt)}`;
	const updateSql = `UPDATE "${tbl}" SET ${setClauses} WHERE ${idCol} = ${sLiteral(memoryId)}`;
	await deps.storage.query(updateSql, scope); // fail-soft: a non-ok result is swallowed (cache is best-effort).
}

/**
 * Read a memory's access history as the {@link AccessEvent}[] the ACT-R activation
 * sums over (PRD-058e), oldest-first. FAIL-SOFT: a missing `memory_access` table
 * (fresh partition) or any query error yields an EMPTY history, the activation
 * then floors at `A_min` (a cold memory), never throws. Rows with an unparseable
 * `at` are skipped (they cannot enter the time-weighted sum). The denormalized
 * `access_count` for folded-away older events is layered in by
 * {@link readActivationHistory}; THIS reader returns only the raw retained rows.
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
 * `keepN` raw events, FOLDS the older ones into the `memories` cache
 * (`access_count` accumulates the folded count; `last_reinforced_at` advances to
 * the newest folded reinforcing event when later than the stored value), and
 * DELETEs the folded raw rows so the log stays bounded. RULES:
 *  - A memory with `≤ keepN` events is left UNTOUCHED (nothing to fold).
 *  - The DELETE is idempotent (re-running converges), matching the retention /
 *    compaction discipline elsewhere.
 *  - FAIL-SOFT: a read/delete error aborts the compaction for that memory without
 *    throwing, the next run retries. The raw log is never partially corrupted:
 *    the cache is bumped only AFTER the fold set is known, and the delete targets
 *    exactly the folded ids.
 * Returns the count of raw events folded away (0 when nothing was compacted).
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

	// Read the full ordered event set (id + at + kind) so we can pick the fold horizon.
	const readSql =
		`SELECT ${idCol} AS id, ${atCol} AS at, ${sqlIdent("kind")} AS kind ` +
		`FROM "${tbl}" WHERE ${memoryIdCol} = ${sLiteral(memoryId)} ORDER BY ${atCol} ASC`;
	const read = await deps.storage.query(readSql, scope);
	if (!isOk(read)) return { folded: 0 }; // fail-soft: retry next run.

	const rows = read.rows as StorageRow[];
	if (rows.length <= keep) return { folded: 0 }; // nothing to fold.

	const foldCount = rows.length - keep;
	const foldRows = rows.slice(0, foldCount); // the OLDEST events (ascending order) are folded.

	// The newest reinforcing event in the fold set advances last_reinforced_at if later.
	let newestReinforceAt: string | null = null;
	for (const r of foldRows) {
		if (String(r.kind ?? "") !== "reinforce") continue;
		const at = String(r.at ?? "");
		if (at !== "" && (newestReinforceAt === null || at > newestReinforceAt)) newestReinforceAt = at;
	}

	// Fold the count + (optional) reinforcement into the cache BEFORE deleting the raw rows,
	// so a crash between the two leaves the events still present (re-folded next run), never lost.
	await accumulateCache(memoryId, foldCount, newestReinforceAt, deps, scope);

	// Delete exactly the folded ids (idempotent). A failed delete leaves them to retry.
	const foldIds = foldRows.map((r) => String(r.id ?? "")).filter((id) => id !== "");
	if (foldIds.length > 0) {
		const inList = foldIds.map((id) => sLiteral(id)).join(", ");
		const delSql = `DELETE FROM "${tbl}" WHERE ${memoryIdCol} = ${sLiteral(memoryId)} AND ${idCol} IN (${inList})`;
		await deps.storage.query(delSql, scope); // fail-soft.
	}
	return { folded: foldCount };
}

/**
 * Accumulate a folded batch into the `memories` cache (compaction helper):
 * `access_count += addCount`, and advance `last_reinforced_at` to `reinforcedAt`
 * only when it is LATER than the stored value. Read-modify-write of the keyed
 * row; FAIL-SOFT on a missing row / error (skips). Distinct from
 * {@link maintainMemoryCache}, which bumps by exactly one for a live event.
 */
async function accumulateCache(
	memoryId: string,
	addCount: number,
	reinforcedAt: string | null,
	deps: AccessLogDeps,
	scope: QueryScope,
): Promise<void> {
	const tbl = sqlIdent(MEMORIES_TABLE);
	const idCol = sqlIdent("id");
	const accessCountCol = sqlIdent("access_count");
	const lastReinforcedCol = sqlIdent("last_reinforced_at");

	const readSql =
		`SELECT ${accessCountCol} AS access_count, ${lastReinforcedCol} AS last_reinforced_at ` +
		`FROM "${tbl}" WHERE ${idCol} = ${sLiteral(memoryId)} LIMIT 1`;
	const read = await deps.storage.query(readSql, scope);
	if (!isOk(read) || read.rows.length === 0) return;

	const cur = read.rows[0] as StorageRow;
	const next = readCount(cur.access_count) + Math.max(0, Math.trunc(addCount));
	const storedReinforced = String(cur.last_reinforced_at ?? "");
	// Advance last_reinforced_at only if the folded reinforcement is strictly later.
	const advance = reinforcedAt !== null && (storedReinforced === "" || reinforcedAt > storedReinforced);

	const setClauses = advance
		? `${accessCountCol} = ${String(next)}, ${lastReinforcedCol} = ${sLiteral(reinforcedAt!)}`
		: `${accessCountCol} = ${String(next)}`;
	const updateSql = `UPDATE "${tbl}" SET ${setClauses} WHERE ${idCol} = ${sLiteral(memoryId)}`;
	await deps.storage.query(updateSql, scope);
}

/** Clamp a value into `[0,1]` (the usefulness unit interval); non-finite → 0. */
function clampUnit(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

/** Read a stored count cell into a non-negative integer (a missing/garbage cell → 0). */
function readCount(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** Read a stored float cell, defaulting when absent/garbage. */
function readFloat(value: unknown, def: number): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : def;
}
