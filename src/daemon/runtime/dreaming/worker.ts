/**
 * Daemon-resident DREAMING JOB WORKER — PRD-026 Wave 1 Track B (AC-W).
 *
 * The PRD-009 dreaming loop is REAL but had no live CONSUMER: the trigger
 * (`trigger.ts`) enqueues a `dreaming` job into `memory_jobs`, and the runner
 * (`runner.ts`) runs the full pass lifecycle — but nothing in the daemon LEASES a
 * `dreaming` job and invokes the runner. This worker is that consumer. It is the
 * dreaming analogue of the PRD-006 `pipeline/stage-worker.ts` (its template): the
 * same `runOnce()` / `start()` / `stop()` shape, the same overlap guard, the same
 * injected `setTimer`/`clearTimer` seam, the same try/catch that routes a throw to
 * `queue.fail` (never a swallowed error).
 *
 * ── Kind-filtered lease — NEVER touch a foreign job (the load-bearing invariant) ─
 * Capture also enqueues `summary` / `skillify` jobs into the SAME `memory_jobs`
 * queue. A generic `lease()` would let this worker grab one of those, fail to parse
 * it as a dreaming payload, and `fail()` it — walking a legit job toward `dead`. So
 * the worker leases ONLY `["dreaming"]` (the additive `JobQueueService.lease(kinds)`
 * kind filter, PRD-026). Anything that is not a dreaming job is left QUEUED for its
 * own worker; this worker never sees it.
 *
 * ── runOnce() lifecycle ──────────────────────────────────────────────────────
 *   1. `queue.lease([DREAMING_JOB_KIND])` → `null` ⇒ nothing to do, return false.
 *   2. Parse the payload via `parseDreamingJobPayload` (the queue boundary). A
 *      MALFORMED payload is a wiring/corruption bug worth surfacing — `queue.fail`
 *      it with a clear reason and return true; NEVER silently `complete` it.
 *   3. Select the strategy by mode (D-4): `compaction` when the payload mode is
 *      `compaction` OR the first-run backfill helper (`shouldEnterCompaction`) says
 *      so for this scope's `last_pass_at`; else `incremental`. `maxInputTokens` is
 *      threaded from the resolved dreaming config into the strategy.
 *   4. Construct the runner with the injected `ModelClient`, the resolved
 *      `{ org, workspace }` scope, the selected strategy, and the state-updater, then
 *      `await runner.runPass(job)`. The runner owns the model call + the 008c
 *      `submitProposal` apply + the state update (`recordPassComplete`); the worker
 *      only constructs it.
 *   5. On success `queue.complete(id)`; on throw `queue.fail(id, message)` (mirrors
 *      the stage-worker's structured try/catch — the events are `dreaming.worker.*`).
 *
 * ── The worker holds NO provider / SQL knowledge ─────────────────────────────
 * The model is injected as a 006 `ModelClient` (the Wave-1c bee passes the real
 * RouterModelClient; tests inject `createFakeModelClient`). Every write goes through
 * the runner's `submitProposal` + the trigger's append-only state path — the worker
 * issues NO direct SQL. `audit:sql` scans `src/daemon`; this file builds no statement.
 *
 * ── ENABLEMENT IS THE ASSEMBLER'S CALL, NOT THIS FACTORY'S ────────────────────
 * `createDreamingWorker` does NOT decide whether dreaming is on. It builds a worker
 * unconditionally. The Wave-1c daemon-assembly bee constructs AND starts it ONLY when
 * `config.enabled` is true (default OFF — dreaming is a premium tier), and stops it in
 * teardown. Constructing the worker has no side effects until `start()` / `runOnce()`
 * is called, so a disabled daemon simply never builds it.
 */

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { ModelClient } from "../pipeline/model-client.js";
import { createCompactionStrategy, shouldEnterCompaction } from "./compaction.js";
import type { DreamingConfig } from "./config.js";
import { DREAMING_JOB_KIND, parseDreamingJobPayload, type DreamingJobPayload } from "./contracts.js";
import { createIncrementalStrategy } from "./incremental.js";
import { createDreamingRunner, type DreamingPayloadStrategy, type DreamingStateUpdater } from "./runner.js";
import type { DreamingScope, DreamingState } from "./trigger.js";
import type { JobQueueService } from "../services/job-queue.js";

/**
 * The narrow trigger seam the worker drives — exactly the two
 * {@link DreamingTrigger} methods it needs (PRD-026), nothing more. `readState`
 * resolves the scope's current counter (its highest-version `dreaming_state` row,
 * poll-convergent) so the worker can apply the first-run backfill rule WITHOUT
 * re-implementing that read; `recordPassComplete` is the additive append-only seam
 * the runner's state-updater is built from. Keeping it a two-method interface lets the
 * production path inject the REAL trigger and a test inject a recording fake, without
 * the worker holding any counter-write or SQL knowledge — the trigger owns both.
 */
export interface DreamingTriggerSeam {
	/** Resolve a scope's current counter state (highest-version, poll-convergent). */
	readState(scope: DreamingScope): Promise<DreamingState>;
	/** Stamp `last_pass_at` + clear `pending_job_id` for a scope (append-only). */
	recordPassComplete(scope: DreamingScope, passAt: string): Promise<void>;
}

/** A minimal structured-log sink (mirrors {@link StageWorkerLogger}). */
export interface DreamingWorkerLogger {
	/** Record a structured event (e.g. `dreaming.worker.completed`, `dreaming.worker.failed`). */
	event(name: string, fields?: Record<string, unknown>): void;
}

/** The injected clock, so a test stamps `last_pass_at` resolution deterministically. */
export interface DreamingWorkerClock {
	/** Current wall-clock time in ms (defaults to `Date.now`). */
	readonly now: () => number;
}

/**
 * Construction deps for {@link createDreamingWorker}. The Wave-1c daemon-assembly bee
 * passes these verbatim (gated on `config.enabled`); a test injects fakes.
 */
export interface DreamingWorkerDeps {
	/** The durable queue this worker leases `["dreaming"]` from + completes/fails through. */
	readonly queue: JobQueueService;
	/** The storage client the runner threads into `submitProposal` (never a raw fetch). */
	readonly storage: StorageQuery;
	/** The resolved `{ org, workspace }` partition the pass runs under (D-1 outer ring). */
	readonly scope: QueryScope;
	/** The resolved `memory.dreaming` config — supplies `maxInputTokens` + the backfill flag. */
	readonly config: DreamingConfig;
	/** The LLM seam; the runner calls the `memory_dreaming` workload (D-5 / b-AC-6). */
	readonly model: ModelClient;
	/**
	 * The trigger seam the worker drives — the REAL {@link DreamingTrigger} in prod
	 * (its `readState` + additive `recordPassComplete`), a fake in tests. The runner's
	 * state-updater is built from its `recordPassComplete`, and the first-run backfill
	 * rule reads `last_pass_at` via its `readState`. Required.
	 */
	readonly trigger: DreamingTriggerSeam;
	/**
	 * An OPTIONAL explicit {@link DreamingStateUpdater} override (the runner's seam,
	 * keyed by `agentId`). When supplied it replaces the adapter the worker builds from
	 * `trigger.recordPassComplete` — used by a test that wants to record the state write
	 * directly. Production leaves it unset.
	 */
	readonly stateUpdater?: DreamingStateUpdater;
	/** Optional structured-log sink. */
	readonly logger?: DreamingWorkerLogger;
	/** Optional injected clock (real `Date.now` otherwise). */
	readonly clock?: DreamingWorkerClock;
	/** Poll interval in ms when running the continuous loop. Default 1000. */
	readonly pollIntervalMs?: number;
	/** Injected timer scheduler (real `setInterval` otherwise) — for tests. */
	readonly setTimer?: (cb: () => void, ms: number) => unknown;
	/** Injected timer canceller (real `clearInterval` otherwise) — for tests. */
	readonly clearTimer?: (handle: unknown) => void;
}

/**
 * The dreaming job worker. Construct via {@link createDreamingWorker}. Exposes
 * `runOnce()` (lease + run a single dreaming job, the deterministic unit a test
 * drives) and `start()` / `stop()` (the continuous poll loop the daemon-assembly
 * uses). The single SHAPE is the PRD-006 `StageWorker`.
 */
export interface DreamingJobWorker {
	/**
	 * Lease the next `dreaming` job, run its pass, and complete/fail it. Returns
	 * `true` when a job was processed (completed OR failed), `false` when nothing was
	 * leasable. The single deterministic step a test asserts against.
	 */
	runOnce(): Promise<boolean>;
	/** Start the continuous poll loop (lease → run on an interval). */
	start(): void;
	/** Stop the poll loop. Idempotent. */
	stop(): void;
}

/** Default poll interval for the continuous loop (matches the stage worker). */
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** The single kind this worker leases — NEVER a foreign job. */
const LEASE_KINDS: readonly string[] = [DREAMING_JOB_KIND];

/**
 * Adapt a {@link DreamingTriggerSeam} (the trigger's `(scope, passAt)` recorder) onto a
 * {@link DreamingStateUpdater} (the runner's `(agentId, passAt)` seam). The runner calls
 * `recordPassComplete(agentId, passAt)`; we lift the `agentId` back into a
 * {@link DreamingScope} so the trigger's append-only counter write owns the mechanic.
 */
function stateUpdaterFromTrigger(trigger: DreamingTriggerSeam): DreamingStateUpdater {
	return {
		recordPassComplete(agentId: string, passAt: string): Promise<void> {
			return trigger.recordPassComplete({ agentId }, passAt);
		},
	};
}

/** The concrete worker. */
class DreamingJobWorkerImpl implements DreamingJobWorker {
	private readonly queue: JobQueueService;
	private readonly storage: StorageQuery;
	private readonly scope: QueryScope;
	private readonly config: DreamingConfig;
	private readonly model: ModelClient;
	private readonly trigger: DreamingTriggerSeam;
	private readonly stateUpdater: DreamingStateUpdater;
	private readonly logger?: DreamingWorkerLogger;
	private readonly clock: DreamingWorkerClock;
	private readonly pollIntervalMs: number;
	private readonly setTimer: (cb: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private handle: unknown;
	/** Guards against overlapping `runOnce` invocations on the poll loop. */
	private running = false;

	constructor(deps: DreamingWorkerDeps) {
		this.queue = deps.queue;
		this.storage = deps.storage;
		this.scope = deps.scope;
		this.config = deps.config;
		this.model = deps.model;
		this.trigger = deps.trigger;
		// The runner's b-AC-5 state write goes through the trigger's append-only recorder
		// (adapted onto the runner's `(agentId, passAt)` seam) unless a test injects an
		// explicit updater to record the write directly.
		this.stateUpdater = deps.stateUpdater ?? stateUpdaterFromTrigger(deps.trigger);
		this.logger = deps.logger;
		this.clock = deps.clock ?? { now: () => Date.now() };
		this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.setTimer = deps.setTimer ?? ((cb, ms) => setInterval(cb, ms));
		this.clearTimer =
			deps.clearTimer ??
			((handle) => {
				if (handle !== undefined) clearInterval(handle as ReturnType<typeof setInterval>);
			});
	}

	async runOnce(): Promise<boolean> {
		// Lease ONLY a dreaming job (the kind filter) — a foreign summary/skillify job is
		// left queued for its own worker, never grabbed-and-failed here.
		const leased = await this.queue.lease(LEASE_KINDS);
		if (leased === null) return false;

		// Parse the queued payload at the boundary. A malformed body is a corruption/wiring
		// bug worth surfacing — fail it with a clear reason rather than silently completing
		// a job we never ran (never a swallowed error).
		const job = parseDreamingJobPayload(leased.payload);
		if (job === null) {
			this.logger?.event("dreaming.worker.bad_payload", { id: leased.id });
			await this.queue.fail(leased.id, "malformed dreaming job payload");
			return true;
		}

		try {
			const strategy = await this.selectStrategy(job);
			const runner = createDreamingRunner({
				storage: this.storage,
				scope: this.scope,
				strategy,
				model: this.model,
				stateUpdater: this.stateUpdater,
				clock: { now: () => this.clock.now() },
			});
			await runner.runPass(job);
			await this.queue.complete(leased.id);
			this.logger?.event("dreaming.worker.completed", {
				id: leased.id,
				mode: strategy.mode,
				attempt: leased.attempt,
			});
		} catch (err: unknown) {
			// The runner is drop-invalid for a bad model body (it never throws on that), so a
			// throw reaching here is a genuine pass failure (storage/control-plane). Route it
			// to the queue's fail() (backoff + dead semantics) — no swallowed error.
			const reason = err instanceof Error ? err.message : String(err);
			this.logger?.event("dreaming.worker.failed", { id: leased.id, attempt: leased.attempt, reason });
			await this.queue.fail(leased.id, reason);
		}
		return true;
	}

	/**
	 * Select the payload strategy for a job by mode (D-4). Compaction when the payload
	 * mode is already `compaction`, OR the first-run backfill helper says to compact for
	 * this scope's `last_pass_at` (resolved from the trigger's recorder via the runner's
	 * own read — here we honor `backfillOnFirstRun` against the job's view of state).
	 * `maxInputTokens` is threaded from the resolved config. Otherwise incremental.
	 */
	private async selectStrategy(job: DreamingJobPayload): Promise<DreamingPayloadStrategy> {
		const compact = job.mode === "compaction" || (await this.shouldBackfillCompact(job));
		return compact
			? createCompactionStrategy(this.config.maxInputTokens)
			: createIncrementalStrategy({ maxInputTokens: this.config.maxInputTokens });
	}

	/**
	 * Whether the first-run backfill rule selects compaction for this job's scope
	 * (D-4 / c-AC-1): `config.backfillOnFirstRun` AND no prior pass (`last_pass_at` is
	 * empty). The scope's `last_pass_at` is resolved through the trigger's own
	 * flap-robust highest-version `readState` (the worker holds NO SQL of its own); a
	 * scope with no row reads `last_pass_at === ""` → first run, so the rule fires
	 * exactly when {@link shouldEnterCompaction} intends.
	 */
	private async shouldBackfillCompact(job: DreamingJobPayload): Promise<boolean> {
		if (!this.config.backfillOnFirstRun) return false;
		const state = await this.trigger.readState({ agentId: job.agentId });
		return shouldEnterCompaction(this.config, state.lastPassAt);
	}

	start(): void {
		this.handle = this.setTimer(() => {
			// Skip a tick if the previous lease+run is still in flight; never overlap.
			if (this.running) return;
			this.running = true;
			void this.runOnce().finally(() => {
				this.running = false;
			});
		}, this.pollIntervalMs);
	}

	stop(): void {
		if (this.handle !== undefined) {
			this.clearTimer(this.handle);
			this.handle = undefined;
		}
	}
}

/**
 * Build a {@link DreamingJobWorker}. The Wave-1c daemon-assembly bee constructs AND
 * starts this ONLY when `config.enabled` (default OFF); a test constructs it and drives
 * `runOnce()`. Constructing it has NO side effects until `start()` / `runOnce()` runs.
 */
export function createDreamingWorker(deps: DreamingWorkerDeps): DreamingJobWorker {
	return new DreamingJobWorkerImpl(deps);
}
