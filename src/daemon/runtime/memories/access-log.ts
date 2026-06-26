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
 * increments under concurrency (two `recordAccess`/compaction runs read the same
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
 * DELETEs the folded raw rows so the log stays bounded.
 *
 * ── IDEMPOTENT across a partial failure (the load-bearing invariant) ──────────
 * DeepLake has NO multi-statement transaction, so the fold-then-delete pair can be
 * interrupted: a crash after the cache write but before the delete would, with a
 * naive `access_count += foldCount`, RE-FOLD the same rows on the next run and
 * DOUBLE-COUNT; the reverse order would LOSE them. This compaction is made
 * idempotent by a persisted WATERMARK (`memories.access_compacted_at` — the `at` of
 * the newest event already folded):
 *  - the fold set is exactly the events OLDER than the keep-horizon AND STRICTLY
 *    NEWER than the watermark (events at-or-before the watermark were already
 *    counted, so they are never re-folded);
 *  - the count accumulate + the watermark advance happen in the SAME atomic cache
 *    UPDATE, so the watermark always reflects precisely what was counted;
 *  - the raw-row DELETE runs AFTER. A failed delete leaves the (now-folded) rows in
 *    place, but they are at-or-before the watermark so the NEXT run does not re-fold
 *    them (no double count) — it merely re-issues the idempotent DELETE. A failed
 *    cache UPDATE leaves the watermark UNADVANCED and the rows present, so the next
 *    run retries the whole fold cleanly (no loss).
 *
 * RULES:
 *  - A memory with `≤ keepN` events is left UNTOUCHED (nothing to fold).
 *  - FAIL-SOFT: a read/cache/delete error aborts the compaction for that memory
 *    without throwing; the next run retries with no double count and no loss.
 * Returns the count of raw events folded THIS run (0 when nothing new was folded —
 * including a re-run over already-folded-but-undeleted rows).
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

	// The compaction watermark: the `at` of the newest event ALREADY folded into the count. NULL/absent
	// → nothing folded yet (every event is "newer" than an absent watermark). Read once, up front.
	const watermark = await readCompactionWatermark(memoryId, deps, scope);

	// The horizon set is the OLDEST `rows.length - keep` events (ascending order); from those, the rows
	// STRICTLY NEWER than the watermark are the NOT-YET-folded set this run counts. Rows at-or-before the
	// watermark were already counted on a prior run (their delete may simply not have landed) — never
	// re-fold them (the no-double-count guarantee).
	const horizon = rows.slice(0, rows.length - keep);
	const foldRows = horizon.filter((r) => {
		const at = String(r.at ?? "");
		return at !== "" && (watermark === null || at > watermark);
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

	// The newest event in the fold set is the new watermark (advanced in the SAME write as the count).
	let newestFoldedAt = "";
	let newestReinforceAt: string | null = null;
	for (const r of foldRows) {
		const at = String(r.at ?? "");
		if (at !== "" && at > newestFoldedAt) newestFoldedAt = at;
		if (String(r.kind ?? "") === "reinforce" && at !== "" && (newestReinforceAt === null || at > newestReinforceAt)) {
			newestReinforceAt = at;
		}
	}

	// Fold the count + (optional) reinforcement + the watermark advance into the cache as ONE atomic
	// UPDATE BEFORE deleting the raw rows. If this fails, the watermark is unadvanced and the rows are
	// present → the next run re-folds cleanly (no loss). If it succeeds but the delete then fails, the
	// rows are now at-or-before the watermark → the next run does NOT re-fold (no double count).
	const accumulated = await accumulateCache(memoryId, foldCount, newestReinforceAt, newestFoldedAt, deps, scope);
	if (!accumulated) return { folded: 0 }; // cache write failed → no watermark advance, retry next run.

	await deleteFoldedRows(memoryId, deleteRows, deps, scope);
	return { folded: foldCount };
}

/**
 * Read the compaction WATERMARK (`memories.access_compacted_at`) for a memory — the `at` of the newest
 * raw access event already folded into `access_count` (PRD-058e idempotent compaction). Returns the
 * stored ISO stamp, or `null` when absent/empty (nothing folded yet) or on any read error (fail-soft:
 * an unreadable watermark degrades to "fold from the start", which the at-most-once delete still keeps
 * convergent). Never throws.
 */
async function readCompactionWatermark(memoryId: string, deps: AccessLogDeps, scope: QueryScope): Promise<string | null> {
	const tbl = sqlIdent(MEMORIES_TABLE);
	const idCol = sqlIdent("id");
	const watermarkCol = sqlIdent("access_compacted_at");
	const readSql =
		`SELECT ${watermarkCol} AS access_compacted_at FROM "${tbl}" ` +
		`WHERE ${idCol} = ${sLiteral(memoryId)} LIMIT 1`;
	const read = await deps.storage.query(readSql, scope);
	if (!isOk(read) || read.rows.length === 0) return null;
	const raw = String((read.rows[0] as StorageRow).access_compacted_at ?? "");
	return raw === "" ? null : raw;
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
 * Accumulate a folded batch into the `memories` cache (compaction helper) as ONE ATOMIC UPDATE:
 * `access_count += addCount` (relative, COALESCE-guarded — never a read-modify-write that loses a
 * concurrent increment), advance `last_reinforced_at` to `reinforcedAt` only when strictly later (a
 * `CASE` MAX), and advance the compaction watermark `access_compacted_at` to `newestFoldedAt` — all in
 * the SAME statement so the count and the watermark are committed together (the idempotency invariant:
 * the watermark always reflects exactly what was counted). Distinct from {@link maintainMemoryCache},
 * which bumps by exactly one for a live event. Returns whether the cache write landed (the caller gates
 * the subsequent delete on it). FAIL-SOFT: a non-ok result returns `false` (no watermark advance → the
 * next run retries the fold, no loss).
 */
async function accumulateCache(
	memoryId: string,
	addCount: number,
	reinforcedAt: string | null,
	newestFoldedAt: string,
	deps: AccessLogDeps,
	scope: QueryScope,
): Promise<boolean> {
	const tbl = sqlIdent(MEMORIES_TABLE);
	const idCol = sqlIdent("id");
	const accessCountCol = sqlIdent("access_count");
	const lastReinforcedCol = sqlIdent("last_reinforced_at");
	const watermarkCol = sqlIdent("access_compacted_at");

	const add = Math.max(0, Math.trunc(addCount));
	// Atomic relative increment (COALESCE handles a NULL/un-backfilled cell) — concurrency-safe.
	const countClause = `${accessCountCol} = COALESCE(${accessCountCol}, 0) + ${String(add)}`;
	// last_reinforced_at advances to the LATER of the stored value and the folded reinforcement.
	const reinforceClause =
		reinforcedAt === null
			? ""
			: `, ${lastReinforcedCol} = CASE WHEN ${lastReinforcedCol} IS NULL OR ${lastReinforcedCol} < ${sLiteral(reinforcedAt)} ` +
				`THEN ${sLiteral(reinforcedAt)} ELSE ${lastReinforcedCol} END`;
	// The watermark advances to the newest folded `at` (monotone: never moves backward).
	const watermarkClause =
		newestFoldedAt === ""
			? ""
			: `, ${watermarkCol} = CASE WHEN ${watermarkCol} IS NULL OR ${watermarkCol} < ${sLiteral(newestFoldedAt)} ` +
				`THEN ${sLiteral(newestFoldedAt)} ELSE ${watermarkCol} END`;

	const updateSql = `UPDATE "${tbl}" SET ${countClause}${reinforceClause}${watermarkClause} WHERE ${idCol} = ${sLiteral(memoryId)}`;
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
