/**
 * Daemon-resident SKILLIFY JOB WORKER — PRD-045f (f-AC-1..f-AC-4).
 *
 * The `mine()` + `writeSkill()` loop is BUILT and the `skillify` cue-job is already
 * ENQUEUED by capture — but no worker ever leases `["skillify"]`, so those jobs pile up
 * unprocessed. This module is that consumer: it leases `"skillify"` jobs off the
 * SAME durable `memory_jobs` queue, parses each cue back into a `MineScope`, calls
 * `mine()` (gate + lock), calls `writeSkill()` (KEEP/MERGE/SKIP → append-only row), and
 * advances the per-project watermark after every run — regardless of verdict (b-AC-2).
 *
 * ── Kind-filtered lease — NEVER touch a foreign job ──────────────────────────
 * Capture also enqueues `summary` / `pollinating` / pipeline jobs into the SAME
 * `memory_jobs` queue. A generic `lease()` would let this worker grab one of those,
 * fail to parse it, and walk a legit job toward `dead`. So this worker leases ONLY
 * `["skillify"]` (the additive `JobQueueService.lease(kinds)` filter, f-AC-1).
 *
 * ── Fail-soft model dependency (f-AC-4) ──────────────────────────────────────
 * The gate shells out to the host CLI — it is NOT an in-process model call. A gate
 * timeout, a bad exit code, or an unparseable verdict ALL reach this worker as
 * thrown errors that `runOnce`'s catch routes to `queue.fail` (backoff + dead) — the
 * daemon is NEVER crashed and the capture path is NEVER blocked (f-AC-4 / FR-10).
 *
 * ── Payload tolerance ────────────────────────────────────────────────────────
 * The queued payload is `{ sessionId, path, count }` (from `turn-counters.ts`'s
 * `MemoryCue`). Parsing is defensive: a missing/empty `sessionId` or `path` means the
 * payload is unusable — `queue.fail` it rather than silently `complete` a job we could
 * not run. `count` is diagnostics only (the threshold-crossing value).
 *
 * ── The worker holds NO direct SQL ───────────────────────────────────────────
 * Every storage read/write goes through the injected `StorageQuery` (via the miner's
 * session fetcher and the skills store). This file builds no statement; `audit:sql`
 * scans `src/daemon`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { JobQueueService } from "../services/job-queue.js";
import {
	createFileWorkerLock,
	createHostCliGate,
	createSessionFetcher,
	mine,
	systemGateSpawner,
	type GateSpawner,
	type HostCliSpec,
	type SessionFetcher,
	type WorkerLock,
} from "./miner.js";
import type { GateCli } from "./contracts.js";
import {
	createFsInstallTarget,
	type FsInstallDirs,
} from "./install-target.js";
import {
	createSkillStore,
	writeSkill,
} from "./skills-write.js";
import type { SkillStore } from "./contracts.js";
import {
	createWatermarkStore,
	type WatermarkStore,
} from "./watermark.js";

/** The job kind capture enqueues; this worker leases ONLY this — NEVER a foreign job. */
export const SKILLIFY_JOB_KIND = "skillify" as const;

/** The default poll interval for the continuous loop (mirrors the stage/summary workers). */
const DEFAULT_POLL_INTERVAL_MS = 1_000;

// ════════════════════════════════════════════════════════════════════════════
// Payload parsing — the queue boundary (drop-invalid, never throw past it).
// ════════════════════════════════════════════════════════════════════════════

/** The validated skillify-job payload (parsed from the queue boundary). */
export interface SkillifyJobPayload {
	/** The harness session id — the trigger exclusion key and provenance. */
	readonly sessionId: string;
	/** The `sessions` conversation grouping key. */
	readonly path: string;
	/** The counter value at the threshold crossing (diagnostics only). */
	readonly count: number;
}

/**
 * Validate a candidate skillify-job payload at the queue boundary. Returns the typed
 * {@link SkillifyJobPayload} or `null` when the body is unusable. Drop-invalid so a
 * malformed/legacy queue row is rejected without crashing the worker.
 */
export function parseSkillifyJobPayload(candidate: unknown): SkillifyJobPayload | null {
	if (candidate === null || typeof candidate !== "object") return null;
	const obj = candidate as Record<string, unknown>;
	const sessionId = typeof obj["sessionId"] === "string" ? obj["sessionId"] : "";
	const path = typeof obj["path"] === "string" ? obj["path"] : "";
	// A payload with no sessionId and no path cannot be run — fail it.
	if (sessionId === "" && path === "") return null;
	const count = typeof obj["count"] === "number" ? obj["count"] : 0;
	return { sessionId, path, count };
}

// ════════════════════════════════════════════════════════════════════════════
// SkillifyJobWorker interface — the start/stop shape the assembler uses.
// ════════════════════════════════════════════════════════════════════════════

/**
 * The skillify job worker. Construct via {@link createSkillifyJobWorker}. Exposes
 * `runOnce()` (lease + run a single skillify job, the deterministic unit a test drives)
 * and `start()` / `stop()` (the continuous poll loop the daemon-assembly uses). Mirrors
 * the PRD-006 `StageWorker` + `PollinatingJobWorker` shape (f-AC-1).
 */
export interface SkillifyJobWorker {
	/**
	 * Lease the next `skillify` job, run its mine+write, and complete/fail it. Returns
	 * `true` when a job was processed (completed OR failed), `false` when nothing was
	 * leasable. The single deterministic step a test asserts against.
	 */
	runOnce(): Promise<boolean>;
	/** Start the continuous poll loop (lease → run on an interval). */
	start(): void;
	/** Stop the poll loop. Idempotent. */
	stop(): void;
}

// ════════════════════════════════════════════════════════════════════════════
// Construction deps + factory.
// ════════════════════════════════════════════════════════════════════════════

/** A minimal structured-log sink (mirrors the pollinating/summary worker loggers). */
export interface SkillifyWorkerLogger {
	/** Record a structured event (e.g. `skillify.worker.completed`, `skillify.worker.failed`). */
	event(name: string, fields?: Record<string, unknown>): void;
}

/**
 * Construction deps for {@link createSkillifyJobWorker}. All IO-touching seams are
 * injected so the daemon-assembly passes the real impls and a test injects fakes without
 * touching the real filesystem or a live queue.
 */
export interface SkillifyWorkerDeps {
	/** The durable queue this worker leases `["skillify"]` from + completes/fails through. */
	readonly queue: JobQueueService;
	/** The storage client the session fetcher + skills store dispatch through. */
	readonly storage: StorageQuery;
	/** The resolved `{ org, workspace }` partition the mine runs under. */
	readonly scope: QueryScope;
	/**
	 * The gate-CLI spec (the host agent binary + args that the spawner shells out to).
	 * In production: `{ command: "claude", args: ["--print"] }` (or the resolved host CLI).
	 * Injected so the assembler can pass the host CLI and a test can pass a fake spawner.
	 */
	readonly gateSpec: HostCliSpec;
	/**
	 * The gate spawner seam (real `node:child_process.spawn`; a test injects a fake).
	 * Defaults to `systemGateSpawner` when absent.
	 */
	readonly gateSpawner?: GateSpawner;
	/**
	 * The per-project worker lock seam (default: the filesystem O_EXCL lock). Injected
	 * so a test uses an in-memory lock without a real home dir.
	 */
	readonly lock?: WorkerLock;
	/**
	 * The per-project watermark store (default: the filesystem watermark under
	 * `~/.honeycomb/state/skillify`). Injected so a test uses a temp dir.
	 */
	readonly watermark?: WatermarkStore;
	/**
	 * The SKILL.md install-target dirs (default: `{ projectDir: process.cwd(),
	 * globalDir: os.homedir() }`). Injected so a test uses temp dirs.
	 */
	readonly installDirs?: FsInstallDirs;
	/**
	 * The author/agent id stamped on skills this worker mines. Defaults to the
	 * `scope.org` when absent (the tenant identifier, matching the summary worker's
	 * precedent for daemon-authored rows).
	 */
	readonly author?: string;
	/** Optional structured-log sink. */
	readonly logger?: SkillifyWorkerLogger;
	/** Poll interval in ms when running the continuous loop. Default 1000. */
	readonly pollIntervalMs?: number;
	/** Injected timer scheduler (real `setInterval` otherwise) — for tests. */
	readonly setTimer?: (cb: () => void, ms: number) => unknown;
	/** Injected timer canceller (real `clearInterval` otherwise) — for tests. */
	readonly clearTimer?: (handle: unknown) => void;
	/**
	 * TEST SEAM (default: the real `createHostCliGate` over `gateSpec`/`gateSpawner`). A test
	 * injects a deterministic {@link GateCli} (e.g. `createFakeGateCli(KEEP)`) so the gate
	 * verdict is fixed WITHOUT a live host CLI. Production leaves it absent → the real gate.
	 */
	readonly gateOverride?: GateCli;
	/**
	 * TEST SEAM (default: the real `createSessionFetcher` over `storage`/`scope`). A test injects
	 * a {@link SessionFetcher} returning canned rows so the mine has pairs to gate WITHOUT a live
	 * `sessions` read. Production leaves it absent → the real scoped fetcher.
	 */
	readonly fetcherOverride?: SessionFetcher;
	/**
	 * TEST SEAM (default: the real append-only `createSkillStore` over `storage`/`scope`). A test
	 * injects an in-memory {@link SkillStore} so the append-only write is asserted WITHOUT a live
	 * `skills` table. Production leaves it absent → the real store.
	 */
	readonly storeOverride?: SkillStore;
}

/** The single kind this worker leases — NEVER a foreign job (f-AC-1). */
const LEASE_KINDS: readonly string[] = [SKILLIFY_JOB_KIND];

/** The default host-CLI gate spec for the daemon-assembly (Claude Code). */
export function defaultGateSpec(): HostCliSpec {
	// The host CLI is `claude` (Claude Code). `--print` makes it non-interactive so it
	// runs the prompt and exits, printing the response to stdout. The gate model's auth
	// rides in the CLI's own credential store — NO API key is held by the daemon.
	return { command: "claude", args: ["--print"] };
}

/** Default lock base dir (mirrors miner.ts `defaultLockBaseDir`). */
function defaultLockBaseDir(): string {
	return join(homedir(), ".honeycomb", "state", "skillify");
}

/** The concrete skillify job worker implementation. */
class SkillifyJobWorkerImpl implements SkillifyJobWorker {
	private readonly queue: JobQueueService;
	private readonly storage: StorageQuery;
	private readonly scope: QueryScope;
	private readonly gateSpec: HostCliSpec;
	private readonly gateSpawner: GateSpawner;
	private readonly lock: WorkerLock;
	private readonly watermarkStore: WatermarkStore;
	private readonly installDirs: FsInstallDirs;
	private readonly author: string;
	private readonly logger?: SkillifyWorkerLogger;
	private readonly pollIntervalMs: number;
	private readonly setTimer: (cb: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private readonly gateOverride?: GateCli;
	private readonly fetcherOverride?: SessionFetcher;
	private readonly storeOverride?: SkillStore;
	private handle: unknown;
	/** Guards against overlapping `runOnce` invocations on the poll loop. */
	private running = false;

	constructor(deps: SkillifyWorkerDeps) {
		this.queue = deps.queue;
		this.storage = deps.storage;
		this.scope = deps.scope;
		this.gateSpec = deps.gateSpec;
		this.gateSpawner = deps.gateSpawner ?? systemGateSpawner;
		this.lock = deps.lock ?? createFileWorkerLock(defaultLockBaseDir());
		this.watermarkStore = deps.watermark ?? createWatermarkStore();
		this.installDirs = deps.installDirs ?? {};
		// The author defaults to `scope.org` (the tenant identifier). When the scope is
		// `"local"` (no-creds dev mode) we still produce a stable, non-empty author token.
		this.author = deps.author ?? (deps.scope.org !== "" ? deps.scope.org : "local");
		this.logger = deps.logger;
		this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.setTimer = deps.setTimer ?? ((cb, ms) => setInterval(cb, ms));
		this.clearTimer =
			deps.clearTimer ??
			((handle) => {
				if (handle !== undefined) clearInterval(handle as ReturnType<typeof setInterval>);
			});
		this.gateOverride = deps.gateOverride;
		this.fetcherOverride = deps.fetcherOverride;
		this.storeOverride = deps.storeOverride;
	}

	async runOnce(): Promise<boolean> {
		// Lease ONLY a skillify job (the kind filter) — a foreign summary/pollinating/pipeline
		// job is left queued for its own worker, never grabbed-and-failed here (f-AC-1). A
		// THROW from lease() itself (no job to fail-route) must NOT reject runOnce() and become
		// an unhandled rejection in the timer loop — degrade it to "nothing leased" (false).
		let leased: Awaited<ReturnType<JobQueueService["lease"]>>;
		try {
			leased = await this.queue.lease(LEASE_KINDS);
		} catch (err: unknown) {
			const reason = err instanceof Error ? err.message : String(err);
			this.logger?.event("skillify.worker.lease_failed", { reason });
			return false;
		}
		if (leased === null) return false;
		// After this point a throw routes to `queue.fail(leased.id, ...)` (we hold the job).
		const job = leased;

		try {
			// Parse the queued payload at the boundary. A malformed body is a corruption/wiring
			// bug worth surfacing — fail it with a clear reason rather than silently completing
			// a job we never ran (never a swallowed error, f-AC-4).
			const payload = parseSkillifyJobPayload(job.payload);
			if (payload === null) {
				this.logger?.event("skillify.worker.bad_payload", { id: job.id });
				await this.queue.fail(job.id, "malformed skillify job payload");
				return true;
			}

			// Resolve the current watermark for the triggering project. The projectKey is the
			// `path` (the conversation grouping key — the per-project dimension we mine). The
			// watermark read touches the filesystem; it is INSIDE the try so a read throw is
			// fail-routed to `queue.fail`, never an unhandled rejection (the f-AC-4 floor).
			const projectKey = payload.path !== "" ? payload.path : payload.sessionId;
			const watermark = this.watermarkStore.read(projectKey);

			// The fetcher / gate / store default to the real seams over `storage`/`scope`/`gateSpec`;
			// a test injects deterministic overrides (canned rows, a fixed KEEP verdict, an in-memory
			// store) so the lease→mine→write wiring is proven without a live `sessions`/`skills` read
			// or a live host CLI. Production passes none → the real constructions.
			const fetcher = this.fetcherOverride ?? createSessionFetcher(this.storage, this.scope);
			const gate = this.gateOverride ?? createHostCliGate(this.gateSpec, this.gateSpawner);
			const store = this.storeOverride ?? createSkillStore(this.storage, this.scope);
			const install = createFsInstallTarget(this.installDirs);

			// Run the mine: lock → fetch → extract → gate (lock released in finally by mine()).
			const result = await mine(
				{ projectKey, triggerSessionId: payload.sessionId },
				{ fetcher, gate, lock: this.lock, watermark },
			);

			if (!result.ran) {
				// Lock held (concurrent run) or no pairs to gate — complete the job as a no-op;
				// this is NOT a failure, just "nothing to do right now."
				this.logger?.event("skillify.worker.skipped", {
					id: job.id,
					reason: result.reason,
					attempt: job.attempt,
				});
				await this.queue.complete(job.id);
				return true;
			}

			// A run produced a verdict — act on it (KEEP/MERGE/SKIP → append-only row).
			const outcome = await writeSkill(
				result.outcome.verdict,
				{ store, install, author: this.author },
				result.outcome.minedSessionIds,
				"global", // All daemon-mined skills install globally (the user's ~/.claude).
			);

			// Advance the watermark after EVERY run — SKIP included (b-AC-2 / FR-9).
			const sessionDates = result.outcome.pairs.map((p) => p.sessionDate);
			this.watermarkStore.advance(projectKey, sessionDates);

			await this.queue.complete(job.id);
			this.logger?.event("skillify.worker.completed", {
				id: job.id,
				decision: outcome.decision,
				version: outcome.version,
				skillId: outcome.skillId,
				attempt: job.attempt,
			});
		} catch (err: unknown) {
			// A gate timeout, bad exit code, storage failure, a payload/watermark read throw, or
			// any other throw routes here. The daemon is NOT crashed and capture is NOT blocked,
			// and runOnce() resolves (never an unhandled rejection in the timer loop) — f-AC-4.
			const reason = err instanceof Error ? err.message : String(err);
			this.logger?.event("skillify.worker.failed", {
				id: job.id,
				attempt: job.attempt,
				reason,
			});
			await this.queue.fail(job.id, reason);
		}
		return true;
	}

	start(): void {
		// Idempotent: a second start() while a timer is already live would overwrite `this.handle`
		// and leak the first interval (stop() only clears the latest handle). Guard like the
		// pollinating worker's start() so double-start is a no-op, not a timer leak.
		if (this.handle !== undefined) return;
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
 * Build the daemon-resident SKILLIFY job worker (f-AC-1 / f-AC-4). The worker leases
 * ONLY `["skillify"]` off the durable `memory_jobs` queue, parses each cue into a
 * `MineScope`, calls `mine()` (gate + lock), calls `writeSkill()` (append-only row),
 * and advances the watermark. Construction has no side effects until `start()`.
 */
export function createSkillifyJobWorker(deps: SkillifyWorkerDeps): SkillifyJobWorker {
	return new SkillifyJobWorkerImpl(deps);
}
