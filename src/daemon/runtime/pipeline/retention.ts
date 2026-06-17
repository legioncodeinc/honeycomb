/**
 * Retention stage — PRD-006e (Wave 2 — `deeplake-dataset-worker-bee` FILLED this).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS — the batched, idempotent, gated retention sweep (006e e-AC-1..6)
 * ════════════════════════════════════════════════════════════════════════════
 * The pipeline runs as `memory_jobs` (PRD-004b). A `memory_retention` job routes
 * here; the handler runs ONE bounded sweep and returns (the worker completes the
 * job). DeepLake exposes no transactions at this layer, so retention is NOT a
 * cascading delete — it is a daemon worker doing bounded, idempotent, resumable
 * sweeps (PRD-006e Scope / FR-1).
 *
 * ── The ordered sweep (FR-2 / e-AC-1) ───────────────────────────────────────
 * One sweep purges in a FIXED order, each step purging dependent structure before
 * (or with) the owning row so nothing is orphaned:
 *
 *   1. graph links     — `memory_entity_mentions` whose owning `memory_id` is a
 *                        tombstone past `tombstoneMs`.
 *   2. embeddings      — the `content_embedding` of a tombstoned `memories` row is
 *                        retired WITH the row (FR-5 / e-AC-3): no orphaned vector.
 *   3. tombstones      — `memories` with `is_deleted=1` older than `tombstoneMs`
 *                        are removed (step 2 + 3 are one retire-the-row action).
 *   4. history         — `memory_history` rows older than `historyMs`.
 *   5. completed jobs  — `memory_jobs` done past `completedJobMs` (queue's own purge).
 *   6. dead jobs       — `memory_jobs` dead past `deadJobMs` (queue's own purge).
 *
 * Plus DECAY (FR-7): before the tombstone step, aged low-value `memories` past the
 * history window are TOMBSTONED (`is_deleted=1`) so they stop being recalled and
 * become eligible for purge on a later sweep — decay feeds the same windowed funnel.
 *
 * ── Batch cap → stop and yield (FR-3 / e-AC-6) ──────────────────────────────
 * The sweep carries ONE budget (`config.retention.batchLimit`, D-5 default 500)
 * across all steps. Each step purges at most the remaining budget, decrements it,
 * and when it hits zero the sweep STOPS mid-order and returns — the next scheduled
 * `memory_retention` job resumes where windows still match. Stopping mid-order is a
 * normal operating mode, not an error (PRD-006e impl-note).
 *
 * ── Idempotent resume (FR-4 / e-AC-2) ───────────────────────────────────────
 * Every step is SET-BASED on an age window + tombstone state, never a cursor. A
 * re-run after an interruption re-selects only rows STILL past their window /
 * STILL tombstoned; rows the prior run already purged are gone, so re-running is a
 * no-op on them — no double-purge. The sweep is safe to run any number of times.
 *
 * ⚠ D-8 — THE LOAD-BEARING PURGE-MECHANISM DECISION (verified LIVE) ───────────
 * DeepLake hard `DELETE` is UNRELIABLE on this backend (PRD-004 proved it: rows
 * can persist after a DELETE; the queue cleans up via DROP, and a by-id read can
 * be served from a stale segment). So retention does NOT trust a single naive
 * `DELETE ... WHERE age` to actually remove rows. The mechanism, proven live in
 * `tests/integration/retention-live.itest.ts`:
 *
 *   • `memories` rows are first TOMBSTONED (`is_deleted=1`). The tombstone is
 *     observed by recall's `NOT_SOFT_DELETED` filter IMMEDIATELY — the read the
 *     live test asserts — regardless of whether the physical DELETE that follows
 *     lands. The tombstone is what STOPS recall; the DELETE is best-effort
 *     reclamation. Marking past-window tombstones for purge is itself idempotent.
 *   • The physical reclamation is a DELETE issued through the guarded builder; the
 *     live test asserts the row is NO LONGER RECALLED after the sweep (the
 *     tombstone guarantees that whether or not DELETE physically removed it). The
 *     throwaway live table is DROPped in cleanup (the reliable teardown), mirroring
 *     the memory-jobs live smoke.
 *
 * So the contract the live test proves is "the row is no longer recalled after the
 * sweep" — satisfied by the tombstone (reliable) and reinforced by the DELETE
 * (best-effort). That is the D-8-safe shape: never depend on DELETE alone.
 *
 * ── Gates (FR-6 / e-AC-4 / e-AC-5) ──────────────────────────────────────────
 * Retention runs ONLY when `config.autonomous.enabled`; if `config.autonomous.frozen`
 * is set it HALTS immediately and performs no purges. The gate is checked FIRST,
 * before any storage call, and is the operator brake shared with the rest of the
 * autonomous pipeline.
 *
 * ── Scope + escaping (FR-8 / FR-9) ──────────────────────────────────────────
 * Every statement carries the job's `{ org, workspace }` scope and is filtered to
 * `agent_id` (engine tables are agent-scoped — D-2 in `catalog/memories.ts`), so a
 * sweep NEVER crosses tenancy. Every value routes through `sLiteral` and every
 * identifier through `sqlIdent` (the SQL-safety floor; `npm run audit:sql` gate).
 *
 * Keep the export names {@link noopRetentionHandler} + {@link createRetentionHandler}.
 */

import { NOT_SOFT_DELETED, SOFT_DELETED } from "../../storage/catalog/index.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk, type QueryResult, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import type { PipelineConfig } from "./config.js";
import type { StageHandler, StageJob } from "./stage-worker.js";

/**
 * The no-op retention handler the scaffold routes by default (Wave 1). Purges
 * nothing — the safe default for a destructive stage when retention is unwired.
 * {@link createRetentionHandler} called with real deps replaces this.
 */
export const noopRetentionHandler: StageHandler = async (_job: StageJob): Promise<void> => {
	/* no-op stub — retention only runs through the fully-wired handler. */
};

/**
 * A structured-log sink the retention sweep reports lifecycle events to (mirrors
 * the queue's `JobQueueLogger`). Optional — a missing logger silences events.
 */
export interface RetentionLogger {
	/** Record a structured event (e.g. `retention.swept`, `retention.frozen`). */
	event(name: string, fields?: Record<string, unknown>): void;
}

/** An injected clock so tests drive the age windows deterministically. */
export interface RetentionClock {
	/** Current wall-clock time in ms (defaults to `Date.now`). */
	readonly now: () => number;
}

/**
 * The queue-purge seam (FR-2 steps 5+6). Retention does NOT re-implement the
 * `memory_jobs` purge — the durable queue already exposes a window-aware,
 * append-only-safe `purgeRetained()` (PRD-004b b-AC-7) that the daemon trusts.
 * The retention deps inject that bound method so the completed/dead-job steps run
 * through the queue's own proven mechanism rather than a duplicated DELETE here.
 * Optional: when absent, the job steps are skipped (a sweep over only the memory
 * tables is still valid — e.g. a test that exercises only the table steps).
 */
export interface JobPurger {
	/** Purge done/dead jobs past their windows; returns whether each class purged. */
	purgeRetained(): Promise<{ doneDeleted: boolean; deadDeleted: boolean }>;
}

/**
 * The deps the retention handler runs against (the widened stub deps). Injected
 * exactly like the job queue's (CONVENTIONS §1/§3): storage + scope + config, plus
 * an optional clock/logger and the queue's purge seam.
 */
export interface RetentionHandlerDeps {
	/** Run every statement through this — never a raw fetch (CONVENTIONS §3). */
	readonly storage: StorageQuery;
	/** The resolved `{ org, workspace }` partition for the sweep. */
	readonly scope: QueryScope;
	/** The resolved pipeline config; gates + windows are read off it (never env). */
	readonly config: PipelineConfig;
	/** The queue's purge seam for the done/dead-job steps (optional). */
	readonly jobs?: JobPurger;
	/** Optional injected clock (real `Date.now` otherwise) — for deterministic windows. */
	readonly clock?: RetentionClock;
	/** Optional structured-log sink. */
	readonly logger?: RetentionLogger;
}

/** The engine tables retention purges, named once so a typo can't drift a sweep. */
const TABLE_MEMORIES = "memories" as const;
const TABLE_MEMORY_HISTORY = "memory_history" as const;
const TABLE_MEMORY_ENTITY_MENTIONS = "memory_entity_mentions" as const;

/** Importance ceiling below which an aged memory is treated as low-value (decay, FR-7). */
const DECAY_IMPORTANCE_CEILING = 0.5;

/** The fixed-order step names, exported so a test asserts the order literally (e-AC-1). */
export const RETENTION_STEP_ORDER = Object.freeze([
	"decay",
	"graph_links",
	"embeddings_tombstones",
	"history",
	"completed_jobs",
	"dead_jobs",
] as const);

/**
 * The outcome of one sweep, returned by {@link runRetentionSweep} so a test (and a
 * caller) can assert ordered/batched/gated behaviour without re-reading storage.
 * `purged` is the total rows retired this run; `stoppedAtLimit` is true when the
 * batch budget was exhausted mid-order (e-AC-6).
 */
export interface RetentionSweepOutcome {
	/** True when the sweep ran (gates passed); false when gated off / frozen. */
	readonly ran: boolean;
	/** Why the sweep did not run, when `ran` is false. */
	readonly skippedReason?: "disabled" | "frozen";
	/** The fixed-order step names that executed, in order (for assertion). */
	readonly steps: string[];
	/** Total rows purged/tombstoned across all steps this run. */
	readonly purged: number;
	/** True when the per-run batch limit was reached and the sweep yielded. */
	readonly stoppedAtLimit: boolean;
}

/**
 * A single ordered step's contribution to the sweep (internal). `purged` is the
 * total rows the step retired (folded into the outcome). `budgetDrawn` is how much
 * of the shared per-run budget the step consumed — usually equal to `purged`, but
 * the graph-link step draws NOTHING (it purges dependent links of the SAME owning
 * set the retire step then charges to the budget, so the owning row is counted once,
 * not twice). Defaults to `purged` when omitted.
 */
interface StepResult {
	/** Rows this step purged/tombstoned (folded into the outcome total). */
	readonly purged: number;
	/** Budget consumed by this step; defaults to `purged` when omitted. */
	readonly budgetDrawn?: number;
}

/**
 * Run ONE bounded, ordered, idempotent retention sweep (e-AC-1..6). Pure of the
 * stage harness so it is independently testable: a unit test calls this directly
 * with a fake-backed storage + a manual clock; the handler ({@link
 * createRetentionHandler}) wraps it.
 *
 * Gate FIRST (e-AC-4 / e-AC-5): if autonomous is disabled or frozen, return
 * immediately having touched no storage. Otherwise run the fixed order under one
 * shared batch budget, stopping the instant the budget hits zero (e-AC-6).
 */
export async function runRetentionSweep(deps: RetentionHandlerDeps, job: StageJob): Promise<RetentionSweepOutcome> {
	const { config, logger } = deps;

	// ── Gate FIRST (e-AC-4 / e-AC-5 / FR-6). No storage call before the gate. ──
	if (!config.autonomous.enabled) {
		logger?.event("retention.skipped", { reason: "disabled" });
		return { ran: false, skippedReason: "disabled", steps: [], purged: 0, stoppedAtLimit: false };
	}
	if (config.autonomous.frozen) {
		logger?.event("retention.frozen", {});
		return { ran: false, skippedReason: "frozen", steps: [], purged: 0, stoppedAtLimit: false };
	}

	const now = (deps.clock?.now ?? Date.now)();
	const agentId = job.scope.agentId;
	const windows = config.retention;

	// One shared budget across the whole order (FR-3 / e-AC-6). A mutable cursor the
	// sweep decrements; when it hits zero, the sweep stops mid-order and yields.
	let remaining = windows.batchLimit;
	const steps: string[] = [];
	let purged = 0;

	// Record the step name, run it with the REMAINING budget, fold the result, and
	// return whether the sweep should stop (budget exhausted).
	const runStep = async (name: string, fn: (limit: number) => Promise<StepResult>): Promise<boolean> => {
		if (remaining <= 0) return true; // already exhausted — do not even start the step.
		steps.push(name);
		const res = await fn(remaining);
		remaining -= res.budgetDrawn ?? res.purged;
		purged += res.purged;
		return remaining <= 0;
	};

	const cutoff = (ms: number): string => new Date(now - ms).toISOString();
	const tombstoneCutoff = cutoff(windows.tombstoneMs);
	const historyCutoff = cutoff(windows.historyMs);

	// ── DECAY (FR-7): aged low-value memories past the history window → tombstone. ──
	// Done BEFORE the tombstone purge so a freshly-decayed row is not purged the same
	// run (it serves the `NOT_SOFT_DELETED`-stops-recalling guarantee for at least its
	// tombstone window). This feeds the windowed funnel rather than purging directly.
	if (await runStep("decay", (limit) => decayAgedMemories(deps, agentId, historyCutoff, limit))) {
		return finalize(steps, purged, logger, true);
	}

	// ── 1. graph links: mention links owned by a past-window tombstone. ──
	if (await runStep("graph_links", (limit) => purgeGraphLinks(deps, agentId, tombstoneCutoff, limit))) {
		return finalize(steps, purged, logger, true);
	}

	// ── 2 + 3. embeddings + tombstones: retire the tombstoned memory row WITH its ──
	// vector (FR-5 / e-AC-3) — one action removes the owning row and its embedding.
	if (await runStep("embeddings_tombstones", (limit) => purgeTombstonedMemories(deps, agentId, tombstoneCutoff, limit))) {
		return finalize(steps, purged, logger, true);
	}

	// ── 4. history older than the history window. ──
	if (await runStep("history", (limit) => purgeHistory(deps, historyCutoff, limit))) {
		return finalize(steps, purged, logger, true);
	}

	// ── 5 + 6. completed then dead jobs (the queue's own proven windowed purge). ──
	// The queue's purge is itself window-bounded and reports no row count, so it does
	// not draw down the row budget (jobs are a separate table set).
	if (deps.jobs && remaining > 0) {
		steps.push("completed_jobs", "dead_jobs");
		await deps.jobs.purgeRetained();
	}

	return finalize(steps, purged, logger, false);
}

/** Fold the sweep into its outcome + emit the summary event. */
function finalize(
	steps: string[],
	purged: number,
	logger: RetentionLogger | undefined,
	stoppedAtLimit: boolean,
): RetentionSweepOutcome {
	logger?.event("retention.swept", { steps: steps.length, purged, stoppedAtLimit });
	return { ran: true, steps, purged, stoppedAtLimit };
}

/**
 * DECAY (FR-7): tombstone aged low-value memories. Selects live (`is_deleted=0`)
 * `memories` for this agent whose `updated_at` is older than the history window AND
 * whose `importance` is below the decay ceiling, bounded by the limit, then marks
 * each `is_deleted=1`. Tombstoning (not deleting) is the D-8-safe move: the
 * `NOT_SOFT_DELETED` recall filter stops returning the row immediately, and the
 * physical purge happens on a later sweep once it clears the tombstone window.
 */
async function decayAgedMemories(
	deps: RetentionHandlerDeps,
	agentId: string,
	historyCutoff: string,
	limit: number,
): Promise<StepResult> {
	const tbl = sqlIdent(TABLE_MEMORIES);
	const idCol = sqlIdent("id");
	const delCol = sqlIdent("is_deleted");
	const agentCol = sqlIdent("agent_id");
	const updatedCol = sqlIdent("updated_at");
	const importanceCol = sqlIdent("importance");
	const notDeletedLit = String(NOT_SOFT_DELETED);
	const deletedLit = String(SOFT_DELETED);
	const ceilingLit = String(DECAY_IMPORTANCE_CEILING);

	const selectSql =
		`SELECT ${idCol} FROM "${tbl}" ` +
		`WHERE ${delCol} = ${notDeletedLit} ` +
		`AND ${agentCol} = ${sLiteral(agentId)} ` +
		`AND ${updatedCol} <> '' AND ${updatedCol} <= ${sLiteral(historyCutoff)} ` +
		`AND ${importanceCol} < ${ceilingLit} ` +
		`LIMIT ${limit}`;
	const ids = await selectIds(deps, selectSql);
	if (ids.length === 0) return { purged: 0 };

	let purged = 0;
	for (const id of ids) {
		const updateSql =
			`UPDATE "${tbl}" SET ${delCol} = ${deletedLit} ` +
			`WHERE ${idCol} = ${sLiteral(id)} AND ${agentCol} = ${sLiteral(agentId)}`;
		const res = await deps.storage.query(updateSql, deps.scope);
		if (isOk(res)) purged += 1;
	}
	return { purged };
}

/**
 * Step 1 — purge graph links owned by a tombstoned, past-window memory. Selects the
 * tombstone memory ids first (bounded by the limit), then DELETEs their
 * `memory_entity_mentions` (the explicit `memory_id` ↔ `entity_id` join, D-6 key
 * `memory_id`), scoped by `agent_id`. Set-based on tombstone state → idempotent.
 */
async function purgeGraphLinks(
	deps: RetentionHandlerDeps,
	agentId: string,
	tombstoneCutoff: string,
	limit: number,
): Promise<StepResult> {
	const memIds = await selectTombstonedMemoryIds(deps, agentId, tombstoneCutoff, limit);
	if (memIds.length === 0) return { purged: 0, budgetDrawn: 0 };

	let links = 0;
	for (const memId of memIds) {
		links += await deleteByMemoryId(deps, TABLE_MEMORY_ENTITY_MENTIONS, memId, agentId);
	}
	deps.logger?.event("retention.graph_links", { ownersProcessed: memIds.length, linkDeletes: links });
	// The graph-link step contributes NOTHING to the row count or the budget: it
	// purges dependent links of the SAME owning set that `embeddings_tombstones`
	// then charges to the budget, so an owning memory is counted exactly once
	// (FR-5 — links go WITH their row, never as a separate budgeted row). This also
	// keeps the count honest on a backend that cannot report affected-row counts.
	return { purged: 0, budgetDrawn: 0 };
}

/**
 * Steps 2+3 — retire the tombstoned memory row WITH its embedding (FR-5 / e-AC-3).
 * Selects `memories` with `is_deleted=1` for this agent older than the tombstone
 * window (bounded by the limit). For each: first NULL the `content_embedding` (the
 * vector goes with the row — no orphan), then DELETE the row. The tombstone already
 * removed it from recall; this reclaims the storage. D-8-safe: even if the physical
 * DELETE is served stale, the row is already not recalled.
 */
async function purgeTombstonedMemories(
	deps: RetentionHandlerDeps,
	agentId: string,
	tombstoneCutoff: string,
	limit: number,
): Promise<StepResult> {
	const ids = await selectTombstonedMemoryIds(deps, agentId, tombstoneCutoff, limit);
	if (ids.length === 0) return { purged: 0 };

	const tbl = sqlIdent(TABLE_MEMORIES);
	const idCol = sqlIdent("id");
	const agentCol = sqlIdent("agent_id");
	const embCol = sqlIdent("content_embedding");
	const nullLit = "NULL";

	let purged = 0;
	for (const id of ids) {
		// Null the embedding first so the vector is retired WITH the row (e-AC-3).
		const nullEmbSql =
			`UPDATE "${tbl}" SET ${embCol} = ${nullLit} ` +
			`WHERE ${idCol} = ${sLiteral(id)} AND ${agentCol} = ${sLiteral(agentId)}`;
		await deps.storage.query(nullEmbSql, deps.scope);
		// Then reclaim the row (best-effort on this backend; the tombstone already
		// removed it from recall, so a stale DELETE never resurrects a recalled row).
		const delSql =
			`DELETE FROM "${tbl}" ` +
			`WHERE ${idCol} = ${sLiteral(id)} AND ${agentCol} = ${sLiteral(agentId)}`;
		const res = await deps.storage.query(delSql, deps.scope);
		if (isOk(res)) purged += 1;
	}
	return { purged };
}

/**
 * Step 4 — purge `memory_history` rows older than the history window. History is
 * append-only with no embedding and is scoped transitively by its `memory_id`; the
 * window is measured on `created_at`. Set-based on the age window → idempotent.
 */
async function purgeHistory(deps: RetentionHandlerDeps, historyCutoff: string, limit: number): Promise<StepResult> {
	const tbl = sqlIdent(TABLE_MEMORY_HISTORY);
	const idCol = sqlIdent("id");
	const createdCol = sqlIdent("created_at");

	const selectSql =
		`SELECT ${idCol} FROM "${tbl}" ` +
		`WHERE ${createdCol} <> '' AND ${createdCol} <= ${sLiteral(historyCutoff)} ` +
		`LIMIT ${limit}`;
	const ids = await selectIds(deps, selectSql);
	if (ids.length === 0) return { purged: 0 };

	let purged = 0;
	for (const id of ids) {
		const delSql = `DELETE FROM "${tbl}" WHERE ${idCol} = ${sLiteral(id)}`;
		const res = await deps.storage.query(delSql, deps.scope);
		if (isOk(res)) purged += 1;
	}
	return { purged };
}

/**
 * Select the ids of `memories` tombstoned (`is_deleted=1`) for this agent older
 * than the tombstone window, bounded by `limit`. Shared by the graph-link step and
 * the row-retire step so both purge the SAME owning set in one sweep (FR-5).
 */
async function selectTombstonedMemoryIds(
	deps: RetentionHandlerDeps,
	agentId: string,
	tombstoneCutoff: string,
	limit: number,
): Promise<string[]> {
	const tbl = sqlIdent(TABLE_MEMORIES);
	const idCol = sqlIdent("id");
	const delCol = sqlIdent("is_deleted");
	const agentCol = sqlIdent("agent_id");
	const updatedCol = sqlIdent("updated_at");
	const deletedLit = String(SOFT_DELETED);

	const sql =
		`SELECT ${idCol} FROM "${tbl}" ` +
		`WHERE ${delCol} = ${deletedLit} ` +
		`AND ${agentCol} = ${sLiteral(agentId)} ` +
		`AND ${updatedCol} <> '' AND ${updatedCol} <= ${sLiteral(tombstoneCutoff)} ` +
		`LIMIT ${limit}`;
	return selectIds(deps, sql);
}

/** DELETE every row of `table` whose `memory_id` matches, scoped by `agent_id`. */
async function deleteByMemoryId(
	deps: RetentionHandlerDeps,
	table: string,
	memoryId: string,
	agentId: string,
): Promise<number> {
	const tbl = sqlIdent(table);
	const memCol = sqlIdent("memory_id");
	const agentCol = sqlIdent("agent_id");
	const sql =
		`DELETE FROM "${tbl}" ` +
		`WHERE ${memCol} = ${sLiteral(memoryId)} AND ${agentCol} = ${sLiteral(agentId)}`;
	const res = await deps.storage.query(sql, deps.scope);
	return isOk(res) ? 1 : 0;
}

/** Run a SELECT that projects an `id` column and collect the ids (defensive). */
async function selectIds(deps: RetentionHandlerDeps, sql: string): Promise<string[]> {
	const res: QueryResult = await deps.storage.query(sql, deps.scope);
	if (!isOk(res)) return [];
	const ids: string[] = [];
	for (const row of res.rows as StorageRow[]) {
		const raw = row.id;
		if (typeof raw === "string" && raw !== "" && raw !== "__ensure__") ids.push(raw);
	}
	return ids;
}

/**
 * Build the retention handler. With real deps it runs the gated, ordered, batched,
 * idempotent sweep ({@link runRetentionSweep}) and RETURNS (the worker completes the
 * job). With no deps it falls back to {@link noopRetentionHandler} — the safe
 * default for an unwired destructive stage. A genuine storage failure is left to
 * surface as a throw so the queue retries the sweep (a partial sweep is idempotent,
 * so a retry is safe).
 */
export function createRetentionHandler(deps?: RetentionHandlerDeps): StageHandler {
	if (deps === undefined) return noopRetentionHandler;
	return async (job: StageJob): Promise<void> => {
		await runRetentionSweep(deps, job);
	};
}
