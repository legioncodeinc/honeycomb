/**
 * The write path — PRD-015b (Wave 2, IMPLEMENTED). The batched-debounced flush + the
 * goal/kpi lifecycle verbs.
 *
 * Wave 1 (015a) owns the READ side end-to-end. The WRITE side is BUFFERED then FLUSHED; this
 * module owns the batching/debounce, the goal/kpi lifecycle verbs, the appendFile concat, the
 * embeddings-disabled path, and the SELECT-before-INSERT flush. `fs.ts` wires the buffer via
 * {@link createWriteBuffer} and routes every non-session write here — its wiring is unchanged
 * from Wave 1 (the new seams below are all OPTIONAL with embeddings-disabled defaults).
 *
 * The 015b contract (EXECUTION_LEDGER D-7 / D-8 / D-9):
 *
 *   - {@link WriteBuffer.enqueue}  buffer a write/append into the pending map. A `write`
 *     REPLACES the pending body (same path → latest body wins); an `append` ACCUMULATES the
 *     tail (append-accumulate per b-AC-5). Reaching {@link FLUSH_AT_PENDING} pending triggers
 *     an immediate flush; otherwise a {@link FLUSH_DEBOUNCE_MS} debounce is (re)armed.
 *   - {@link WriteBuffer.flush}    coalesce + flush, SERIALIZED through a promise chain so two
 *     never interleave; a row REJECTED by dispatch is RE-QUEUED for the next pass (b-AC-1). A
 *     memory write is a `memory` update-or-insert by `path` (b-AC-5/6); a goal/kpi write is a
 *     SELECT-before-INSERT keyed by goal_id (or goal_id, kpi_id) (b-AC-6); an `append` is a
 *     SQL-level concat + cache-invalidate, NO read-back (b-AC-5); embeddings disabled → skip
 *     the embed hop, write NULL vectors (b-AC-4).
 *   - {@link WriteBuffer.softCloseGoal}  `rm` a goal → status→`closed`, row PRESERVED;
 *     already-closed = no-op (b-AC-2).
 *   - {@link WriteBuffer.transitionGoal} `mv` a goal → status-only differs = transition;
 *     goal_id or owner differs = EPERM (b-AC-3).
 *
 * EVERY method dispatches through the SAME {@link DaemonDispatch} seam `fs.ts` carries — the
 * write path NEVER opens DeepLake either (a-AC-6 / the thin-client invariant). The only other
 * outbound seam is the OPTIONAL {@link Embedder}; when absent, embeddings are disabled and the
 * vector columns are written NULL (b-AC-4).
 *
 * SQL-safety: every value routes through `sLiteral`/`eLiteral`, every identifier through
 * `sqlIdent` (PURE helpers, the SQL-injection floor — `npm run audit:sql` proves it). This
 * module imports NO storage client.
 */

import { GOAL_STATUS_TOKENS, toMountRelative } from "./classify.js";
import {
	type ContentCache,
	type DaemonDispatch,
	type PendingBuffer,
	type PendingWrite,
	type Row,
	type Rows,
	type VfsScope,
} from "./contracts.js";
import { eLiteral, sqlIdent, sLiteral } from "../../daemon/storage/sql.js";

/** The decomposed parts of a `goal/<owner>/<status>/<goal_id>.md` path (FR-9 / Implementation notes). */
export interface GoalPathParts {
	/** The goal owner — the second segment. Must match across an `mv` (b-AC-3). */
	readonly owner: string;
	/** The goal status token — the third segment (`opened`/`in_progress`/`closed`). */
	readonly status: string;
	/** The logical goal_id (the `.md` stem) — the SELECT-before-INSERT key on `goals` (b-AC-6). */
	readonly goalId: string;
}

/** The decomposed parts of a `kpi/<goal_id>/<kpi_id>.md` path (Implementation notes). */
export interface KpiPathParts {
	/** The owning goal_id — the second segment. */
	readonly goalId: string;
	/** The kpi_id (the `.md` stem) — paired with `goalId` as the composite key (b-AC-6). */
	readonly kpiId: string;
}

const GOAL_STATUS_SET: ReadonlySet<string> = new Set(GOAL_STATUS_TOKENS);

/**
 * Decompose a goal path into `owner`/`status`/`goal_id` (Implementation notes). Returns `null`
 * for anything that is not a valid `goal/<owner>/<status>/<goal_id>.md` shape — the SAME shape
 * `classifyPath` recognizes as `goal`, so a path that classified `goal` always decomposes.
 * Mirrors `classify.ts`'s reduction (LAST `/memory/`) so the keying matches the read side.
 */
export function decomposeGoalPath(path: string): GoalPathParts | null {
	const segs = toMountRelative(path).split("/").filter((s) => s !== "");
	if (segs.length !== 4) return null;
	const [head, owner, status, file] = segs;
	if (head !== "goal" || owner === "" || !GOAL_STATUS_SET.has(status)) return null;
	const goalId = mdStem(file);
	return goalId === null ? null : { owner, status, goalId };
}

/** Decompose a kpi path into `goal_id`/`kpi_id` (Implementation notes), or `null` if malformed. */
export function decomposeKpiPath(path: string): KpiPathParts | null {
	const segs = toMountRelative(path).split("/").filter((s) => s !== "");
	if (segs.length !== 3) return null;
	const [head, goalId, file] = segs;
	if (head !== "kpi" || goalId === "") return null;
	const kpiId = mdStem(file);
	return kpiId === null ? null : { goalId, kpiId };
}

/** The non-empty stem of a `<stem>.md` filename, or `null` if not a `.md` file with a stem. */
function mdStem(file: string): string | null {
	if (!file.endsWith(".md") || file.length <= ".md".length) return null;
	return file.slice(0, -".md".length);
}

/** The flush trigger thresholds (D-7 / b-AC-1) — pinned here so 015b + tests share them. */
export const FLUSH_AT_PENDING = 10;
/** The debounce window in milliseconds before an under-threshold buffer flushes (D-7 / b-AC-1). */
export const FLUSH_DEBOUNCE_MS = 200;

/** The outcome of a {@link WriteBuffer.flush}. */
export interface FlushOutcome {
	/** How many pending rows were flushed in this pass. */
	readonly flushed: number;
	/** How many rows were rejected and RE-QUEUED for the next pass (b-AC-1). */
	readonly requeued: number;
}

/**
 * The error a goal `mv` rejects with when the transition is not status-only (b-AC-3 / D-8). A
 * goal can be re-statused via `mv`, but never RE-KEYED (`goal_id`) or RE-OWNED (`owner`):
 * those would forge a different goal's identity, so the move fails `EPERM`. `code === "EPERM"`
 * so a shell caller surfaces the same errno a real permission failure would.
 */
export class GoalTransitionError extends Error {
	/** The POSIX errno the shell surfaces. */
	readonly code = "EPERM" as const;
	constructor(message: string) {
		super(`EPERM: ${message}`);
		this.name = "GoalTransitionError";
	}
}

/**
 * The embedding seam (b-AC-4). When PRESENT, the flush computes a 768-dim
 * `nomic-embed-text-v1.5` vector for each body and writes it to the row's vector column. When
 * ABSENT (the default), embeddings are DISABLED: the flush SKIPS the embed hop entirely and
 * writes a SQL `NULL` literal for the vector column. The seam is injected (not imported) so the
 * thin client never links the embed worker; in tests it is a recording fake or simply omitted.
 */
export interface Embedder {
	/** Compute the embedding vector for a body. The returned array is rendered as a FLOAT4[] literal. */
	embed(body: string): Promise<readonly number[]>;
}

/** The dependencies the write buffer needs (the same dispatch seam + scope `fs.ts` carries). */
export interface WriteBufferDeps {
	/** The ONLY path out to storage (a-AC-6) — shared with the read side. */
	readonly dispatch: DaemonDispatch;
	/** The tenancy scope carried on every flush dispatch (FR-2). */
	readonly scope: VfsScope;
	/** The pending map the read tier-4 buffer also reads (so a write is visible pre-flush). */
	readonly pending: PendingBuffer;
	/**
	 * The content cache (tier 3 of the read chain). A flush of an `append` INVALIDATES the
	 * entry so a later read never serves a stale pre-concat body (b-AC-5). Optional — defaults
	 * to a private map when `fs.ts` does not share one (the read side then re-reads from SQL).
	 */
	readonly cache?: ContentCache;
	/**
	 * The OPTIONAL embedding seam (b-AC-4). ABSENT → embeddings disabled → NULL vectors. The
	 * flush never imports the embed worker; this is the only embed path and it is injected.
	 */
	readonly embedder?: Embedder;
}

/**
 * The batched-debounced write path (015b). `fs.ts` constructs one via {@link createWriteBuffer}
 * and routes every non-session write here.
 */
export interface WriteBuffer {
	/** Buffer a write/append into the pending map; coalesce + arm the flush (b-AC-1). */
	enqueue(write: PendingWrite): void;
	/** Coalesce + flush the pending buffer through the daemon, serialized + re-queueing (b-AC-1). */
	flush(): Promise<FlushOutcome>;
	/** `rm` a goal → soft-close (status→closed, row preserved); already-closed = no-op (b-AC-2). */
	softCloseGoal(path: string): Promise<void>;
	/** `mv` a goal → status-only transition, else EPERM (b-AC-3). */
	transitionGoal(fromPath: string, toPath: string): Promise<void>;
}

/** The injectable timer seam (b-AC-1) — defaults to the host timer; a test injects a fake clock. */
export interface TimerLike {
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
}

/** The default timer — the host `setTimeout`/`clearTimeout`. A test injects a fake instead. */
const HOST_TIMER: TimerLike = {
	setTimer: (fn, ms) => setTimeout(fn, ms),
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Internal construction options — adds the injectable timer the public `WriteBufferDeps` hides. */
export interface WriteBufferOptions extends WriteBufferDeps {
	/** The timer seam (b-AC-1). Defaults to {@link HOST_TIMER}; a test injects a fake clock. */
	readonly timer?: TimerLike;
}

/**
 * Construct the 015b write buffer. The methods coalesce, debounce, serialize, and dispatch
 * through the same daemon seam `fs.ts` carries — never opening DeepLake.
 */
export function createWriteBuffer(deps: WriteBufferOptions): WriteBuffer {
	const { dispatch, scope, pending } = deps;
	const cache: ContentCache = deps.cache ?? new Map();
	const embedder = deps.embedder;
	const timer = deps.timer ?? HOST_TIMER;

	/**
	 * The flush serialization chain (b-AC-1 / FR-2). Every `flush()` chains off the previous
	 * one's settlement, so two flushes NEVER interleave — a flush triggered while one is in
	 * flight simply awaits the in-flight flush, then runs after it. The chain swallows the
	 * prior settlement (errors surface to their own caller, not to the next flush).
	 */
	let flushChain: Promise<unknown> = Promise.resolve();

	/** The armed debounce handle, or null when no debounce is pending. */
	let debounceHandle: unknown = null;

	/** Disarm any pending debounce. */
	function disarmDebounce(): void {
		if (debounceHandle !== null) {
			timer.clearTimer(debounceHandle);
			debounceHandle = null;
		}
	}

	/** (Re)arm the {@link FLUSH_DEBOUNCE_MS} debounce — fires a serialized flush when it elapses. */
	function armDebounce(): void {
		disarmDebounce();
		debounceHandle = timer.setTimer(() => {
			debounceHandle = null;
			// Fire-and-serialize: a debounced flush joins the chain; rejections are owned by the
			// chain (a later enqueue's flush still sees the re-queued rows).
			void flush();
		}, FLUSH_DEBOUNCE_MS);
	}

	function enqueue(write: PendingWrite): void {
		const existing = pending.get(write.path);
		if (write.verb === "append" && existing !== undefined) {
			// Append-accumulate (b-AC-5): a write that replaces wins; consecutive appends to the
			// same path accumulate their tails so one flush concats the whole accumulated tail.
			const verb: PendingWrite["verb"] = existing.verb === "write" ? "write" : "append";
			pending.set(write.path, { ...existing, verb, body: existing.body + write.body });
		} else {
			// A `write` REPLACES (same path → latest body wins); a first `append` seeds the tail.
			pending.set(write.path, write);
		}

		if (pending.size >= FLUSH_AT_PENDING) {
			disarmDebounce();
			void flush();
		} else {
			armDebounce();
		}
	}

	/**
	 * The serialized flush. Chains off the in-flight flush so two never interleave, then drains
	 * the pending map and dispatches every row, re-queueing the rejects (b-AC-1).
	 */
	function flush(): Promise<FlushOutcome> {
		const run = flushChain.then(() => doFlush());
		// Keep the chain alive regardless of this flush's outcome — the NEXT flush must await
		// this one's settlement, not inherit its rejection.
		flushChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * Drain the pending map and dispatch every buffered row in parallel. A row whose dispatch
	 * REJECTS is RE-QUEUED into the pending map (unless a newer write for that path already
	 * landed during the flush). Resolves with the flushed/requeued counts.
	 */
	async function doFlush(): Promise<FlushOutcome> {
		disarmDebounce();
		if (pending.size === 0) return { flushed: 0, requeued: 0 };

		// Snapshot + clear: writes that land DURING the flush re-populate `pending` and are not
		// lost (they flush next pass), and a re-queued reject won't clobber a newer write.
		const batch = [...pending.values()];
		pending.clear();

		const results = await Promise.allSettled(batch.map((write) => upsertRow(write)));

		let requeued = 0;
		results.forEach((result, i) => {
			if (result.status === "rejected") {
				const write = batch[i];
				// Re-queue ONLY if no newer write for this path landed during the flush (FR-3).
				if (!pending.has(write.path)) {
					pending.set(write.path, write);
					requeued++;
				}
			}
		});

		const flushed = batch.length - requeued;
		return { flushed, requeued };
	}

	/** Dispatch one buffered write by path kind (FR-4). Goal/kpi → SELECT-before-INSERT; else memory. */
	async function upsertRow(write: PendingWrite): Promise<void> {
		switch (write.pathClass) {
			case "goal":
				await upsertGoalRow(write);
				return;
			case "kpi":
				await upsertKpiRow(write);
				return;
			default:
				await upsertMemoryRow(write);
		}
	}

	// ── memory upsert (b-AC-5 / FR-5) ──────────────────────────────────────────────────────

	/**
	 * Flush a generic `memory` write/append (b-AC-5 / FR-5). An `append` issues a SQL-level
	 * CONCAT (`summary = summary || E'...'`) and INVALIDATES the cache — NO read-back. A `write`
	 * is an update-or-insert by `path`: a row already flushed at this path UPDATEs in place; a
	 * fresh path INSERTs. Embeddings disabled → NULL vector (b-AC-4).
	 */
	async function upsertMemoryRow(write: PendingWrite): Promise<void> {
		if (write.verb === "append") {
			await dispatch.query(buildMemoryAppendSql(write.path, write.body), scope);
			cache.delete(write.path); // invalidate — a later read re-resolves the concatenated body.
			return;
		}

		const vectorLiteral = await embedLiteral(write.body);
		// Probe the path so a re-flush of the same path UPDATEs rather than double-INSERTs.
		const existing = await dispatch.query(buildMemoryProbeSql(write.path), scope);
		const sql =
			existing.length > 0
				? buildMemoryUpdateSql(write.path, write.body, vectorLiteral)
				: buildMemoryInsertSql(write.path, write.body, vectorLiteral);
		await dispatch.query(sql, scope);
		cache.set(write.path, write.body);
	}

	// ── goal / kpi SELECT-before-INSERT (b-AC-6 / FR-4) ────────────────────────────────────

	/**
	 * Flush a goal write via SELECT-before-INSERT keyed by `goal_id` (b-AC-6). Decomposes the
	 * path into owner/status/goal_id, probes the `goals` table for the goal_id (the logical
	 * key), and UPDATEs the existing row or INSERTs a new one — working around DeepLake's
	 * UPDATE-coalescing quirk. Dispatched through the daemon.
	 */
	async function upsertGoalRow(write: PendingWrite): Promise<void> {
		const parts = decomposeGoalPath(write.path);
		if (parts === null) {
			// A path that classified `goal` but won't decompose is a programmer error upstream —
			// fall back to a generic memory write rather than build a malformed goals statement.
			await upsertMemoryRow({ ...write, pathClass: "memory" });
			return;
		}
		const existing = await dispatch.query(buildGoalProbeSql(parts.goalId), scope);
		const sql =
			existing.length > 0
				? buildGoalUpdateSql(parts.goalId, parts.owner, parts.status, write.body)
				: buildGoalInsertSql(parts.goalId, parts.owner, parts.status, write.body);
		await dispatch.query(sql, scope);
	}

	/**
	 * Flush a kpi write via SELECT-before-INSERT keyed by `goal_id, kpi_id` (b-AC-6). The
	 * composite key is `<goal_id>/<kpi_id>` on the `kpis` table's `key` column.
	 */
	async function upsertKpiRow(write: PendingWrite): Promise<void> {
		const parts = decomposeKpiPath(write.path);
		if (parts === null) {
			await upsertMemoryRow({ ...write, pathClass: "memory" });
			return;
		}
		const key = kpiKey(parts.goalId, parts.kpiId);
		const existing = await dispatch.query(buildKpiProbeSql(key), scope);
		const sql =
			existing.length > 0 ? buildKpiUpdateSql(key, write.body) : buildKpiInsertSql(key, write.body);
		await dispatch.query(sql, scope);
	}

	// ── rm → soft-close (b-AC-2 / D-8 / FR-8) ──────────────────────────────────────────────

	/**
	 * Soft-close a goal (b-AC-2 / FR-8): flip its `status` to `closed`, PRESERVING the row (no
	 * DELETE). `rm` on an ALREADY-closed goal is a NO-OP — history can never be wiped. The
	 * goal_id is the probe key (SELECT-before-INSERT): an existing open row UPDATEs to closed;
	 * an already-closed (or absent) row is left untouched.
	 */
	async function softCloseGoal(path: string): Promise<void> {
		const parts = decomposeGoalPath(path);
		if (parts === null) return; // not a goal shape → nothing to soft-close.
		if (parts.status === "closed") return; // already-closed = no-op (b-AC-2).

		const existing = await dispatch.query(buildGoalProbeSql(parts.goalId), scope);
		if (existing.length === 0) return; // no row to close → no-op.

		const current = currentStatus(existing);
		if (current === "closed") return; // observed-closed = no-op (history preserved).

		// Flip status → closed, preserve created_at, record updated_at. UPDATE not DELETE.
		await dispatch.query(buildGoalCloseSql(parts.goalId), scope);
	}

	// ── mv → status transition (b-AC-3 / D-8 / FR-9) ───────────────────────────────────────

	/**
	 * Transition a goal's status via `mv` (b-AC-3 / FR-9). ONLY the status component may differ:
	 * the `goal_id` AND `owner` must match between the source and destination paths. A re-key or
	 * re-owner fails {@link GoalTransitionError} (EPERM). A status-only move UPDATEs the row's
	 * status in place (no cp-then-rm double write).
	 */
	async function transitionGoal(fromPath: string, toPath: string): Promise<void> {
		const from = decomposeGoalPath(fromPath);
		const to = decomposeGoalPath(toPath);
		if (from === null || to === null) {
			throw new GoalTransitionError(`mv requires two goal paths: ${fromPath} → ${toPath}`);
		}
		if (from.goalId !== to.goalId) {
			throw new GoalTransitionError(`a goal cannot be re-keyed via mv (${from.goalId} → ${to.goalId})`);
		}
		if (from.owner !== to.owner) {
			throw new GoalTransitionError(`a goal cannot be re-owned via mv (${from.owner} → ${to.owner})`);
		}
		if (from.status === to.status) return; // no status change → nothing to dispatch.
		await dispatch.query(buildGoalStatusTransitionSql(to.goalId, to.status), scope);
	}

	/** Render a body as the row's vector literal — the embedding when enabled, else SQL NULL (b-AC-4). */
	async function embedLiteral(body: string): Promise<string> {
		if (embedder === undefined) return "NULL"; // embeddings disabled → NULL vector.
		const vector = await embedder.embed(body);
		return floatArrayLiteral(vector);
	}

	return { enqueue, flush, softCloseGoal, transitionGoal };
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL builders — every value through sLiteral/eLiteral, every identifier through sqlIdent.
// The `memory` table is the VFS/summaries table (path/summary/summary_embedding/...). The
// `goals`/`kpis` tables are keyed by the logical `key` column (the goal_id, or goal_id/kpi_id).
// ─────────────────────────────────────────────────────────────────────────────

/** The composite kpi key — `<goal_id>/<kpi_id>` on the `kpis.key` column (b-AC-6). */
export function kpiKey(goalId: string, kpiId: string): string {
	return `${goalId}/${kpiId}`;
}

/** Probe the `memory` table for an existing row at `path` (the update-or-insert decision). */
export function buildMemoryProbeSql(path: string): string {
	const tbl = sqlIdent("memory");
	const pathCol = sqlIdent("path");
	return `SELECT ${pathCol} FROM "${tbl}" WHERE ${pathCol} = ${sLiteral(path)} LIMIT 1`;
}

/**
 * Build the `memory` INSERT (FR-5). Writes `path` + `summary` + the vector literal (NULL when
 * embeddings are disabled, b-AC-4). The body uses the `E'...'` form (`eLiteral`) so escape
 * sequences round-trip; the vector literal is a pre-validated `NULL` or `ARRAY[...]::FLOAT4[]`.
 */
export function buildMemoryInsertSql(path: string, body: string, vectorLiteral: string): string {
	const tbl = sqlIdent("memory");
	const cols = [sqlIdent("path"), sqlIdent("summary"), sqlIdent("summary_embedding")].join(", ");
	return `INSERT INTO "${tbl}" (${cols}) VALUES (${sLiteral(path)}, ${eLiteral(body)}, ${vectorLiteral})`;
}

/** Build the `memory` UPDATE-in-place (FR-5) for an existing path — rewrites summary + vector. */
export function buildMemoryUpdateSql(path: string, body: string, vectorLiteral: string): string {
	const tbl = sqlIdent("memory");
	const summary = sqlIdent("summary");
	const vector = sqlIdent("summary_embedding");
	const pathCol = sqlIdent("path");
	return (
		`UPDATE "${tbl}" SET ${summary} = ${eLiteral(body)}, ${vector} = ${vectorLiteral} ` +
		`WHERE ${pathCol} = ${sLiteral(path)}`
	);
}

/**
 * Build the `memory` APPEND concat (b-AC-5 / FR-6): `summary = summary || E'...'`. A SQL-level
 * concatenation — the existing body is NEVER read back into the client first. The append tail
 * uses the `E'...'` form so embedded escape sequences survive.
 */
export function buildMemoryAppendSql(path: string, tail: string): string {
	const tbl = sqlIdent("memory");
	const summary = sqlIdent("summary");
	const pathCol = sqlIdent("path");
	return `UPDATE "${tbl}" SET ${summary} = ${summary} || ${eLiteral(tail)} WHERE ${pathCol} = ${sLiteral(path)}`;
}

/** Probe the `goals` table for an existing row keyed by goal_id (the SELECT of SELECT-before-INSERT). */
export function buildGoalProbeSql(goalId: string): string {
	const tbl = sqlIdent("goals");
	const keyCol = sqlIdent("key");
	const statusCol = sqlIdent("status");
	return `SELECT ${keyCol}, ${statusCol} FROM "${tbl}" WHERE ${keyCol} = ${sLiteral(goalId)} LIMIT 1`;
}

/** Build the `goals` INSERT for a new goal_id (the INSERT of SELECT-before-INSERT). */
export function buildGoalInsertSql(goalId: string, owner: string, status: string, body: string): string {
	const tbl = sqlIdent("goals");
	const cols = [
		sqlIdent("key"),
		sqlIdent("value"),
		sqlIdent("status"),
		sqlIdent("agent_id"),
	].join(", ");
	return (
		`INSERT INTO "${tbl}" (${cols}) ` +
		`VALUES (${sLiteral(goalId)}, ${eLiteral(body)}, ${sLiteral(status)}, ${sLiteral(owner)})`
	);
}

/** Build the `goals` UPDATE for an existing goal_id (the UPDATE of SELECT-before-INSERT). */
export function buildGoalUpdateSql(goalId: string, owner: string, status: string, body: string): string {
	const tbl = sqlIdent("goals");
	const keyCol = sqlIdent("key");
	return (
		`UPDATE "${tbl}" SET ${sqlIdent("value")} = ${eLiteral(body)}, ` +
		`${sqlIdent("status")} = ${sLiteral(status)}, ${sqlIdent("agent_id")} = ${sLiteral(owner)} ` +
		`WHERE ${keyCol} = ${sLiteral(goalId)}`
	);
}

/** Build the `goals` soft-close UPDATE (b-AC-2): flip status → `closed`, preserve the row. */
export function buildGoalCloseSql(goalId: string): string {
	const tbl = sqlIdent("goals");
	const keyCol = sqlIdent("key");
	return `UPDATE "${tbl}" SET ${sqlIdent("status")} = ${sLiteral("closed")} WHERE ${keyCol} = ${sLiteral(goalId)}`;
}

/** Build the `goals` status-transition UPDATE (b-AC-3): set the new status for the goal_id. */
export function buildGoalStatusTransitionSql(goalId: string, status: string): string {
	const tbl = sqlIdent("goals");
	const keyCol = sqlIdent("key");
	return `UPDATE "${tbl}" SET ${sqlIdent("status")} = ${sLiteral(status)} WHERE ${keyCol} = ${sLiteral(goalId)}`;
}

/** Probe the `kpis` table for an existing row keyed by the composite `goal_id/kpi_id`. */
export function buildKpiProbeSql(key: string): string {
	const tbl = sqlIdent("kpis");
	const keyCol = sqlIdent("key");
	return `SELECT ${keyCol} FROM "${tbl}" WHERE ${keyCol} = ${sLiteral(key)} LIMIT 1`;
}

/** Build the `kpis` INSERT for a new composite key. */
export function buildKpiInsertSql(key: string, body: string): string {
	const tbl = sqlIdent("kpis");
	const cols = [sqlIdent("key"), sqlIdent("value")].join(", ");
	return `INSERT INTO "${tbl}" (${cols}) VALUES (${sLiteral(key)}, ${eLiteral(body)})`;
}

/** Build the `kpis` UPDATE for an existing composite key. */
export function buildKpiUpdateSql(key: string, body: string): string {
	const tbl = sqlIdent("kpis");
	const keyCol = sqlIdent("key");
	return `UPDATE "${tbl}" SET ${sqlIdent("value")} = ${eLiteral(body)} WHERE ${keyCol} = ${sLiteral(key)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The status cell of a probed goal row (tolerates a missing/non-string value). */
function currentStatus(rows: Rows): string {
	const first: Row | undefined = rows[0];
	if (first === undefined) return "";
	const status = first.status;
	return typeof status === "string" ? status : status === undefined || status === null ? "" : String(status);
}

/**
 * Render a numeric vector as a DeepLake `FLOAT4[]` literal: `ARRAY[1,2,3]::FLOAT4[]`. Only
 * finite numbers survive (a NaN/Infinity is dropped) so the literal is always well-formed; the
 * empty vector renders `ARRAY[]::FLOAT4[]`. No string interpolation, so no injection surface.
 */
export function floatArrayLiteral(vector: readonly number[]): string {
	const parts = vector.filter((n) => Number.isFinite(n)).map((n) => String(n));
	return `ARRAY[${parts.join(",")}]::FLOAT4[]`;
}
