/**
 * HiveDoctor remediation ladder (PRD-064a scope; rung definitions cross-ref 064c).
 *
 * A {@link Rung} is one repair action; a {@link RemediationLadder} holds the ordered
 * registry and decides which rung to run for a given health classification, advancing
 * off rung 1 to rung 2 after 3 consecutive failed restarts (OD-4 / AC-064a.3).
 *
 * Wave 0 implements ONLY rung 1 (restart), behind an INJECTED {@link RestartFn}: the
 * real OS-service restart is 064b/064h, so here we accept a function the supervisor
 * (and later waves) plug in. That keeps rung 1 testable with a fake restart and keeps
 * the OS coupling out of Wave 0. Rungs 2+ are declared as interface SLOTS only - the
 * ladder records "advance to rung N" so a test (and 064c) can observe the request.
 *
 * Idempotency + the watchdog-war guard (064a AC-064a.6, parent AC-9): rung 1 does NOT
 * start a second daemon when the PID/lock is held AND `/health` is answering. It also
 * honors a cooldown after a restart HiveDoctor itself performed, so it never fights the
 * daemon's own restart-helper.ts (parent Risk "Watchdog war / double-restart").
 *
 * Crash-safety (design principle 1): every rung runs inside the ladder's try/catch; a
 * thrown rung becomes a `failed` {@link RungResult}, recorded in the incident, and the
 * loop continues (AC-064a.5). Built-ins only; all I/O (restart, PID read, health
 * re-probe, clock) is injected so the ladder itself is pure-ish and hermetic.
 */

import type { HealthClassification } from "./health-probe.js";
import type { Logger } from "./logger.js";
import { runEscalation } from "./rungs/escalation.js";
import type { EscalationHook, EscalationRecord } from "./rungs/escalation.js";

// ── Rung registry re-exports (PRD-064c) ──────────────────────────────────────
// remediation.ts is the single entry point to the ladder, so the higher-rung
// factories live in ./rungs/* but are re-exported here beside createRestartRung.
// Wave 0 (064a) shipped rung 1; Wave 1 (064c) adds rung 2 (reinstall), rung 3
// (uninstall conflicting Hivemind), and the terminal escalation hand-off (rung 4),
// each behind injected runners/hooks so they are hermetic and testable.
export { createReinstallRung, PRIMARY_PACKAGE } from "./rungs/reinstall.js";
export type { ReinstallRungDeps, ReadInstalledVersionFn } from "./rungs/reinstall.js";
export {
	createUninstallHivemindRung,
	createNpmHivemindDetector,
	HIVEMIND_PACKAGE,
} from "./rungs/uninstall-hivemind.js";
export type {
	UninstallHivemindRungDeps,
	DetectHivemindFn,
	RemovedPackageRecord,
} from "./rungs/uninstall-hivemind.js";
export { buildEscalationRecord, runEscalation } from "./rungs/escalation.js";
export type {
	EscalationRecord,
	EscalationHook,
	RecommendedAction,
	BuildEscalationInput,
} from "./rungs/escalation.js";
export { createExecFileRunner } from "./rungs/command-runner.js";
export type { CommandRunner, CommandResult, CommandRunOptions } from "./rungs/command-runner.js";

/** The outcome of running one rung. */
export interface RungResult {
	/** Whether the rung's action completed without throwing AND did its job. */
	readonly ok: boolean;
	/** A short stable action verb for the incident step (e.g. `restart-daemon`). */
	readonly action: string;
	/** Optional secret-free detail (skip reason, error class). */
	readonly detail?: string;
	/** True when the rung deliberately did nothing (e.g. lock held + healthy, or in cooldown). */
	readonly skipped?: boolean;
}

/** Context handed to a rung when it runs. */
export interface RungContext {
	/** The classification that triggered remediation (lets a rung target the failing subsystem). */
	readonly classification: HealthClassification;
	/** Logger for the rung's lifecycle events. */
	readonly logger: Logger;
}

/** One ladder rung. */
export interface Rung {
	/** 1-based ladder position. */
	readonly rung: number;
	/** Stable name for logs/incidents. */
	readonly name: string;
	/** Run the rung's repair action. MUST NOT throw - the ladder wraps it, but a rung should resolve a {@link RungResult}. */
	run(ctx: RungContext): Promise<RungResult>;
}

/**
 * The injected restart function (the real OS-service restart is 064b/064h). It returns
 * `true` when it believes it kicked a restart, `false`/throw when it could not. The
 * supervisor wires the real implementation; tests wire a fake.
 */
export type RestartFn = () => Promise<boolean>;

/** Reads the daemon PID from the lock file, or null when absent/garbage. Injected. */
export type ReadDaemonPidFn = () => Promise<number | null>;

/** Re-probes `/health`, returning true iff the daemon answers healthy. Injected. */
export type IsHealthyFn = () => Promise<boolean>;

/** Injected clock so the cooldown is deterministic in tests. */
export interface RemediationClock {
	now(): number;
}

/** Construction deps for rung 1. */
export interface RestartRungDeps {
	/** The injected restart action. */
	readonly restart: RestartFn;
	/** Reads the daemon PID/lock file. */
	readonly readDaemonPid: ReadDaemonPidFn;
	/** Re-probes `/health` for the lock-held-and-answering idempotency check. */
	readonly isHealthy: IsHealthyFn;
	/** Cooldown in ms after a restart HiveDoctor performed (no double-restart inside it). */
	readonly cooldownMs: number;
	/** Injected clock. */
	readonly clock: RemediationClock;
	/** Returns the ISO/epoch ms of the last restart HiveDoctor performed, or null. */
	readonly lastRestartAt: () => number | null;
	/** Records that a restart just happened (so the cooldown window starts). */
	readonly markRestarted: (atMs: number) => void;
}

/**
 * Build rung 1 (restart). Idempotency + watchdog-war guard order (064a AC-064a.6):
 *   1. If we restarted within the cooldown window, SKIP (do not fight our own/the
 *      daemon's restart-helper).
 *   2. If the PID/lock is held AND `/health` answers, SKIP (a second daemon would just
 *      hit the single-instance lock and exit - restart-helper.ts header).
 *   3. Otherwise run the injected restart and start the cooldown.
 */
export function createRestartRung(deps: RestartRungDeps): Rung {
	return {
		rung: 1,
		name: "restart-daemon",
		async run(ctx: RungContext): Promise<RungResult> {
			// Guard 1: cooldown. A restart we performed very recently means a fresh daemon may
			// still be coming up; restarting again would loop. Skip until the window passes.
			const last = deps.lastRestartAt();
			if (last !== null && deps.clock.now() - last < deps.cooldownMs) {
				ctx.logger.debug("rung1.skip_cooldown", { sinceMs: deps.clock.now() - last });
				return { ok: false, skipped: true, action: "restart-daemon", detail: "cooldown" };
			}

			// Guard 2: lock held + answering. If the PID file names a daemon and /health answers,
			// the daemon is actually fine (or recovering); do not start a second one.
			const pid = await deps.readDaemonPid();
			if (pid !== null && (await deps.isHealthy())) {
				ctx.logger.debug("rung1.skip_lock_healthy", { pid });
				return { ok: false, skipped: true, action: "restart-daemon", detail: "lock-held-and-healthy" };
			}

			// Run the injected restart.
			const kicked = await deps.restart();
			if (kicked) deps.markRestarted(deps.clock.now());
			ctx.logger.info("rung1.restart", { kicked });
			return { ok: kicked, action: "restart-daemon", detail: kicked ? undefined : "restart-fn-returned-false" };
		},
	};
}

/** The decision the ladder returns: which rung to run next, or that it gave up. */
export interface LadderDecision {
	/** The 1-based rung to run. */
	readonly rung: number;
	/** Whether this is an ADVANCE off rung 1 (the give-up-after-N restart escalation). */
	readonly advanced: boolean;
}

/** Construction deps for the ladder. */
export interface LadderDeps {
	/** The registered rungs, in ascending order. Wave 0 registers only rung 1; Wave 1 (064c) adds 2 + 3. */
	readonly rungs: readonly Rung[];
	/** Consecutive failed restarts before advancing off rung 1 (default 3, OD-4). */
	readonly restartGiveUpThreshold: number;
	/** Logger. */
	readonly logger: Logger;
	/**
	 * The terminal escalation hand-off (rung 4). Injected by the supervisor; 064g plugs
	 * in the real dashboard/telemetry sink. Optional so Wave-0 callers that never escalate
	 * (and the existing 064a tests) construct the ladder unchanged; when absent,
	 * {@link RemediationLadder.escalate} resolves to a skipped result naming the missing hook.
	 */
	readonly escalationHook?: EscalationHook;
}

/** The ladder: chooses + runs rungs, tracking the consecutive-failure count. */
export interface RemediationLadder {
	/**
	 * Decide which rung to run given the current consecutive-restart-failure count.
	 * `failures < threshold` -> rung 1; `failures >= threshold` -> advance to rung 2.
	 * Pure (no side effects), so the supervisor can record the decision in the incident.
	 */
	decide(consecutiveRestartFailures: number): LadderDecision;
	/**
	 * Run a chosen rung, wrapped crash-safe. A thrown rung becomes a failed RungResult
	 * (AC-064a.5) - never propagates. A rung index with no registered rung (a later-wave
	 * slot, e.g. rung 2 in Wave 0) returns a `skipped` result naming the slot, so a test
	 * can assert "the ladder REQUESTED rung 2" without that rung existing yet (AC-064a.3).
	 */
	run(rung: number, ctx: RungContext): Promise<RungResult>;
	/**
	 * Terminal escalation hand-off (rung 4, PRD-064c). Called when the numbered rungs
	 * cannot restore health, or when the action HiveDoctor believes is needed is the
	 * DEFERRED credential purge (AC-064c.3). Hands the structured {@link EscalationRecord}
	 * to the injected hook crash-safely - a thrown hook becomes a failed result, never a
	 * thrown error. When no hook was injected, resolves to a skipped result so the caller
	 * still records the escalation intent in the incident. NEVER performs a deferred
	 * action; it only records what it WOULD have taken.
	 */
	escalate(record: EscalationRecord): Promise<RungResult>;
}

/** Build the remediation ladder over a rung registry. */
export function createRemediationLadder(deps: LadderDeps): RemediationLadder {
	const byIndex = new Map<number, Rung>();
	for (const r of deps.rungs) byIndex.set(r.rung, r);

	return {
		decide(consecutiveRestartFailures: number): LadderDecision {
			if (consecutiveRestartFailures >= deps.restartGiveUpThreshold) {
				deps.logger.warn("ladder.advance", { failures: consecutiveRestartFailures, to: 2 });
				return { rung: 2, advanced: true };
			}
			return { rung: 1, advanced: false };
		},

		async run(rung: number, ctx: RungContext): Promise<RungResult> {
			const impl = byIndex.get(rung);
			if (impl === undefined) {
				// A declared-but-unimplemented slot (rungs 2+ in Wave 0). Record the request so the
				// supervisor logs the escalation and the incident shows "advanced to rung N"; the
				// real action lands in a later wave (064c).
				deps.logger.warn("ladder.rung_not_implemented", { rung });
				return { ok: false, skipped: true, action: `rung-${rung}-not-implemented`, detail: "later-wave-slot" };
			}
			try {
				return await impl.run(ctx);
			} catch (error) {
				// Crash-safety (AC-064a.5): a thrown rung is caught here, surfaced as a failed
				// result for the incident, and the loop continues. The watchdog never dies on a
				// remediation failure.
				const detail = error instanceof Error ? error.message : "unknown";
				deps.logger.error("ladder.rung_threw", { rung, reason: detail });
				return { ok: false, action: impl.name, detail };
			}
		},

		async escalate(record: EscalationRecord): Promise<RungResult> {
			if (deps.escalationHook === undefined) {
				// No sink wired (Wave-0 callers / 064g not yet plugged in). Record the intent so the
				// incident still shows the escalation, without an action having been delivered.
				deps.logger.warn("ladder.escalate_no_hook", { recommendedAction: record.recommendedAction });
				return { ok: false, skipped: true, action: "escalate", detail: "no-escalation-hook" };
			}
			// runEscalation isolates the hook in try/catch: even a flaky sink cannot crash the loop.
			return runEscalation(record, deps.escalationHook, deps.logger);
		},
	};
}
