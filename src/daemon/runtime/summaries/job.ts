/**
 * Daemon-resident SUMMARY JOB WORKER — PRD-046a (a-AC-1..5), the deferred-assembly
 * wiring PRD-017 left as a seam.
 *
 * PRD-017a built the per-session summary core (`runSummaryWorker` in `worker.ts`):
 * given a trigger + a session, it takes the per-session lock, fetches the session's
 * `sessions` events (retry-on-empty), runs the host-CLI gate, embeds (non-fatal), and
 * SELECT-before-INSERTs the summary row to `memory` at
 * `/summaries/<userName>/<sessionId>.md`. But NOTHING in the live daemon invoked it —
 * the `memory_jobs` job that runs `runSummaryWorker` on a trigger was an honest
 * deferred-assembly gap (CONVENTIONS §9). This module is that job: the live CONSUMER
 * that leases `summary` jobs off the durable queue and drives the (unchanged) worker.
 *
 * It is the pollinating/skillify analogue (`pollinating/worker.ts` is its template): the same
 * `runOnce()` / `start()` / `stop()` shape, the same kind-filtered lease, the same
 * try/catch routing a throw to `queue.fail` (never a swallowed error). It adds NO
 * summarization logic, NO write path, NO schema — it reuses `runSummaryWorker` and the
 * real seams (`createSessionEventFetcher`, `createSummaryStore`, `createHostSummaryGenCli`
 * + `systemSummarySpawner`, `createFileSessionLock`) verbatim.
 *
 * ── Kind-filtered lease — NEVER touch a foreign job ──────────────────────────
 * Capture also enqueues `skillify` jobs, and the pollinating worker enqueues `pollinating`
 * jobs, into the SAME `memory_jobs` queue. A generic `lease()` would let this worker
 * grab one of those, fail to run it, and walk a legit job toward `dead`. So this worker
 * leases ONLY `["summary"]` (the additive `JobQueueService.lease(kinds)` filter).
 *
 * ── The safety env rides on the gate subprocess (a-AC-4) ─────────────────────
 * The gate is built via `createHostSummaryGenCli(..., systemSummarySpawner, ...)`, whose
 * spawner layers `HONEYCOMB_WIKI_WORKER=1` + `HONEYCOMB_CAPTURE=false` + the
 * `HONEYCOMB_WORKER=1` recursion guard over the parent env (see `worker.ts`), so the
 * summary pass never re-enters the capture loop. The live-assembled path uses this exact
 * spawner — the env is proven on the assembled worker, not just the module constants.
 *
 * ── Per-session lock holds end-to-end (a-AC-3) ───────────────────────────────
 * `runSummaryWorker` takes the `O_EXCL` per-session lock and SUPPRESSES a second
 * concurrent run for the same session. This worker constructs the real
 * `createFileSessionLock()` once and shares it across `runOnce` calls, so two queued
 * `summary` jobs for one session yield at most one concurrent summary — the existing lock
 * holds through the live wiring; no second mechanism is added.
 *
 * ── The worker holds NO direct SQL ───────────────────────────────────────────
 * Every read/write goes through `runSummaryWorker`'s injected fetcher/store (over the
 * daemon's `StorageQuery`); this file builds no statement. `audit:sql` scans `src/daemon`.
 */

import { z } from "zod";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { EmbedClient } from "../services/embed-client.js";
import type { JobQueueService } from "../services/job-queue.js";
import {
	createFileSessionLock,
	createHostSummaryGenCli,
	createSessionEventFetcher,
	createSummaryStore,
	systemSummarySpawner,
	type SummaryCliSpec,
	type SummarySpawner,
} from "./worker.js";
import { runSummaryWorker, type SummaryWorkerDeps } from "./worker.js";
import {
	createSynthesisStore,
	refreshMemoryIndex,
	synthesizeThreadHeads,
	type SynthesisStore,
} from "./synthesis.js";
import { DEFAULT_WORKER_CONFIG, type SummarySession, type SummaryTrigger, type WorkerConfig } from "./contracts.js";

/** The job kind capture (periodic) + session-end (final) enqueue, routed to THIS worker. */
export const SUMMARY_JOB_KIND = "summary" as const;

// ════════════════════════════════════════════════════════════════════════════
// The queued summary-job payload — the boundary (zod). What the trigger enqueues.
// ════════════════════════════════════════════════════════════════════════════

/**
 * The payload of a queued `summary` job (the `memory_jobs` boundary). Capture's periodic
 * trigger and the session-end final trigger enqueue this; this worker parses it back via
 * {@link parseSummaryJobPayload}. Drop-invalid (never throw past the boundary).
 *
 *   - `sessionId` — the harness session id (the lock key + the write-path segment).
 *   - `path` — the `sessions` conversation grouping key the events are fetched by.
 *   - `userName` — the operator name the summary path is scoped under
 *     (`/summaries/<userName>/…`). Defaulted empty; the worker falls back to the daemon
 *     scope's `org` when absent so a legacy `{ sessionId, path, count }` cue still resolves
 *     a stable, tenant-scoped path (PRD-017 D-6).
 *   - `agentId` — the host agent that triggered the session (selects the gate-CLI
 *     invocation, FR-8). Defaulted to `default`.
 *   - `triggerKind` / `reason` / `count` — diagnostics: which trigger fired the run. The
 *     run itself is identical for both classes (the worker only records it).
 */
export const SummaryJobPayloadSchema = z.object({
	/** The harness session id — the per-session lock key + the write-path segment. */
	sessionId: z.string().default(""),
	/** The `sessions` conversation grouping key the events are fetched by. */
	path: z.string().default(""),
	/** The operator name the summary path is scoped under (defaulted; falls back to scope.org). */
	userName: z.string().default(""),
	/** The host agent that triggered the session (selects the gate CLI, FR-8). */
	agentId: z.string().default("default"),
	/** Which trigger class fired (diagnostics). */
	triggerKind: z.enum(["final", "periodic"]).default("periodic"),
	/** The periodic reason / the final event name (diagnostics). */
	reason: z.string().default(""),
	/** The counter value at the crossing (diagnostics). */
	count: z.number().default(0),
});

/** A validated summary-job payload (the queue boundary). */
export type SummaryJobPayload = z.infer<typeof SummaryJobPayloadSchema>;

/**
 * Validate a candidate summary-job payload at the queue boundary, returning the typed
 * {@link SummaryJobPayload} or `null` when the body is unusable (no `sessionId`/`path`).
 * Drop-invalid (never throw) so a malformed/legacy queue row is rejected without crashing
 * the worker. Tolerates extra keys.
 */
export function parseSummaryJobPayload(candidate: unknown): SummaryJobPayload | null {
	const parsed = SummaryJobPayloadSchema.safeParse(candidate);
	if (!parsed.success) return null;
	// A summary run is meaningless without a session + a conversation path — the lock key
	// and the event-fetch grouping key. Reject (drop) a payload missing either.
	if (parsed.data.sessionId === "" || parsed.data.path === "") return null;
	return parsed.data;
}

/**
 * Reconstruct the {@link SummaryTrigger} the worker records from the parsed payload
 * (diagnostics only — the run is identical for both classes). A `final` job carries the
 * terminating event name in `reason`; a `periodic` job carries the threshold reason. An
 * unrecognized value falls back to a stable default so the trigger is always well-formed.
 */
export function triggerFromPayload(payload: SummaryJobPayload): SummaryTrigger {
	if (payload.triggerKind === "final") {
		const event =
			payload.reason === "Stop" || payload.reason === "SessionEnd" || payload.reason === "session_shutdown"
				? payload.reason
				: "SessionEnd";
		return { kind: "final", event };
	}
	const reason = payload.reason === "hours" ? "hours" : "messages";
	return { kind: "periodic", reason, count: payload.count };
}

// ════════════════════════════════════════════════════════════════════════════
// The host-CLI invocation matrix (FR-8) — agentId → the gate-CLI spec.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Resolve the host-CLI {@link SummaryCliSpec} for an agent (FR-8). The summary is NOT
 * generated with an API key — the worker shells out to the host agent's OWN CLI (which
 * already holds the operator's auth + matches their model). The prompt is fed on stdin
 * (never an arg), so the args array only carries the non-interactive print flag the host
 * CLI expects. An unknown agent falls back to `claude` (the first-class dogfood harness).
 */
export function summaryCliSpecFor(agentId: string): SummaryCliSpec {
	switch (agentId) {
		case "codex":
			return { command: "codex", args: ["exec", "-"] };
		case "cursor":
		case "cursor-agent":
			return { command: "cursor-agent", args: ["-p"] };
		case "hermes":
			return { command: "hermes", args: ["-p"] };
		case "pi":
			return { command: "pi", args: ["-p"] };
		case "claude":
		case "claude-code":
		default:
			return { command: "claude", args: ["-p"] };
	}
}

// ════════════════════════════════════════════════════════════════════════════
// The worker — lease `["summary"]` → parse → runSummaryWorker → complete/fail.
// ════════════════════════════════════════════════════════════════════════════

/** A minimal structured-log sink (mirrors the pollinating worker's logger). */
export interface SummaryJobWorkerLogger {
	/** Record a structured event (e.g. `summary.worker.completed`, `summary.worker.failed`). */
	event(name: string, fields?: Record<string, unknown>): void;
}

/**
 * Construction deps for {@link createSummaryJobWorker}. The daemon-assembly step passes
 * these verbatim; a test injects fakes. Everything IO-touching is injected so the worker
 * holds no global state.
 */
export interface SummaryJobWorkerDeps {
	/** The durable queue this worker leases `["summary"]` from + completes/fails through. */
	readonly queue: JobQueueService;
	/** The daemon's `StorageQuery` the fetcher reads `sessions` + the store writes `memory` through. */
	readonly storage: StorageQuery;
	/** The resolved `{ org, workspace }` partition the run executes under (+ the userName fallback). */
	readonly scope: QueryScope;
	/** The 768-dim embed client (a-AC-5). A throw is non-fatal in the worker. */
	readonly embed: EmbedClient;
	/**
	 * The summary-gate spawner (a-AC-4). Defaults to {@link systemSummarySpawner}, whose
	 * subprocess env carries `HONEYCOMB_WIKI_WORKER=1` + `HONEYCOMB_CAPTURE=false` + the
	 * recursion guard. A test injects a recording spawner to assert the safety env WITHOUT a
	 * real CLI.
	 */
	readonly spawner?: SummarySpawner;
	/** The retry/backoff/gate-timeout tuning. Defaults to {@link DEFAULT_WORKER_CONFIG}. */
	readonly config?: WorkerConfig;
	/**
	 * The factory that builds the per-run {@link SummaryWorkerDeps} from a parsed session +
	 * gate spec. Defaults to the REAL builder over the injected storage/scope/embed/spawner.
	 * A unit test injects a fake builder (recording the deps + returning a fake worker run)
	 * to assert the job DISPATCHES to `runSummaryWorker` at the assembly seam (a-AC-1).
	 */
	readonly buildDeps?: SummaryWorkerDepsFactory;
	/**
	 * The summary-run function. Defaults to the REAL {@link runSummaryWorker}. A unit test
	 * injects a fake to assert the worker dispatches to it (a-AC-1) without a real gate.
	 */
	readonly run?: typeof runSummaryWorker;
	/**
	 * The factory that builds the daemon-side synthesis store for the `/MEMORY.md` REFRESH
	 * (PRD-046b b-AC-1). Defaults to the REAL {@link createSynthesisStore} over the injected
	 * storage + scope. After a summary LANDS, the worker re-reads the tenant's summaries and
	 * version-bumps `/MEMORY.md` (+ the thread heads) so the index REFRESHES as summaries
	 * land — the mounted, deferred-assembly companion to the summary worker. A unit test
	 * injects a recording store to assert the refresh ran (version-bump, no in-place UPDATE).
	 * When `null`, the refresh step is SKIPPED entirely (summaries still land; the index
	 * simply is not refreshed this run — used by the a-AC tests that don't exercise synthesis).
	 */
	readonly buildSynthesisStore?: SynthesisStoreFactory | null;
	/** Optional structured-log sink. */
	readonly logger?: SummaryJobWorkerLogger;
	/** Poll interval in ms for the continuous loop. Default 1000. */
	readonly pollIntervalMs?: number;
	/** Injected timer scheduler (real `setInterval` otherwise) — for tests. */
	readonly setTimer?: (cb: () => void, ms: number) => unknown;
	/** Injected timer canceller (real `clearInterval` otherwise) — for tests. */
	readonly clearTimer?: (handle: unknown) => void;
}

/** Builds the per-run {@link SummaryWorkerDeps} for a session (so a test can swap the IO seams). */
export type SummaryWorkerDepsFactory = (session: SummarySession, spec: SummaryCliSpec) => SummaryWorkerDeps;

/** Builds the daemon-side {@link SynthesisStore} for the `/MEMORY.md` refresh (PRD-046b b-AC-1). */
export type SynthesisStoreFactory = () => SynthesisStore;

/**
 * The summary job worker. Construct via {@link createSummaryJobWorker}. Exposes
 * `runOnce()` (lease + run a single summary job — the deterministic unit a test drives)
 * and `start()` / `stop()` (the continuous poll loop the daemon-assembly uses). The single
 * SHAPE is the PRD-026 pollinating worker.
 */
export interface SummaryJobWorker {
	/**
	 * Lease the next `summary` job, run the summary pass, and complete/fail it. Returns
	 * `true` when a job was processed (completed OR failed), `false` when nothing was
	 * leasable. The single deterministic step a test asserts against.
	 */
	runOnce(): Promise<boolean>;
	/** Start the continuous poll loop (lease → run on an interval). */
	start(): void;
	/** Stop the poll loop. Idempotent. */
	stop(): void;
}

/** Default poll interval for the continuous loop (matches the pollinating/stage worker). */
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** The single kind this worker leases — NEVER a foreign job. */
const LEASE_KINDS: readonly string[] = [SUMMARY_JOB_KIND];

/** The concrete worker. */
class SummaryJobWorkerImpl implements SummaryJobWorker {
	private readonly queue: JobQueueService;
	private readonly storage: StorageQuery;
	private readonly scope: QueryScope;
	private readonly embed: EmbedClient;
	private readonly spawner: SummarySpawner;
	private readonly config: WorkerConfig;
	private readonly buildDeps: SummaryWorkerDepsFactory;
	private readonly run: typeof runSummaryWorker;
	/** The synthesis-store factory for the `/MEMORY.md` refresh; `null` SKIPS the refresh (b-AC-1). */
	private readonly buildSynthesisStore: SynthesisStoreFactory | null;
	private readonly logger?: SummaryJobWorkerLogger;
	private readonly pollIntervalMs: number;
	private readonly setTimer: (cb: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	/** ONE shared per-session lock so the suppression holds across queued jobs (a-AC-3). */
	private readonly lock = createFileSessionLock();
	private handle: unknown;
	/** Guards against overlapping `runOnce` invocations on the poll loop. */
	private running = false;

	constructor(deps: SummaryJobWorkerDeps) {
		this.queue = deps.queue;
		this.storage = deps.storage;
		this.scope = deps.scope;
		this.embed = deps.embed;
		this.spawner = deps.spawner ?? systemSummarySpawner;
		this.config = deps.config ?? DEFAULT_WORKER_CONFIG;
		this.buildDeps = deps.buildDeps ?? ((session, spec) => this.defaultBuildDeps(session, spec));
		this.run = deps.run ?? runSummaryWorker;
		// PRD-046b b-AC-1: the synthesis store factory for the `/MEMORY.md` refresh. `undefined`
		// → the REAL store over this worker's storage + scope (the live mount). An explicit
		// `null` SKIPS the refresh (the a-AC suites that don't exercise synthesis).
		this.buildSynthesisStore =
			deps.buildSynthesisStore === undefined
				? (): SynthesisStore => createSynthesisStore(this.storage, this.scope)
				: deps.buildSynthesisStore;
		this.logger = deps.logger;
		this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.setTimer = deps.setTimer ?? ((cb, ms) => setInterval(cb, ms));
		this.clearTimer =
			deps.clearTimer ??
			((handle) => {
				if (handle !== undefined) clearInterval(handle as ReturnType<typeof setInterval>);
			});
	}

	/**
	 * Build the REAL {@link SummaryWorkerDeps} for a run (the production wiring). Reuses the
	 * unchanged 017a seams: the scoped `sessions` fetcher, the `memory` SELECT-before-INSERT
	 * store, the host-CLI gate (via {@link systemSummarySpawner}, which carries the safety
	 * env — a-AC-4), the non-fatal embed, and the SHARED per-session lock (a-AC-3).
	 */
	private defaultBuildDeps(_session: SummarySession, spec: SummaryCliSpec): SummaryWorkerDeps {
		return {
			lock: this.lock,
			fetcher: createSessionEventFetcher(this.storage, this.scope),
			gate: createHostSummaryGenCli(spec, this.spawner, this.config.gateTimeoutMs),
			embed: this.embed,
			store: createSummaryStore(this.storage, this.scope),
			config: this.config,
		};
	}

	/**
	 * Resolve the {@link SummarySession} from the parsed payload, applying the userName
	 * fallback. The cue carries `sessionId` + `path` always; `userName` defaults to the
	 * daemon scope's `org` (the tenant) when the payload omits it, so a legacy
	 * `{ sessionId, path, count }` cue still resolves a stable, tenant-scoped summary path.
	 */
	private sessionFromPayload(payload: SummaryJobPayload): SummarySession {
		const userName = payload.userName !== "" ? payload.userName : this.scope.org;
		return { sessionId: payload.sessionId, userName, path: payload.path, agentId: payload.agentId };
	}

	/**
	 * REFRESH the tenant's `/MEMORY.md` index + thread heads after a summary landed (PRD-046b
	 * b-AC-1). Builds the daemon-side synthesis store (over THIS worker's storage + scope, so
	 * the read is tenant-scoped — b-AC-6), version-bumps the index via {@link refreshMemoryIndex},
	 * and (idempotently, SELECT-before-INSERT) writes any new thread heads. NON-FATAL by
	 * construction: any error is swallowed (logged) so a refresh failure never fails the
	 * already-durable summary job. Returns whether the index refresh ran. A `null` factory
	 * SKIPS synthesis entirely (returns false).
	 */
	private async refreshIndexSafe(): Promise<boolean> {
		if (this.buildSynthesisStore === null) return false;
		try {
			const store = this.buildSynthesisStore();
			await refreshMemoryIndex({ store });
			await synthesizeThreadHeads({ store });
			return true;
		} catch (err: unknown) {
			const reason = err instanceof Error ? err.message : String(err);
			this.logger?.event("summary.index.refresh_failed", { reason });
			return false;
		}
	}

	async runOnce(): Promise<boolean> {
		// Lease ONLY a summary job (the kind filter) — a foreign skillify/pollinating job is left
		// queued for its own worker, never grabbed-and-failed here.
		const leased = await this.queue.lease(LEASE_KINDS);
		if (leased === null) return false;

		// Parse the queued payload at the boundary. A malformed/legacy-unusable body is a
		// wiring/corruption bug worth surfacing — fail it with a clear reason rather than
		// silently completing a job we never ran (never a swallowed error).
		const payload = parseSummaryJobPayload(leased.payload);
		if (payload === null) {
			this.logger?.event("summary.worker.bad_payload", { id: leased.id });
			await this.queue.fail(leased.id, "malformed summary job payload");
			return true;
		}

		try {
			const session = this.sessionFromPayload(payload);
			const spec = summaryCliSpecFor(payload.agentId);
			const trigger = triggerFromPayload(payload);
			const deps = this.buildDeps(session, spec);
			const result = await this.run(trigger, session, deps);

			// PRD-046b b-AC-1: a summary LANDED → REFRESH `/MEMORY.md` (version-bump) so the
			// index reflects the new corpus, plus the per-session thread head. This is the
			// mounted, deferred-assembly companion to 046a: synthesis runs on the SAME daemon
			// trigger the summary worker does, as new summaries land. Skipped when the summary
			// did NOT write a fresh row (a suppressed/no-events/gate-failed run leaves the
			// corpus unchanged) or when the synthesis store factory is null. NON-FATAL: a
			// refresh failure must not fail the (already-completed) summary job — the summary
			// is durable; the index simply is not refreshed this run.
			const refreshed = result.ran && result.wrote ? await this.refreshIndexSafe() : false;

			await this.queue.complete(leased.id);
			this.logger?.event("summary.worker.completed", {
				id: leased.id,
				ran: result.ran,
				...(result.ran ? { wrote: result.wrote, embedded: result.embedded } : { reason: result.reason }),
				indexRefreshed: refreshed,
				attempt: leased.attempt,
			});
		} catch (err: unknown) {
			// `runSummaryWorker` is drop-invalid for its own expected failures (it returns
			// `{ ran: false, reason }`, never throws on a gate/embed failure), so a throw
			// reaching here is a genuine failure (storage/control-plane). Route it to the
			// queue's fail() (backoff + dead semantics) — no swallowed error.
			const reason = err instanceof Error ? err.message : String(err);
			this.logger?.event("summary.worker.failed", { id: leased.id, attempt: leased.attempt, reason });
			await this.queue.fail(leased.id, reason);
		}
		return true;
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
 * Build a {@link SummaryJobWorker}. The daemon-assembly step constructs AND starts this
 * (summaries are a core feature, not a gated premium tier — it starts unconditionally
 * once the queue is up), and stops it in teardown. Constructing it has NO side effects
 * until `start()` / `runOnce()` runs.
 */
export function createSummaryJobWorker(deps: SummaryJobWorkerDeps): SummaryJobWorker {
	return new SummaryJobWorkerImpl(deps);
}
