/**
 * Single combined lease coordinator — PRD-062b (L-B3, AC-4).
 *
 * ── Why this exists (one poller, not two) ────────────────────────────────────
 * Driver 1 of the PRD-062 cost incident is the idle-poll baseline, and HALF of it
 * is that TWO independent workers each run a full 1Hz discovery scan of the
 * DeepLake-backed `memory_jobs` queue: the pipeline stage worker (its five pipeline
 * kinds) and the pollinating worker (`pollinating`). Each `lease()` fans into
 * several physical reads (the append-only UNION-scan), so two independent scans is
 * twice the idle read cost for no benefit — the queue is one table.
 *
 * This coordinator collapses the two scans into ONE. Per tick it does a SINGLE
 * `queue.lease(union-of-all-participant-kinds)` and ROUTES the leased job to the
 * participant that owns its kind. So a tick costs ONE discovery scan instead of two,
 * while each participant still only RUNS the kinds it owns (kind isolation is
 * preserved exactly — see below).
 *
 * ── Kind isolation is preserved (the load-bearing invariant) ─────────────────
 * The union lease passes EVERY participant's kinds to `queue.lease(kinds)`, so the
 * coordinator only ever leases a kind some participant owns — a foreign kind
 * (`summary`, `skillify`, …) is NEVER leased and stays queued for its own worker,
 * byte-identical to the per-worker `lease(kinds)` filter today. When a job IS leased,
 * it is dispatched to the unique participant whose `leaseKinds` contains that kind —
 * so a pipeline job runs the pipeline processor and a pollinating job runs the
 * pollinating processor, never the other way round. A leased kind that matches NO
 * participant (a wiring bug) is failed with a clear reason, never silently completed.
 *
 * ── Gated behind HONEYCOMB_POLL_CONSOLIDATE (AC-9) ───────────────────────────
 * Consolidation is a behavior change, so it sits behind its own env flag. With the
 * flag OFF the daemon-assembly builds + starts the two workers INDEPENDENTLY exactly
 * as before (two lease passes); with it ON the assembly builds the participants,
 * registers them with this coordinator, and starts the coordinator's single loop
 * instead. The flag is read through the same config-provider pattern as the rest of
 * PRD-062b (see {@link resolvePollConsolidateConfig}).
 *
 * ── Composes with adaptive backoff ───────────────────────────────────────────
 * The coordinator drives the SAME {@link createPollLoop} runner the individual
 * workers use, so the single combined pass ALSO backs off when idle and snaps back
 * to the floor on any leased job (AC-2 / AC-3). One backoff state machine over the
 * one combined pass — the cost cut compounds.
 */

import { z } from "zod";

import type { JobQueueService, LeasedJob } from "./job-queue.js";
import type { PollBackoffConfig } from "./poll-backoff.js";
import { createPollLoop, type PollLoop } from "./poll-loop.js";

/**
 * One consumer of the combined lease pass. A participant declares the kinds it owns
 * and how to PROCESS an already-leased job of one of those kinds. The coordinator
 * owns the lease; the participant owns the route+run+complete/fail (it MUST
 * complete or fail every job it is handed — the coordinator never touches the queue
 * for completion).
 */
export interface LeaseParticipant {
	/** The kinds this participant owns (the same set its standalone `lease(kinds)` used). */
	readonly leaseKinds: readonly string[];
	/**
	 * Process ONE already-leased job this participant owns: route it, run it, and
	 * complete/fail it through the queue. Returns when done; it must NOT throw for a
	 * job failure (it routes the throw to `queue.fail` itself, mirroring the workers'
	 * standalone `runOnce`).
	 */
	processLeased(leased: LeasedJob): Promise<void>;
}

/** A minimal structured-log sink (mirrors the workers' loggers). */
export interface LeaseCoordinatorLogger {
	/** Record a structured event (e.g. `lease.coordinator.unknown_kind`). */
	event(name: string, fields?: Record<string, unknown>): void;
}

/** The injected timer seam (mirrors the workers' `setTimer`/`clearTimer`). */
export interface LeaseCoordinatorTimers {
	/** Schedule a callback after `ms`; returns a handle for {@link clearTimer}. */
	readonly setTimer: (cb: () => void, ms: number) => unknown;
	/** Cancel a handle returned by {@link setTimer}. */
	readonly clearTimer: (handle: unknown) => void;
	/** Schedule a repeating callback for the legacy flat cadence. */
	readonly setRepeatingTimer?: (cb: () => void, ms: number) => unknown;
	/** Cancel a handle returned by {@link setRepeatingTimer}. */
	readonly clearRepeatingTimer?: (handle: unknown) => void;
}

/** Construction deps for {@link createLeaseCoordinator}. */
export interface LeaseCoordinatorDeps {
	/** The durable queue the single combined pass leases from. */
	readonly queue: JobQueueService;
	/** The participants whose kinds the union pass covers (pipeline + pollinating). */
	readonly participants: readonly LeaseParticipant[];
	/** The resolved adaptive-backoff config the single pass runs under (AC-2 / AC-3). */
	readonly backoff: PollBackoffConfig;
	/** The flat interval used when backoff is OFF (the pre-PRD `DEFAULT_POLL_INTERVAL_MS`). */
	readonly flatIntervalMs: number;
	/**
	 * The injected timer seam (a manual clock in tests). OPTIONAL — defaults to real
	 * `setInterval`/`clearInterval`, mirroring the workers, so the daemon-assembly need
	 * not thread real timers and a test injects a fake.
	 */
	readonly timers?: LeaseCoordinatorTimers;
	/** Optional structured-log sink. */
	readonly logger?: LeaseCoordinatorLogger;
}

/**
 * The lease coordinator: one combined lease pass per tick over the union of every
 * participant's kinds, each leased job routed to its owning participant.
 */
export interface LeaseCoordinator {
	/**
	 * Run ONE combined lease pass: a single `queue.lease(union-kinds)` and, if a job
	 * is leased, dispatch it to the participant that owns its kind. Returns `true`
	 * when a job was processed, `false` when the pass leased nothing. The
	 * deterministic unit a test drives (AC-4).
	 */
	runOnce(): Promise<boolean>;
	/** Start the single combined poll loop (adaptive or flat per the backoff config). */
	start(): void;
	/** Stop the loop. Idempotent. */
	stop(): void;
}

/** The concrete coordinator. */
class CombinedLeaseCoordinator implements LeaseCoordinator {
	private readonly queue: JobQueueService;
	private readonly participants: readonly LeaseParticipant[];
	private readonly logger?: LeaseCoordinatorLogger;
	private readonly unionKinds: readonly string[];
	/** `kind` → the participant that owns it (built once; one owner per kind). */
	private readonly routes: Map<string, LeaseParticipant>;
	private readonly loop: PollLoop;

	constructor(deps: LeaseCoordinatorDeps) {
		this.queue = deps.queue;
		this.participants = deps.participants;
		this.logger = deps.logger;
		// Build the kind → participant routing table once. The union is the set of
		// every participant's kinds; the route map is what dispatches a leased job to
		// its owner. A kind claimed by two participants is a wiring bug — first writer
		// wins and the collision is surfaced, never silently mis-routed.
		this.routes = new Map<string, LeaseParticipant>();
		const union: string[] = [];
		for (const participant of deps.participants) {
			for (const kind of participant.leaseKinds) {
				if (this.routes.has(kind)) {
					this.logger?.event("lease.coordinator.duplicate_kind", { kind });
					continue;
				}
				this.routes.set(kind, participant);
				union.push(kind);
			}
		}
		this.unionKinds = union;
		const timers: LeaseCoordinatorTimers = deps.timers ?? {
			setTimer: (cb, ms) => {
				// PRD-062b hardening: unref the combined-lease timer so it never holds the
				// process open or burdens teardown (mirrors the capture-buffer flush timer).
				const t = setTimeout(cb, ms);
				if (typeof t === "object" && t !== null && "unref" in t && typeof t.unref === "function") t.unref();
				return t;
			},
			clearTimer: (handle) => {
				if (handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>);
			},
			setRepeatingTimer: (cb, ms) => {
				const t = setInterval(cb, ms);
				if (typeof t === "object" && t !== null && "unref" in t && typeof t.unref === "function") t.unref();
				return t;
			},
			clearRepeatingTimer: (handle) => {
				if (handle !== undefined) clearInterval(handle as ReturnType<typeof setInterval>);
			},
		};
		this.loop = createPollLoop({
			tick: () => this.runOnce(),
			backoff: deps.backoff,
			flatIntervalMs: deps.flatIntervalMs,
			timers,
		});
	}

	async runOnce(): Promise<boolean> {
		// ONE combined lease pass over the union of every participant's kinds (AC-4).
		// Passing the union to `lease(kinds)` keeps kind isolation EXACT: a foreign kind
		// no participant owns is never leased and stays queued for its own worker.
		const leased = await this.queue.lease(this.unionKinds);
		if (leased === null) return false;

		// Route the leased job to the participant that owns its kind. A leased kind with
		// no route is a wiring bug worth surfacing — fail it with a clear reason rather
		// than silently completing a job no participant can run (never a swallowed error).
		const participant = this.routes.get(leased.kind);
		if (participant === undefined) {
			this.logger?.event("lease.coordinator.unknown_kind", { id: leased.id, kind: leased.kind });
			await this.queue.fail(leased.id, `no participant owns leased kind: ${leased.kind}`, leased.attempt);
			return true;
		}

		// The participant owns route+run+complete/fail (it never throws for a job
		// failure — it routes the throw to queue.fail itself), exactly as its standalone
		// runOnce did. The coordinator only dispatches.
		await participant.processLeased(leased);
		return true;
	}

	start(): void {
		this.loop.start();
	}

	stop(): void {
		this.loop.stop();
	}
}

/**
 * Build a {@link LeaseCoordinator} over the given participants. The daemon-assembly
 * constructs this ONLY when `HONEYCOMB_POLL_CONSOLIDATE` is on; otherwise it starts
 * the workers independently (AC-9 parity). Construction has no side effects until
 * `start()` / `runOnce()` runs.
 */
export function createLeaseCoordinator(deps: LeaseCoordinatorDeps): LeaseCoordinator {
	return new CombinedLeaseCoordinator(deps);
}

// ── HONEYCOMB_POLL_CONSOLIDATE flag (AC-9) ──────────────────────────────────────

/**
 * A boolean flag read from an env string: `true`/`1` → true, anything else →
 * false. Mirrors `pollinating/config.ts` `BoolFlag` so the env contract is uniform.
 */
const BoolFlag = z.preprocess((raw) => {
	if (typeof raw === "boolean") return raw;
	return raw === "true" || raw === "1";
}, z.boolean());

/**
 * The validated consolidation config. `enabled` defaults FALSE-SAFE in the schema so
 * a bare `{}` (the AC-9 parity test) is the legacy two-pass path; the daemon's env
 * provider ships it DEFAULT-ON (the cost fix), with an explicit
 * `HONEYCOMB_POLL_CONSOLIDATE=false` rolling back.
 */
export const PollConsolidateConfigSchema = z.object({
	/** Master switch; off → two independent lease passes, the pre-PRD path (AC-9). */
	enabled: BoolFlag.default(false),
});

/** The validated consolidation config. */
export type PollConsolidateConfig = z.infer<typeof PollConsolidateConfigSchema>;

/** The raw, un-validated shape the provider yields. */
export interface RawPollConsolidateConfig {
	readonly enabled?: unknown;
}

/** The consolidation-config provider seam (mirrors `PollinatingConfigProvider`). */
export interface PollConsolidateConfigProvider {
	/** Read the raw consolidation-config record. Missing keys yield undefined. */
	read(): RawPollConsolidateConfig;
}

/**
 * Default provider: reads `HONEYCOMB_POLL_CONSOLIDATE` from the environment. Daemon-
 * only code (never bundled into the OpenClaw target). DEFAULT-ON like the backoff
 * flag: an ABSENT var means enabled; an explicit `false`/`0` rolls back to the two
 * independent lease passes.
 */
export function envPollConsolidateConfigProvider(env: NodeJS.ProcessEnv = process.env): PollConsolidateConfigProvider {
	return {
		read(): RawPollConsolidateConfig {
			const raw = env.HONEYCOMB_POLL_CONSOLIDATE;
			return { enabled: raw === undefined ? true : raw };
		},
	};
}

/**
 * Resolve the raw record into a validated {@link PollConsolidateConfig}. The schema
 * defaults + coerces, so resolution succeeds for nearly any input. This is the
 * single boundary where the untrusted env crosses into typed config (zod-at-boundary).
 */
export function resolvePollConsolidateConfig(
	provider: PollConsolidateConfigProvider = envPollConsolidateConfigProvider(),
): PollConsolidateConfig {
	return PollConsolidateConfigSchema.parse(provider.read());
}
