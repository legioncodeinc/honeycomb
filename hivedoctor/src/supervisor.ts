/**
 * HiveDoctor supervisor - the watch loop (PRD-064a, the beating heart).
 *
 * Ties the pieces together: probe -> classify -> (heal via backoff + remediation
 * ladder) -> incident log, persisting state across HiveDoctor restarts. It is
 * crash-safe by construction (design principle 1, "incapable of crashing"): every
 * probe and every remediation runs inside try/catch, and {@link installCrashNet}
 * adds the last-resort `uncaughtException`/`unhandledRejection` net that logs and
 * keeps the process alive.
 *
 * The loop is driven by an INJECTABLE clock/timer (a {@link SupervisorClock}) so
 * tests run it deterministically with fake timers - no real 30s waits. `start()`
 * arms the loop; `stop()` disarms it; both are idempotent.
 *
 * Targeted-not-blind (AC-064a.4): the classification is handed to the ladder + each
 * rung so a `degraded` with a specific subsystem reason routes to the matching rung
 * rather than a blind restart. In Wave 0 only rung 1 exists, so the routing surfaces
 * via the classification carried into the rung context + the incident; rungs 2+ are
 * later-wave slots the ladder requests.
 *
 * Built-ins only; all I/O (probe, restart, pid read, clock) is injected.
 */

import type { Backoff } from "./backoff.js";
import type { HealthClassification } from "./health-probe.js";
import type { IncidentBuilder, IncidentLog, IncidentStep } from "./incidents.js";
import { triggerForClassification } from "./incidents.js";
import type { Logger } from "./logger.js";
import type { RemediationLadder, RungContext } from "./remediation.js";
import { buildEscalationRecord } from "./remediation.js";
import type { HiveDoctorState, StateStore } from "./state.js";

/** Injected clock + scheduler so tests drive time deterministically. */
export interface SupervisorClock {
	/** Sleep `ms`. */
	sleep(ms: number): Promise<void>;
	/** Current wall-clock ms. */
	now(): number;
}

/** One probe -> classify call, injected so the loop is hermetic. */
export type ProbeFn = () => Promise<HealthClassification>;

/**
 * A fire-and-forget error-telemetry seam (PRD-064d AC-064d.1). The supervisor calls it
 * ALONGSIDE its existing `logger.error(...)` whenever a caught exception would otherwise
 * be only logged, so the `error` stream populates. It is injected (not a direct emit
 * import) so the loop stays hermetic and so a test can assert the routed errors with a
 * recorder. It MUST be fail-soft: the supervisor never awaits it and never lets it throw.
 */
export type ErrorSink = (errorClass: string, errorDetail: string) => void;

/** Construction deps for {@link createSupervisor}. */
export interface SupervisorDeps {
	/** Probe + classify the daemon's `/health`. */
	readonly probe: ProbeFn;
	/** The remediation ladder (rung registry + advance logic). */
	readonly ladder: RemediationLadder;
	/** Backoff machine (geometric, jittered, persisted rung). */
	readonly backoff: Backoff;
	/** Durable state store (state.json). */
	readonly stateStore: StateStore;
	/** Incident log (incidents.ndjson). */
	readonly incidents: IncidentLog;
	/** Logger. */
	readonly logger: Logger;
	/** Injected clock/timer. */
	readonly clock: SupervisorClock;
	/** Probe interval in ms between healthy ticks. */
	readonly probeIntervalMs: number;
	/** Cold-boot / post-restart grace window in ms. Use 0 only for tests that need legacy behavior. */
	readonly startupGraceMs: number;
	/**
	 * Optional error-telemetry seam (PRD-064d). When present, caught exceptions in the
	 * tick are routed here in addition to the existing log line. Absent in Wave-0 tests
	 * and any caller that does not want telemetry; the loop behaves identically either way.
	 */
	readonly onError?: ErrorSink;
}

/** The supervisor surface. */
export interface Supervisor {
	/** Re-arm the boot grace window after an external actor starts/restarts the daemon. */
	armStartupGrace(): void;
	/** Arm and run the watch loop (resolves when `stop()` is called). Idempotent. */
	start(): Promise<void>;
	/** Disarm the watch loop. Idempotent. */
	stop(): void;
	/**
	 * Run exactly ONE tick (probe -> classify -> heal-if-needed -> persist). Exposed so
	 * tests can step the loop deterministically without the interval wait. Returns the
	 * classification observed this tick. Crash-safe: never throws.
	 */
	tick(): Promise<HealthClassification>;
}

/**
 * Install the last-resort crash net (design principle 1 / parent AC-8). An uncaught
 * exception or unhandled rejection ANYWHERE logs and is swallowed so the watchdog
 * process stays alive and the OS supervisor never has to restart it for a transient
 * bug. Returns an uninstall function (for tests, so listeners do not leak between
 * cases). This is the net, NOT the primary defense - the primary defense is the
 * per-step try/catch in the loop and the ladder.
 */
export function installCrashNet(logger: Logger, onError?: ErrorSink): () => void {
	// Route a caught crash to the error stream too (PRD-064d), fail-soft: a telemetry
	// failure here must never re-enter the crash net, so the sink call is itself guarded.
	const report = (errorClass: string, errorDetail: string): void => {
		if (onError === undefined) return;
		try {
			onError(errorClass, errorDetail);
		} catch {
			// A telemetry seam must never crash the last-resort crash net (design principle 1).
		}
	};
	const onException = (err: unknown): void => {
		logger.error("crashnet.uncaught_exception", {
			reason: err instanceof Error ? err.message : "unknown",
		});
		report("uncaughtException", err instanceof Error ? err.message : "unknown");
	};
	const onRejection = (reason: unknown): void => {
		logger.error("crashnet.unhandled_rejection", {
			reason: reason instanceof Error ? reason.message : String(reason),
		});
		report("unhandledRejection", reason instanceof Error ? reason.message : String(reason));
	};
	process.on("uncaughtException", onException);
	process.on("unhandledRejection", onRejection);
	return () => {
		process.off("uncaughtException", onException);
		process.off("unhandledRejection", onRejection);
	};
}

/** Map a classification kind to the coarse health string persisted in state.json. */
function coarseHealth(kind: HealthClassification["kind"]): HiveDoctorState["lastKnownHealth"] {
	if (kind === "ok") return "ok";
	if (kind === "degraded") return "degraded";
	return "unreachable";
}

/** Build the supervisor. */
export function createSupervisor(deps: SupervisorDeps): Supervisor {
	let running = false;
	let stopped = false;
	const startupGraceMs =
		Number.isFinite(deps.startupGraceMs) && deps.startupGraceMs > 0 ? deps.startupGraceMs : 0;
	let graceUntilMs = 0;

	function armStartupGrace(now = deps.clock.now()): void {
		graceUntilMs = startupGraceMs > 0 ? now + startupGraceMs : 0;
	}

	function startupGraceRemainingMs(now = deps.clock.now()): number {
		return graceUntilMs > now ? graceUntilMs - now : 0;
	}

	armStartupGrace();

	/**
	 * Route a caught error to the optional telemetry seam (PRD-064d AC-064d.1), fire-and-forget
	 * and fail-soft. This is called ALONGSIDE the existing `logger.error(...)`; it changes no
	 * control flow (the loop still catches + continues exactly as before). A missing seam is a
	 * no-op; a throwing seam is swallowed so telemetry can never destabilize the watch loop.
	 */
	function reportError(errorClass: string, errorDetail: string): void {
		if (deps.onError === undefined) return;
		try {
			deps.onError(errorClass, errorDetail);
		} catch {
			// Telemetry must never break the loop's crash-safety (design principle 1).
		}
	}

	/**
	 * Heal an unhealthy classification: decide the rung, run it, record the step, and
	 * update the consecutive-restart-failure count + backoff. Crash-safe; returns the
	 * (possibly mutated) state. The incident builder accumulates the ordered steps.
	 */
	async function heal(
		classification: HealthClassification,
		state: HiveDoctorState,
		incident: IncidentBuilder,
	): Promise<HiveDoctorState> {
		const decision = deps.ladder.decide(state.consecutiveRestartFailures);
		const ctx: RungContext = { classification, logger: deps.logger };

		if (decision.advanced) {
			// Give-up-after-N: we have exhausted rung-1 restarts; request rung 2 (a later-wave
			// slot in Wave 0). Record the escalation step so the incident shows the advance.
			const result = await deps.ladder.run(decision.rung, ctx);
			incident.addStep({
				rung: decision.rung,
				action: result.action,
				outcome: result.skipped === true ? "skipped" : result.ok ? "succeeded" : "failed",
				detail: result.detail,
			});
			// Escalate-on-give-up (PRD-064c rung 4): when the higher rung GENUINELY failed (not a
			// deliberate skip, not a success), the numbered ladder could not restore health. Hand the
			// episode off to the injected escalation hook crash-safely. The ladder resolves a skipped
			// result when no hook is wired (Wave-0 callers / the existing 064a tests), so this is a
			// no-op for a registry without an escalation sink and only records the terminal escalation
			// when one is present. It NEVER performs a deferred action.
			if (!result.ok && result.skipped !== true) {
				const escalation = await deps.ladder.escalate(
					buildEscalationRecord({
						diagnosis: `numbered remediation exhausted (rung ${decision.rung} ${result.detail ?? "failed"})`,
						steps: incident.build().steps as readonly IncidentStep[],
						recommendedAction: "manual-intervention",
						now: deps.clock.now,
					}),
				);
				incident.addStep({
					rung: decision.rung,
					action: escalation.action,
					outcome: escalation.skipped === true ? "skipped" : escalation.ok ? "succeeded" : "failed",
					detail: escalation.detail,
				});
			}

			// Leave the failure count where it is; the advance + any escalation are recorded and the
			// next tick re-evaluates against the persisted count.
			return state;
		}

		// Rung 1 (restart).
		const result = await deps.ladder.run(decision.rung, ctx);
		incident.addStep({
			rung: decision.rung,
			action: result.action,
			outcome: result.skipped === true ? "skipped" : result.ok ? "succeeded" : "failed",
			detail: result.detail,
		});

		if (result.skipped === true) {
			// A deliberate skip (cooldown, or lock-held-and-healthy) is NOT a failed restart - it
			// must not push us toward the give-up threshold. Leave the count untouched.
			return state;
		}

		if (result.ok) {
			// A kicked restart: reset nothing yet (health is confirmed on the NEXT probe, per
			// AC-064a.2). Record the restart time so the cooldown guard engages, and reset the
			// failure count to 0 only once health is confirmed (handled in tick on the ok branch).
			const now = deps.clock.now();
			armStartupGrace(now);
			return { ...state, lastRestartAt: new Date(now).toISOString() };
		}

		// A genuine failed restart: increment the consecutive-failure count + advance backoff so
		// the next attempt waits longer. At the threshold, decide() will advance to rung 2.
		deps.backoff.advance();
		return {
			...state,
			consecutiveRestartFailures: state.consecutiveRestartFailures + 1,
			backoffRung: deps.backoff.rung,
		};
	}

	async function tick(): Promise<HealthClassification> {
		// The whole tick is crash-safe: a probe that somehow throws (it shouldn't - probeHealth
		// is total) still resolves to a usable classification here, and any unexpected throw is
		// caught so the loop continues (AC-064a.5 / parent AC-8).
		let classification: HealthClassification = { kind: "unreachable-refused", detail: "probe-threw" };
		try {
			classification = await deps.probe();
		} catch (error) {
			const reason = error instanceof Error ? error.message : "unknown";
			deps.logger.error("tick.probe_threw", { reason });
			reportError("ProbeThrew", reason);
		}

		try {
			const state = deps.stateStore.read();

			if (classification.kind === "ok") {
				// Happy path (AC-064a.1): no action, low-verbosity log, and a confirmed return to
				// healthy resets the backoff + the consecutive-failure count (064a "reset on healthy").
				deps.logger.debug("tick.healthy");
				const healed =
					state.consecutiveRestartFailures > 0 || state.backoffRung > 0 || state.currentRung !== 1;
				if (healed || state.lastKnownHealth !== "ok") {
					deps.backoff.reset();
					deps.stateStore.write({
						...state,
						lastKnownHealth: "ok",
						currentRung: 1,
						consecutiveRestartFailures: 0,
						backoffRung: 0,
						lastHealAt: new Date(deps.clock.now()).toISOString(),
					});
				}
				return classification;
			}

			const graceRemainingMs = startupGraceRemainingMs();
			if (graceRemainingMs > 0) {
				deps.logger.info("tick.booting", { kind: classification.kind, remainingMs: graceRemainingMs });
				return classification;
			}

			// Unhealthy: open an incident episode, heal, persist, and write the episode.
			deps.logger.warn("tick.unhealthy", { kind: classification.kind });
			const trigger = triggerForClassification(classification.kind);
			const incident = deps.incidents.open(trigger, classification);
			const next = await heal(classification, { ...state, lastKnownHealth: coarseHealth(classification.kind) }, incident);
			deps.stateStore.write(next);
			deps.incidents.write(incident.build());
			return classification;
		} catch (error) {
			// Last-resort per-tick guard: any unexpected failure in the heal/persist path is logged
			// and swallowed so the loop survives to the next tick (design principle 1). The error is
			// also routed to the telemetry seam (PRD-064d) without changing the catch/continue behavior.
			const reason = error instanceof Error ? error.message : "unknown";
			deps.logger.error("tick.heal_threw", { reason });
			reportError("HealThrew", reason);
			return classification;
		}
	}

	return {
		armStartupGrace,
		async start(): Promise<void> {
			if (running) return;
			running = true;
			stopped = false;
			armStartupGrace();
			deps.logger.info("supervisor.start", { intervalMs: deps.probeIntervalMs, startupGraceMs });
			while (!stopped) {
				await tick();
				if (stopped) break;
				await deps.clock.sleep(deps.probeIntervalMs);
			}
			running = false;
			deps.logger.info("supervisor.stop");
		},
		stop(): void {
			stopped = true;
		},
		tick,
	};
}
