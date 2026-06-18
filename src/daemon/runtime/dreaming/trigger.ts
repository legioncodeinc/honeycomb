/**
 * Dreaming token-budget trigger — PRD-009a (IMPLEMENTED, Wave 1).
 *
 * The `dreaming_state` counter lifecycle: increment on every session-summary write
 * (FR-2), compare against the threshold on each maintenance tick (FR-3), and at the
 * threshold — with no pass already pending — enqueue exactly ONE dreaming job,
 * record its `pending_job_id`, and reset the counter by SUBTRACTING the threshold
 * (FR-4 / FR-5 / FR-6). The trigger lives entirely inside the daemon maintenance
 * loop; nothing outside the daemon reads or writes the counter.
 *
 * ── Append-only version-bumped (D-3 / FR-8 / a-AC-2 / a-AC-5) ────────────────
 * Every increment and every reset APPENDs a new `dreaming_state` row at `version` =
 * N+1 via `appendVersionBumped`; the counter's current value is the
 * HIGHEST-`version` row, resolved POLL-CONVERGENTLY (the same live
 * segment-freshness handling the job queue uses — a single by-id read can land on a
 * stale segment and under-report, so we keep the MAX across a bounded poll union).
 * NEVER an in-place UPDATE (FR-8). A daemon restart reads back every committed write
 * through the highest-version read, so the counter is durable (a-AC-5).
 *
 * ── The reset SUBTRACTS the threshold, it does NOT hard-zero (D-3 / FR-5) ────
 * `checkAndEnqueueDreaming` reads the current counter, enqueues, then appends a
 * reset row whose `tokens_since_last_pass` = `current - tokenThreshold` (floored at
 * 0). A summary write that lands between the threshold READ and the reset APPEND is
 * NOT lost: it folded into a HIGHER version than the one we read, and because the
 * reset SUBTRACTS rather than zeroes, the overflow accumulates toward the next pass.
 * (The append-only path means a concurrent increment and our reset are two distinct
 * rows; the next read resolves the highest version. On this backend an in-place
 * UPDATE-to-zero would both risk the lost-write race AND be non-deterministic to
 * read back — D-3 chose SUBTRACT-on-append for exactly this reason.)
 *
 * ── The single-pending guard (FR-6 / a-AC-3) ────────────────────────────────
 * When the current row's `pending_job_id` is non-empty, a pass is in flight and the
 * trigger enqueues NOTHING until that job reaches a TERMINAL state. The runner
 * (009b) clears `pending_job_id` on success; the maintenance loop's terminal check
 * ({@link isPendingJobTerminal}) clears it when the job died/completed without the
 * runner clearing it, so a crashed pass never wedges the scope forever.
 *
 * ── The enabled gate (FR-7 / a-AC-4) ────────────────────────────────────────
 * When `config.enabled` is false the trigger STILL increments (so re-enabling
 * resumes from accumulated tokens) but enqueues NOTHING.
 *
 * ── Scope (D-1 / a-AC-6) ────────────────────────────────────────────────────
 * The counter is keyed per (org, workspace, agent_id): the org/workspace half rides
 * the `QueryScope` partition; the `agent_id` is the inner key on every row + the
 * deterministic `id`. Two agent_ids under one workspace accumulate independently.
 *
 * ── SQL safety (a-AC-7) ─────────────────────────────────────────────────────
 * Every value routes through `val.*` (→ `sLiteral`/`eLiteral`) or `sLiteral`; every
 * identifier through `sqlIdent`. No hand-quoted value; no raw fetch. `audit:sql`
 * scans `src/daemon`.
 */

import crypto from "node:crypto";

import { DREAMING_STATE_TABLE, healTargetFor } from "../../storage/catalog/index.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { HealTarget } from "../../storage/heal.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { appendVersionBumped, val } from "../../storage/writes.js";
import { DREAMING_JOB_KIND, type DreamingPassMode } from "./contracts.js";
import type { DreamingConfig } from "./config.js";

/**
 * The agent identity the counter is keyed by, within a `QueryScope` partition (D-1).
 * The org/workspace half is the partition; this is the inner agent ring.
 */
export interface DreamingScope {
	/** The agent id the counter accumulates for (default `'default'`). */
	readonly agentId: string;
}

/**
 * The current resolved state of a scope's counter (the highest-version row),
 * projected into plain fields. `version` 0 means the scope has no row yet.
 */
export interface DreamingState {
	/** The deterministic per-scope row id. */
	readonly id: string;
	/** Running token count since the last pass (FR-2). */
	readonly tokensSinceLastPass: number;
	/** ISO-8601 timestamp of the last completed pass; empty until the first. */
	readonly lastPassAt: string;
	/** The in-flight dreaming job's id, or empty when none is pending (FR-6). */
	readonly pendingJobId: string;
	/** The highest version observed (0 when the scope has no row yet). */
	readonly version: number;
}

/**
 * The job-enqueue seam the trigger uses (FR-4). The real daemon injects the PRD-004b
 * `JobQueueService.enqueue`; a test injects a fake that records the call. Kept narrow
 * (just `enqueue`) so the trigger holds no queue lifecycle knowledge and a test
 * scripts exactly one method.
 */
export interface DreamingJobEnqueuer {
	/** Enqueue a job for durable background processing; returns its durable id. */
	enqueue(job: { readonly kind: string; readonly payload: Record<string, unknown> }): Promise<string>;
}

/**
 * Terminal-state probe for the pending guard (FR-6). The maintenance loop injects a
 * function that resolves the pending job's CURRENT status from `memory_jobs` and
 * answers whether it has reached a terminal state (`done` / `dead`). The trigger
 * stays decoupled from the queue's read internals. Default (no probe) treats a
 * pending job as NOT terminal — the conservative posture: never enqueue a second
 * pass on a guess.
 */
export type PendingJobTerminalProbe = (jobId: string) => Promise<boolean>;

/**
 * Poll budget for resolving the counter's current (highest-version) row, robust to
 * this backend's segment-freshness flap (the same rationale as the job queue's
 * `RESOLVE_POLLS`). A single by-id read can land on a stale segment and under-report
 * the version; because versions are append-only and monotone, the MAX across a few
 * polls converges UP to the truth. The deterministic fake settles on the first read,
 * so this is a live-only cost.
 */
const RESOLVE_POLLS = 8;

/** ISO timestamp helper (injectable clock keeps tests deterministic). */
export interface DreamingClock {
	/** Current wall-clock time in ms (defaults to `Date.now`). */
	readonly now: () => number;
}

/** The default clock: real `Date.now`. */
function defaultClock(): DreamingClock {
	return { now: () => Date.now() };
}

/**
 * Derive the deterministic `dreaming_state` row id for a scope (D-1). Keyed on the
 * `agentId` only — the org/workspace half rides the `QueryScope` partition, so the
 * same agent under different partitions is a DIFFERENT physical row even though the
 * id matches, and two agents under one partition get DISTINCT ids (a-AC-6). Prefixed
 * `dream_`. Pure.
 */
export function dreamingStateId(scope: DreamingScope): string {
	const hash = crypto.createHash("sha256").update(`dreaming:${scope.agentId}`).digest("hex").slice(0, 24);
	return `dream_${hash}`;
}

/** Coerce a row's BIGINT column to a finite number (0 when absent/garbage). */
function rowNumber(row: StorageRow, column: string): number {
	const raw = row[column];
	const n = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(n) ? n : 0;
}

/** Coerce a row's TEXT column to a string ("" when absent). */
function rowText(row: StorageRow, column: string): string {
	const raw = row[column];
	return typeof raw === "string" ? raw : raw === undefined || raw === null ? "" : String(raw);
}

/** The columns a current-state resolve reads back. */
const STATE_COLUMNS = ["tokens_since_last_pass", "last_pass_at", "pending_job_id", "version"] as const;

/** Construction deps for the dreaming trigger. */
export interface DreamingTriggerDeps {
	/** Run queries through this — never a raw fetch. */
	readonly storage: StorageQuery;
	/** The resolved `{ org, workspace }` partition for counter rows. */
	readonly scope: QueryScope;
	/** The resolved `memory.dreaming` config. */
	readonly config: DreamingConfig;
	/** The job-enqueue seam (the PRD-004b queue in prod; a fake in tests). */
	readonly enqueuer: DreamingJobEnqueuer;
	/** Optional injected clock (real `Date.now` otherwise). */
	readonly clock?: DreamingClock;
	/** Optional pending-job terminal probe (default: never terminal — the safe guard). */
	readonly pendingTerminal?: PendingJobTerminalProbe;
	/**
	 * Optional physical table name override. Defaults to the canonical
	 * `dreaming_state`. Exists so the opt-in LIVE counter smoke can point the trigger
	 * at a throwaway, namespaced table it is free to DROP, WITHOUT touching a real
	 * daemon's shared `dreaming_state`. Validated through `sqlIdent`; the COLUMNS are
	 * always the catalog's single-sourced `DREAMING_STATE_COLUMNS`.
	 */
	readonly tableName?: string;
}

/**
 * The dreaming trigger. Construct via {@link createDreamingTrigger} with the storage
 * client, the resolved partition scope, the dreaming config, and the job enqueuer.
 * Daemon-assembly (wiring this into the maintenance loop + the summary writer) is
 * DEFERRED — the trigger is constructed-and-tested in Wave 1.
 */
export class DreamingTrigger {
	private readonly storage: StorageQuery;
	private readonly scope: QueryScope;
	private readonly config: DreamingConfig;
	private readonly enqueuer: DreamingJobEnqueuer;
	private readonly clock: DreamingClock;
	private readonly pendingTerminal: PendingJobTerminalProbe;
	private readonly target: HealTarget;

	private readonly tableName: string;

	constructor(deps: DreamingTriggerDeps) {
		this.storage = deps.storage;
		this.scope = deps.scope;
		this.config = deps.config;
		this.enqueuer = deps.enqueuer;
		this.clock = deps.clock ?? defaultClock();
		// Default probe: never report terminal — never enqueue a 2nd pass on a guess (FR-6).
		this.pendingTerminal = deps.pendingTerminal ?? (() => Promise.resolve(false));
		// The physical table name (validated through `sqlIdent` like every identifier).
		// Defaults to the catalog's canonical `dreaming_state`; the opt-in LIVE counter
		// smoke points it at a throwaway, namespaced table it is free to DROP, exactly
		// as the job queue does — the COLUMNS are always the catalog's single-sourced
		// `DREAMING_STATE_COLUMNS`, only the name is parameterized.
		this.tableName = sqlIdent(deps.tableName ?? DREAMING_STATE_TABLE);
		this.target = { table: this.tableName, columns: healTargetFor(DREAMING_STATE_TABLE).columns };
	}

	private nowIso(): string {
		return new Date(this.clock.now()).toISOString();
	}

	private tbl(): string {
		return sqlIdent(this.tableName);
	}

	/**
	 * Read a scope's CURRENT (highest-version) counter row, poll-convergent against
	 * the backend's segment-freshness flap. Returns a zero-version {@link DreamingState}
	 * when the scope has no row yet. The `agent_id` conjunct keeps the read inside the
	 * scope's agent ring (a-AC-6).
	 */
	async readState(scope: DreamingScope): Promise<DreamingState> {
		const id = dreamingStateId(scope);
		let best: DreamingState | null = null;
		let seenBestTwice = false;
		for (let poll = 0; poll < RESOLVE_POLLS; poll++) {
			const row = await this.latestRow(id, scope.agentId);
			if (row !== null) {
				const version = rowNumber(row, "version");
				if (best === null || version > best.version) {
					best = {
						id,
						tokensSinceLastPass: rowNumber(row, "tokens_since_last_pass"),
						lastPassAt: rowText(row, "last_pass_at"),
						pendingJobId: rowText(row, "pending_job_id"),
						version,
					};
					seenBestTwice = false;
				} else if (version === best.version) {
					if (seenBestTwice) break; // stable: same max seen 3x → converged.
					seenBestTwice = true;
				}
			}
		}
		return best ?? { id, tokensSinceLastPass: 0, lastPassAt: "", pendingJobId: "", version: 0 };
	}

	/** One highest-version by-id read of the counter row (scoped by agent), or `null`. */
	private async latestRow(id: string, agentId: string): Promise<StorageRow | null> {
		const cols = STATE_COLUMNS.map((c) => sqlIdent(c)).join(", ");
		const sql =
			`SELECT ${cols} FROM "${this.tbl()}" ` +
			`WHERE ${sqlIdent("id")} = ${sLiteral(id)} AND ${sqlIdent("agent_id")} = ${sLiteral(agentId)} ` +
			`ORDER BY ${sqlIdent("version")} DESC LIMIT 1`;
		const res = await this.storage.query(sql, this.scope);
		if (isOk(res) && res.rows.length > 0) return res.rows[0] as StorageRow;
		return null;
	}

	/**
	 * Append a new counter version carrying the supplied fields (FR-8). The single
	 * write primitive for every increment/reset/pending-set: it reads the current MAX
	 * version for the scope and INSERTs version N+1 via `appendVersionBumped`, never an
	 * in-place UPDATE. Heal-aware (the first write to a missing `dreaming_state` table
	 * CREATEs it). Returns the new version.
	 */
	private async appendVersion(
		state: DreamingState,
		scope: DreamingScope,
		fields: { tokensSinceLastPass: number; lastPassAt: string; pendingJobId: string },
	): Promise<number> {
		const now = this.nowIso();
		const createdAt = state.version === 0 ? now : ""; // first row stamps created_at; later rows leave it default.
		const { version } = await appendVersionBumped(this.storage, this.target, this.scope, {
			keyColumn: "id",
			keyValue: state.id,
			row: [
				["id", val.str(state.id)],
				["tokens_since_last_pass", val.num(Math.max(0, Math.trunc(fields.tokensSinceLastPass)))],
				["last_pass_at", val.str(fields.lastPassAt)],
				["pending_job_id", val.str(fields.pendingJobId)],
				["agent_id", val.str(scope.agentId)],
				["visibility", val.str("global")],
				["created_at", val.str(createdAt === "" ? now : createdAt)],
				["updated_at", val.str(now)],
			],
		});
		return version;
	}

	/**
	 * Increment a scope's counter by `tokens` on a session-summary write (FR-2 /
	 * a-AC-1). Reads the current highest-version row, appends a new version whose
	 * `tokens_since_last_pass` is `current + tokens`, carrying `last_pass_at` +
	 * `pending_job_id` forward unchanged. Runs REGARDLESS of `config.enabled` (FR-7 /
	 * a-AC-4): a disabled loop still accumulates so re-enabling resumes from the
	 * accrued total. Negative/garbage `tokens` floor to 0 (a summary never decrements).
	 * Returns the new counter value.
	 */
	async incrementDreamingCounter(scope: DreamingScope, tokens: number): Promise<number> {
		const delta = Number.isFinite(tokens) ? Math.max(0, Math.trunc(tokens)) : 0;
		const state = await this.readState(scope);
		const next = state.tokensSinceLastPass + delta;
		await this.appendVersion(state, scope, {
			tokensSinceLastPass: next,
			lastPassAt: state.lastPassAt,
			pendingJobId: state.pendingJobId,
		});
		return next;
	}

	/**
	 * The maintenance-tick check (FR-3 / FR-4 / FR-5 / FR-6 / a-AC-2 / a-AC-3 / a-AC-4).
	 *
	 * For the given scope:
	 *   1. Resolve the current counter (highest-version read).
	 *   2. If a pass is already pending ({@link DreamingState.pendingJobId} non-empty),
	 *      consult the terminal probe (FR-6). NOT terminal → return `skipped` (the
	 *      single-pending guard, a-AC-3). Terminal → CLEAR the pending id (append a
	 *      version that zeroes `pending_job_id`, carrying the counter forward) so a
	 *      fresh pass can be queued on a later tick.
	 *   3. If `config.enabled` is false → return `disabled` (FR-7 / a-AC-4); the
	 *      counter keeps growing via {@link incrementDreamingCounter}, but no enqueue.
	 *   4. If `tokensSinceLastPass < tokenThreshold` → return `below_threshold`.
	 *   5. Otherwise ENQUEUE exactly one dreaming job, then append a reset version that
	 *      records the new `pending_job_id` AND subtracts the threshold from the counter
	 *      (FR-5). The enqueue happens BEFORE the reset so the `pending_job_id` we write
	 *      is the real queued id; a concurrent increment between read and reset is
	 *      preserved because the reset SUBTRACTS (never zeroes) and appends a new version.
	 *
	 * Returns the decision + (when enqueued) the job id and the post-reset counter.
	 */
	async checkAndEnqueueDreaming(
		scope: DreamingScope,
		mode: DreamingPassMode = "incremental",
	): Promise<DreamingTickResult> {
		const state = await this.readState(scope);

		// 2. Single-pending guard (FR-6 / a-AC-3).
		if (state.pendingJobId !== "") {
			const terminal = await this.pendingTerminal(state.pendingJobId);
			if (!terminal) {
				return { decision: "skipped", reason: "pending", tokens: state.tokensSinceLastPass };
			}
			// Terminal but not yet cleared by the runner: clear the guard, carry the
			// counter forward, and let a LATER tick evaluate the threshold afresh.
			await this.appendVersion(state, scope, {
				tokensSinceLastPass: state.tokensSinceLastPass,
				lastPassAt: state.lastPassAt,
				pendingJobId: "",
			});
			return { decision: "skipped", reason: "pending-cleared", tokens: state.tokensSinceLastPass };
		}

		// 3. Enabled gate (FR-7 / a-AC-4).
		if (!this.config.enabled) {
			return { decision: "disabled", reason: "disabled", tokens: state.tokensSinceLastPass };
		}

		// 4. Below threshold (FR-3).
		if (state.tokensSinceLastPass < this.config.tokenThreshold) {
			return { decision: "below_threshold", reason: "below-threshold", tokens: state.tokensSinceLastPass };
		}

		// 5. Threshold met + no pending → enqueue ONE job, then reset by SUBTRACT (FR-4 / FR-5 / a-AC-2).
		const jobId = await this.enqueuer.enqueue({
			kind: DREAMING_JOB_KIND,
			payload: {
				mode,
				agentId: scope.agentId,
				enqueuedAt: this.nowIso(),
				tokensAtEnqueue: state.tokensSinceLastPass,
			},
		});
		const resetTokens = state.tokensSinceLastPass - this.config.tokenThreshold; // SUBTRACT, not zero (FR-5).
		await this.appendVersion(state, scope, {
			tokensSinceLastPass: resetTokens,
			lastPassAt: state.lastPassAt,
			pendingJobId: jobId,
		});
		return {
			decision: "enqueued",
			reason: "threshold-met",
			tokens: Math.max(0, resetTokens),
			jobId,
		};
	}
}

/** The decision a maintenance tick reached for a scope. */
export type DreamingTickDecision = "enqueued" | "skipped" | "disabled" | "below_threshold";

/** Why a tick reached its decision (for diagnostics + tests). */
export type DreamingTickReason =
	| "threshold-met"
	| "pending"
	| "pending-cleared"
	| "disabled"
	| "below-threshold";

/** The outcome of one maintenance-tick check for a scope. */
export interface DreamingTickResult {
	/** What the tick decided. */
	readonly decision: DreamingTickDecision;
	/** Why it decided that. */
	readonly reason: DreamingTickReason;
	/** The counter value after the tick (post-reset when enqueued). */
	readonly tokens: number;
	/** The enqueued job id, present only when `decision === "enqueued"`. */
	readonly jobId?: string;
}

/** Build a {@link DreamingTrigger}. The daemon injects the real deps; tests inject fakes. */
export function createDreamingTrigger(deps: DreamingTriggerDeps): DreamingTrigger {
	return new DreamingTrigger(deps);
}
