/**
 * Stage-worker harness — PRD-006 Wave 1 (the lease → route → run → complete/fail loop).
 *
 * The pipeline runs as `memory_jobs` (PRD-004b). This harness is the bridge from
 * the durable queue to a stage handler: it LEASES a typed job, routes it by its
 * `kind` discriminator to the registered handler, runs the handler, and COMPLETEs
 * or FAILs the job through the queue's existing lifecycle. It builds ON the queue
 * (it does NOT re-implement lease/complete/fail/dead/backoff/reaper) — a-AC-6's
 * reaper behaviour is the queue's, and this harness simply consumes it: a handler
 * that throws → `fail()` (the queue applies backoff and, at max attempts, walks the
 * job to `dead`); a worker that CRASHES mid-handler never calls `complete`/`fail`,
 * so the lease goes stale and the queue's reaper reclaims the job for retry
 * (a-AC-6 / FR-1 / FR-2).
 *
 * ── Job-type routing (how a stage is registered) ────────────────────────────
 * The harness holds a `Record<PipelineJobKind, StageHandler>`. A job's `kind`
 * (the `memory_jobs.type` column) selects the handler. Wave 1 registers the
 * extraction handler (filled) and the four Wave-2 stubs (no-op) — see
 * {@link PIPELINE_JOB_KINDS} and {@link createStageWorker}. A Wave-2 Bee fills its
 * stub module's handler; the routing here does not change.
 *
 * ── The construction seam (mirrors the 004 DI seam) ─────────────────────────
 * The harness takes the queue + the handler map + an optional logger/clock. It is
 * CONSTRUCTED-AND-TESTED, not auto-started by the bootstrap (consistent with how
 * PRD-004/005 defer real-service assembly to the CLI / PRD-020): a test (or the
 * eventual daemon-assembly module) builds it with a real/fake queue and the real
 * handlers, then drives `runOnce()` / `start()`.
 *
 * ── A handler's contract ────────────────────────────────────────────────────
 * A {@link StageHandler} receives the {@link StageJob} (id + kind + the typed
 * payload carrying org/workspace/agent scope + the stage's input) and returns when
 * done. It THROWS to fail the job (the harness routes the throw to `queue.fail`
 * with the error message — never a swallowed catch). It does NOT touch the queue
 * itself; completion/failure is the harness's job, so a handler stays a pure
 * "do the stage's work" function.
 */

import type { LeaseParticipant } from "../services/lease-coordinator.js";
import type { PollBackoffConfig } from "../services/poll-backoff.js";
import { buildWorkerPollLoop, type PollLoop } from "../services/poll-loop.js";
import type { JobQueueService, LeasedJob } from "../services/job-queue.js";

/** The five pipeline job kinds — the `memory_jobs.type` discriminator (one per stage). */
export const PIPELINE_JOB_KINDS = Object.freeze([
	"memory_extraction",
	"memory_decision",
	"memory_controlled_write",
	"memory_graph_persist",
	"memory_retention",
] as const);

/** A pipeline job kind (routes a leased job to its stage handler). */
export type PipelineJobKind = (typeof PIPELINE_JOB_KINDS)[number];

/** Is `kind` one of the pipeline job kinds? (Narrows the queue's `string` kind.) */
export function isPipelineJobKind(kind: string): kind is PipelineJobKind {
	return (PIPELINE_JOB_KINDS as readonly string[]).includes(kind);
}

/**
 * The tenancy + scope envelope EVERY pipeline job payload carries (006a FR-10).
 * Threaded from capture through every stage so extracted/decided/written structure
 * stays within tenancy and scope. A stage reads these off its payload and passes
 * them to its storage writes.
 */
export interface PipelineJobScope {
	/** The org the captured memory belongs to. */
	readonly org: string;
	/** The workspace/partition within the org. */
	readonly workspace: string;
	/** The agent the memory is scoped to (default `'default'`). */
	readonly agentId: string;
	/**
	 * PRD-049b (49b-AC-1): the RESOLVED `project_id` the captured turn ran in, threaded from
	 * capture through every pipeline stage so a distilled fact written by the autonomous pipeline
	 * carries the SAME project segment a recall in that folder narrows to. ABSENT/blank → the
	 * `__unsorted__` inbox at the write (controlled-writes default), never mis-attributed.
	 */
	readonly projectId?: string;
}

/**
 * The leased job a stage handler runs, with its payload narrowed to a pipeline
 * job: the {@link PipelineJobScope} envelope + the opaque per-stage `payload` the
 * stage interprets. `kind` is the narrowed {@link PipelineJobKind}.
 */
export interface StageJob {
	/** The durable job id (for logging + completion). */
	readonly id: string;
	/** The narrowed pipeline kind that selected this handler. */
	readonly kind: PipelineJobKind;
	/** 1-based run number (the queue's attempt counter for this lease). */
	readonly attempt: number;
	/** The tenancy + scope envelope (006a FR-10). */
	readonly scope: PipelineJobScope;
	/** The stage-specific input payload (the stage interprets its own shape). */
	readonly payload: Record<string, unknown>;
}

/**
 * A stage handler: do the stage's work for one job. Returns on success; THROWS to
 * fail the job (the harness converts the throw to `queue.fail(id, message)`). A
 * handler never touches the queue — completion/failure is the harness's job.
 */
export type StageHandler = (job: StageJob) => Promise<void>;

/** The handler map: one {@link StageHandler} per {@link PipelineJobKind}. */
export type StageHandlers = Record<PipelineJobKind, StageHandler>;

/** A minimal structured-log sink (mirrors {@link JobQueueLogger}). */
export interface StageWorkerLogger {
	/** Record a structured event (e.g. `stage.completed`, `stage.failed`). */
	event(name: string, fields?: Record<string, unknown>): void;
}

/** Construction deps for {@link createStageWorker}. */
export interface StageWorkerDeps {
	/** The durable queue this worker leases from + completes/fails through. */
	readonly queue: JobQueueService;
	/** One handler per pipeline kind (extraction filled; b/c/d/e stubs in Wave 1). */
	readonly handlers: StageHandlers;
	/** Optional structured-log sink. */
	readonly logger?: StageWorkerLogger;
	/**
	 * The job kinds this worker leases. Defaults to {@link PIPELINE_JOB_KINDS} (the
	 * five pipeline kinds). The SAME `memory_jobs` queue also carries `summary` /
	 * `skillify` / `pollinating` jobs, so a bare `lease()` would grab one of THOSE,
	 * fail to run it as a pipeline job, and walk a legit foreign job toward `dead`.
	 * Passing the kind filter (the additive `JobQueueService.lease(kinds)`) makes the
	 * worker lease ONLY pipeline jobs and leave every foreign kind queued for its own
	 * worker — the load-bearing invariant the pollinating worker also relies on.
	 */
	readonly leaseKinds?: readonly string[];
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
 * The stage-worker harness. Construct via {@link createStageWorker}. Exposes
 * `runOnce()` (lease + run a single job, the deterministic unit a test drives) and
 * `start()`/`stop()` (the continuous poll loop the daemon-assembly uses).
 */
export interface StageWorker extends LeaseParticipant {
	/**
	 * Lease the next runnable job, route it, run it, and complete/fail it. Returns
	 * `true` when a job was processed (completed OR failed), `false` when nothing
	 * was leasable. The single deterministic step a test asserts against.
	 */
	runOnce(): Promise<boolean>;
	/** Start the continuous poll loop (lease → run on an interval). */
	start(): void;
	/** Stop the poll loop. Idempotent. */
	stop(): void;
}

/** Default poll interval for the continuous loop. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * Project a {@link LeasedJob} from the queue into a typed {@link StageJob}, reading
 * the {@link PipelineJobScope} envelope off the payload (defensively — a missing
 * field yields an empty string / `'default'` rather than throwing, so a malformed
 * payload still routes and the handler decides how to treat empty scope).
 */
function toStageJob(leased: LeasedJob, kind: PipelineJobKind): StageJob {
	const p = leased.payload ?? {};
	const scope: PipelineJobScope = {
		org: typeof p.org === "string" ? p.org : "",
		workspace: typeof p.workspace === "string" ? p.workspace : "",
		agentId: typeof p.agent_id === "string" ? p.agent_id : "default",
		// PRD-049b: carry the resolved project segment through the stage envelope (defensively "").
		...(typeof p.project_id === "string" ? { projectId: p.project_id } : {}),
	};
	return { id: leased.id, kind, attempt: leased.attempt, scope, payload: p };
}

/** The concrete harness. */
class PipelineStageWorker implements StageWorker {
	private readonly queue: JobQueueService;
	private readonly handlers: StageHandlers;
	private readonly logger?: StageWorkerLogger;
	/** Public for the lease coordinator's union (the kinds this participant owns). */
	readonly leaseKinds: readonly string[];
	private readonly loop: PollLoop;

	constructor(deps: StageWorkerDeps) {
		this.queue = deps.queue;
		this.handlers = deps.handlers;
		this.logger = deps.logger;
		this.leaseKinds = deps.leaseKinds ?? PIPELINE_JOB_KINDS;
		// PRD-062b: the loop owns the cadence (flat when backoff is off — the AC-9
		// pre-PRD path; adaptive self-reschedule when on). The overlap guard + the
		// injected timer seam are preserved inside the loop; `buildWorkerPollLoop`
		// applies the shared flat-interval / timer / disabled-backoff defaults so the
		// wiring is not copied between the two workers.
		this.loop = buildWorkerPollLoop({
			tick: () => this.runOnce(),
			flatIntervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
			backoff: deps.backoff,
			setTimer: deps.setTimer,
			clearTimer: deps.clearTimer,
		});
	}

	async runOnce(): Promise<boolean> {
		// Lease ONLY pipeline kinds (the kind filter) — a foreign summary/skillify/
		// pollinating job is left queued for its own worker, never grabbed-and-failed here.
		const leased = await this.queue.lease(this.leaseKinds);
		if (leased === null) return false;
		await this.processLeased(leased);
		return true;
	}

	/**
	 * PRD-062b (AC-4): process ONE already-leased pipeline job — route it by kind, run
	 * the handler, and complete/fail it. Split out of {@link runOnce} so the single
	 * combined lease coordinator can dispatch a job IT leased (over the union of kinds)
	 * to this participant without a second lease. The standalone `runOnce` leases then
	 * calls this; both paths share the identical route+run+complete/fail body, so kind
	 * isolation and the no-swallowed-error contract hold whether consolidation is on or off.
	 */
	async processLeased(leased: LeasedJob): Promise<void> {
		// A leased job whose kind is not a pipeline kind is not ours to run. Fail it
		// with a clear reason rather than silently completing it (a non-pipeline job
		// in the pipeline queue is a wiring bug worth surfacing) — never swallowed.
		if (!isPipelineJobKind(leased.kind)) {
			this.logger?.event("stage.unknown_kind", { id: leased.id, kind: leased.kind });
			await this.queue.fail(leased.id, `unknown pipeline job kind: ${leased.kind}`);
			return;
		}

		const job = toStageJob(leased, leased.kind);
		const handler = this.handlers[leased.kind];
		try {
			await handler(job);
			await this.queue.complete(job.id);
			this.logger?.event("stage.completed", { id: job.id, kind: job.kind, attempt: job.attempt });
		} catch (err: unknown) {
			// Drop-invalid-keep-partial is the HANDLER's policy for bad model output;
			// a throw that reaches here is a genuine stage failure. Route it to the
			// queue's fail() (backoff + dead semantics) — no swallowed error.
			const reason = err instanceof Error ? err.message : String(err);
			this.logger?.event("stage.failed", { id: job.id, kind: job.kind, attempt: job.attempt, reason });
			await this.queue.fail(job.id, reason);
		}
	}

	start(): void {
		this.loop.start();
	}

	stop(): void {
		this.loop.stop();
	}
}

/**
 * Build the stage-worker harness. The daemon-assembly (or a test) supplies the
 * queue + the handler map. Wave 1 wires the extraction handler + the four stubs
 * via {@link createPipelineHandlers}; pass the result as `handlers`.
 */
export function createStageWorker(deps: StageWorkerDeps): StageWorker {
	return new PipelineStageWorker(deps);
}
