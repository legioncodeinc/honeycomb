/**
 * Daemon-resident POLLINATING JOB WORKER — PRD-026 Wave 1 Track B (AC-W).
 *
 * The PRD-009 pollinating loop is REAL but had no live CONSUMER: the trigger
 * (`trigger.ts`) enqueues a `pollinating` job into `memory_jobs`, and the runner
 * (`runner.ts`) runs the full pass lifecycle — but nothing in the daemon LEASES a
 * `pollinating` job and invokes the runner. This worker is that consumer. It is the
 * pollinating analogue of the PRD-006 `pipeline/stage-worker.ts` (its template): the
 * same `runOnce()` / `start()` / `stop()` shape, the same overlap guard, the same
 * injected `setTimer`/`clearTimer` seam, the same try/catch that routes a throw to
 * `queue.fail` (never a swallowed error).
 *
 * ── Kind-filtered lease — NEVER touch a foreign job (the load-bearing invariant) ─
 * Capture also enqueues `summary` / `skillify` jobs into the SAME `memory_jobs`
 * queue. A generic `lease()` would let this worker grab one of those, fail to parse
 * it as a pollinating payload, and `fail()` it — walking a legit job toward `dead`. So
 * the worker leases ONLY `["pollinating"]` (the additive `JobQueueService.lease(kinds)`
 * kind filter, PRD-026). Anything that is not a pollinating job is left QUEUED for its
 * own worker; this worker never sees it.
 *
 * ── runOnce() lifecycle ──────────────────────────────────────────────────────
 *   1. `queue.lease([POLLINATING_JOB_KIND])` → `null` ⇒ nothing to do, return false.
 *   2. Parse the payload via `parsePollinatingJobPayload` (the queue boundary). A
 *      MALFORMED payload is a wiring/corruption bug worth surfacing — `queue.fail`
 *      it with a clear reason and return true; NEVER silently `complete` it.
 *   3. Select the strategy by mode (D-4): `compaction` when the payload mode is
 *      `compaction` OR the first-run backfill helper (`shouldEnterCompaction`) says
 *      so for this scope's `last_pass_at`; else `incremental`. `maxInputTokens` is
 *      threaded from the resolved pollinating config into the strategy.
 *   4. Construct the runner with the injected `ModelClient`, the resolved
 *      `{ org, workspace }` scope, the selected strategy, and the state-updater, then
 *      `await runner.runPass(job)`. The runner owns the model call + the 008c
 *      `submitProposal` apply + the state update (`recordPassComplete`); the worker
 *      only constructs it.
 *   5. On success `queue.complete(id)`; on throw `queue.fail(id, message)` (mirrors
 *      the stage-worker's structured try/catch — the events are `pollinating.worker.*`).
 *
 * ── The worker holds NO provider / SQL knowledge ─────────────────────────────
 * The model is injected as a 006 `ModelClient` (the Wave-1c bee passes the real
 * RouterModelClient; tests inject `createFakeModelClient`). Every write goes through
 * the runner's `submitProposal` + the trigger's append-only state path — the worker
 * issues NO direct SQL. `audit:sql` scans `src/daemon`; this file builds no statement.
 *
 * ── ENABLEMENT IS THE ASSEMBLER'S CALL, NOT THIS FACTORY'S ────────────────────
 * `createPollinatingWorker` does NOT decide whether pollinating is on. It builds a worker
 * unconditionally. The Wave-1c daemon-assembly bee constructs AND starts it ONLY when
 * `config.enabled` is true (default OFF — pollinating is a premium tier), and stops it in
 * teardown. Constructing the worker has no side effects until `start()` / `runOnce()`
 * is called, so a disabled daemon simply never builds it.
 */

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { ModelClient } from "../pipeline/model-client.js";
import { createCompactionStrategy, shouldEnterCompaction } from "./compaction.js";
import type { PollinatingConfig } from "./config.js";
import { POLLINATING_JOB_KIND, parsePollinatingJobPayload, type PollinatingJobPayload } from "./contracts.js";
import { createIncrementalStrategy } from "./incremental.js";
import { createPollinatingRunner, type PollinatingPayloadStrategy, type PollinatingStateUpdater } from "./runner.js";
import type { PollinatingScope, PollinatingState } from "./trigger.js";
import type { JobQueueService, LeasedJob } from "../services/job-queue.js";
import type { LeaseParticipant } from "../services/lease-coordinator.js";
import type { PollBackoffConfig } from "../services/poll-backoff.js";
import { buildWorkerPollLoop, type PollLoop } from "../services/poll-loop.js";

/**
 * The narrow trigger seam the worker drives — exactly the two
 * {@link PollinatingTrigger} methods it needs (PRD-026), nothing more. `readState`
 * resolves the scope's current counter (its highest-version `pollinating_state` row,
 * poll-convergent) so the worker can apply the first-run backfill rule WITHOUT
 * re-implementing that read; `recordPassComplete` is the additive append-only seam
 * the runner's state-updater is built from. Keeping it a two-method interface lets the
 * production path inject the REAL trigger and a test inject a recording fake, without
 * the worker holding any counter-write or SQL knowledge — the trigger owns both.
 */
export interface PollinatingTriggerSeam {
	/** Resolve a scope's current counter state (highest-version, poll-convergent). */
	readState(scope: PollinatingScope): Promise<PollinatingState>;
	/** Stamp `last_pass_at` + clear `pending_job_id` for a scope (append-only). */
	recordPassComplete(scope: PollinatingScope, passAt: string): Promise<void>;
}

/** A minimal structured-log sink (mirrors {@link StageWorkerLogger}). */
export interface PollinatingWorkerLogger {
	/** Record a structured event (e.g. `pollinating.worker.completed`, `pollinating.worker.failed`). */
	event(name: string, fields?: Record<string, unknown>): void;
}

/** The injected clock, so a test stamps `last_pass_at` resolution deterministically. */
export interface PollinatingWorkerClock {
	/** Current wall-clock time in ms (defaults to `Date.now`). */
	readonly now: () => number;
}

/**
 * Construction deps for {@link createPollinatingWorker}. The Wave-1c daemon-assembly bee
 * passes these verbatim (gated on `config.enabled`); a test injects fakes.
 */
export interface PollinatingWorkerDeps {
	/** The durable queue this worker leases `["pollinating"]` from + completes/fails through. */
	readonly queue: JobQueueService;
	/** The storage client the runner threads into `submitProposal` (never a raw fetch). */
	readonly storage: StorageQuery;
	/** The resolved `{ org, workspace }` partition the pass runs under (D-1 outer ring). */
	readonly scope: QueryScope;
	/** The resolved `memory.pollinating` config — supplies `maxInputTokens` + the backfill flag. */
	readonly config: PollinatingConfig;
	/** The LLM seam; the runner calls the `memory_pollinating` workload (D-5 / b-AC-6). */
	readonly model: ModelClient;
	/**
	 * The trigger seam the worker drives — the REAL {@link PollinatingTrigger} in prod
	 * (its `readState` + additive `recordPassComplete`), a fake in tests. The runner's
	 * state-updater is built from its `recordPassComplete`, and the first-run backfill
	 * rule reads `last_pass_at` via its `readState`. Required.
	 */
	readonly trigger: PollinatingTriggerSeam;
	/**
	 * An OPTIONAL explicit {@link PollinatingStateUpdater} override (the runner's seam,
	 * keyed by `agentId`). When supplied it replaces the adapter the worker builds from
	 * `trigger.recordPassComplete` — used by a test that wants to record the state write
	 * directly. Production leaves it unset.
	 */
	readonly stateUpdater?: PollinatingStateUpdater;
	/** Optional structured-log sink. */
	readonly logger?: PollinatingWorkerLogger;
	/** Optional injected clock (real `Date.now` otherwise). */
	readonly clock?: PollinatingWorkerClock;
	/** Poll interval in ms when running the continuous loop. Default 1000. */
	readonly pollIntervalMs?: number;
	/**
	 * PRD-062b adaptive poll backoff (L-B1 / AC-2 / AC-3 / AC-9). When supplied with
	 * `enabled: true`, the continuous loop self-reschedules with exponential backoff
	 * (idle → ~30s ceiling, reset-to-floor on any leased job) instead of a flat
	 * `pollIntervalMs` interval. DEFAULTS to a DISABLED config (the schema's
	 * false-safe default), so an un-passed `backoff` reproduces the exact pre-PRD flat
	 * cadence — the AC-9 parity contract. The daemon-assembly resolves the real
	 * (default-ON) config from the env and passes it here.
	 */
	readonly backoff?: PollBackoffConfig;
	/** Injected timer scheduler (real `setInterval` otherwise) — for tests. */
	readonly setTimer?: (cb: () => void, ms: number) => unknown;
	/** Injected timer canceller (real `clearInterval` otherwise) — for tests. */
	readonly clearTimer?: (handle: unknown) => void;
}

/**
 * The pollinating job worker. Construct via {@link createPollinatingWorker}. Exposes
 * `runOnce()` (lease + run a single pollinating job, the deterministic unit a test
 * drives) and `start()` / `stop()` (the continuous poll loop the daemon-assembly
 * uses). The single SHAPE is the PRD-006 `StageWorker`.
 */
export interface PollinatingJobWorker extends LeaseParticipant {
	/**
	 * Lease the next `pollinating` job, run its pass, and complete/fail it. Returns
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
const LEASE_KINDS: readonly string[] = [POLLINATING_JOB_KIND];

/**
 * Adapt a {@link PollinatingTriggerSeam} (the trigger's `(scope, passAt)` recorder) onto a
 * {@link PollinatingStateUpdater} (the runner's `(agentId, passAt)` seam). The runner calls
 * `recordPassComplete(agentId, passAt)`; we lift the `agentId` back into a
 * {@link PollinatingScope} so the trigger's append-only counter write owns the mechanic.
 */
function stateUpdaterFromTrigger(trigger: PollinatingTriggerSeam): PollinatingStateUpdater {
	return {
		recordPassComplete(agentId: string, passAt: string): Promise<void> {
			return trigger.recordPassComplete({ agentId }, passAt);
		},
	};
}

/** The concrete worker. */
class PollinatingJobWorkerImpl implements PollinatingJobWorker {
	/** Public for the lease coordinator's union — the single `pollinating` kind. */
	readonly leaseKinds: readonly string[] = LEASE_KINDS;
	private readonly queue: JobQueueService;
	private readonly storage: StorageQuery;
	private readonly scope: QueryScope;
	private readonly config: PollinatingConfig;
	private readonly model: ModelClient;
	private readonly trigger: PollinatingTriggerSeam;
	private readonly stateUpdater: PollinatingStateUpdater;
	private readonly logger?: PollinatingWorkerLogger;
	private readonly clock: PollinatingWorkerClock;
	private readonly loop: PollLoop;

	constructor(deps: PollinatingWorkerDeps) {
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
		// PRD-062b: `buildWorkerPollLoop` is the shared cadence wiring (see the stage
		// worker) — flat interval when backoff is off (AC-9), adaptive otherwise.
		this.loop = buildWorkerPollLoop({
			tick: () => this.runOnce(),
			flatIntervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
			backoff: deps.backoff,
			setTimer: deps.setTimer,
			clearTimer: deps.clearTimer,
		});
	}

	async runOnce(): Promise<boolean> {
		// Lease ONLY a pollinating job (the kind filter) — a foreign summary/skillify job is
		// left queued for its own worker, never grabbed-and-failed here.
		const leased = await this.queue.lease(this.leaseKinds);
		if (leased === null) return false;
		await this.processLeased(leased);
		return true;
	}

	/**
	 * PRD-062b (AC-4): process ONE already-leased `pollinating` job — parse it, select
	 * the strategy, run the pass, and complete/fail it. Split out of {@link runOnce} so
	 * the single combined lease coordinator can dispatch a job IT leased (over the
	 * union of kinds) to this participant without a second lease. The standalone
	 * `runOnce` leases then calls this; both share the identical parse+run+complete/fail
	 * body, so kind isolation and the no-swallowed-error contract hold whether
	 * consolidation is on or off.
	 */
	async processLeased(leased: LeasedJob): Promise<void> {
		// Parse the queued payload at the boundary. A malformed body is a corruption/wiring
		// bug worth surfacing — fail it with a clear reason rather than silently completing
		// a job we never ran (never a swallowed error).
		const job = parsePollinatingJobPayload(leased.payload);
		if (job === null) {
			this.logger?.event("pollinating.worker.bad_payload", { id: leased.id });
			await this.queue.fail(leased.id, "malformed pollinating job payload");
			return;
		}

		try {
			const strategy = await this.selectStrategy(job);
			const runner = createPollinatingRunner({
				storage: this.storage,
				scope: this.scope,
				strategy,
				model: this.model,
				stateUpdater: this.stateUpdater,
				clock: { now: () => this.clock.now() },
			});
			await runner.runPass(job);
			await this.queue.complete(leased.id);
			this.logger?.event("pollinating.worker.completed", {
				id: leased.id,
				mode: strategy.mode,
				attempt: leased.attempt,
			});
		} catch (err: unknown) {
			// The runner is drop-invalid for a bad model body (it never throws on that), so a
			// throw reaching here is a genuine pass failure (storage/control-plane). Route it
			// to the queue's fail() (backoff + dead semantics) — no swallowed error.
			const reason = err instanceof Error ? err.message : String(err);
			this.logger?.event("pollinating.worker.failed", { id: leased.id, attempt: leased.attempt, reason });
			await this.queue.fail(leased.id, reason);
		}
	}

	/**
	 * Select the payload strategy for a job by mode (D-4). Compaction when the payload
	 * mode is already `compaction`, OR the first-run backfill helper says to compact for
	 * this scope's `last_pass_at` (resolved from the trigger's recorder via the runner's
	 * own read — here we honor `backfillOnFirstRun` against the job's view of state).
	 * `maxInputTokens` is threaded from the resolved config. Otherwise incremental.
	 */
	private async selectStrategy(job: PollinatingJobPayload): Promise<PollinatingPayloadStrategy> {
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
	private async shouldBackfillCompact(job: PollinatingJobPayload): Promise<boolean> {
		if (!this.config.backfillOnFirstRun) return false;
		const state = await this.trigger.readState({ agentId: job.agentId });
		return shouldEnterCompaction(this.config, state.lastPassAt);
	}

	start(): void {
		this.loop.start();
	}

	stop(): void {
		this.loop.stop();
	}
}

/**
 * Build a {@link PollinatingJobWorker}. The Wave-1c daemon-assembly bee constructs AND
 * starts this ONLY when `config.enabled` (default OFF); a test constructs it and drives
 * `runOnce()`. Constructing it has NO side effects until `start()` / `runOnce()` runs.
 */
export function createPollinatingWorker(deps: PollinatingWorkerDeps): PollinatingJobWorker {
	return new PollinatingJobWorkerImpl(deps);
}
