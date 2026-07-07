/**
 * Adaptive poll backoff — PRD-062b (L-B1 / L-B2, AC-2 / AC-3).
 *
 * ── Why this exists (kill the idle baseline) ─────────────────────────────────
 * PRD-062 is a P0 cost incident: DeepLake compute tracks install count, not
 * usage, the signature of a fixed per-daemon cost paid at zero activity. Driver 1
 * is the idle-poll baseline — the pipeline stage worker and the pollinating worker
 * each poll the DeepLake-backed `memory_jobs` queue on a hardcoded 1000ms timer,
 * and a single lease/reaper discovery fans into several physical reads. So every
 * running daemon pays a constant ~1Hz × UNION-scan read cost FOREVER, even idle.
 *
 * This module is the cure for the cadence half: a small PURE state machine that an
 * idle poll loop consults to decide how long to wait before its NEXT lease pass.
 * It starts at a fast `floorMs`, DOUBLES toward a `ceilingMs` (~30s) while the
 * queue keeps returning empty, and RESETS to the floor the instant a job is leased
 * — so an idle daemon polls ~twice a minute while an active session is unchanged
 * (the first leased job snaps the interval back to the floor, AC-3).
 *
 * ── No I/O, no timer, no clock-of-record ─────────────────────────────────────
 * The state machine holds NOTHING but the current delay and its bounds. It issues
 * no query, owns no timer, and does not read the wall clock — the poll loop owns
 * the `setTimer`/`clearTimer` seam and feeds outcomes in (`onEmptyLease` /
 * `onLease`), then reads `nextDelayMs()` to schedule. That keeps it trivially
 * unit-testable (no fake timers needed for the state assertions) and lets the SAME
 * machine drive both workers' loops and the consolidated coordinator.
 *
 * ── Jitter (anti-thundering-herd) ────────────────────────────────────────────
 * A fleet of daemons that all back off in lockstep would re-stampede DeepLake at
 * each ceiling wake-up. So `nextDelayMs()` adds a small +/- jitter around the
 * current step (a fraction of the step, capped so it never pushes BELOW the floor
 * or meaningfully ABOVE the ceiling), de-correlating the fleet. The jitter source
 * is injectable so a test pins it to 0 and asserts the exact geometric schedule.
 */

import { z } from "zod";

import { BoolFlag } from "../../../shared/bool-flag.js";

/** Default fast floor the backoff starts at (and resets to on any lease). */
export const DEFAULT_POLL_BACKOFF_FLOOR_MS = 1_000;
/** Default ceiling the backoff doubles toward while the queue stays empty (~30s). */
export const DEFAULT_POLL_BACKOFF_CEILING_MS = 30_000;
/**
 * Default jitter fraction of the current step (+/- 10%). De-correlates a fleet of
 * daemons so they do not re-stampede DeepLake in lockstep at each ceiling wake-up.
 */
export const DEFAULT_POLL_BACKOFF_JITTER = 0.1;

/**
 * Default accumulated-idle (ms) at the ceiling before an idle loop SUSPENDS
 * (PRD-062e, opt-in). PRD-062b's ~30s ceiling still reconnects to DeepLake every
 * ~30s forever, which resets Activeloop's serverless compute idle-timer so the pod
 * never scales to zero (a flat `compute (uptime)` charge on an idle daemon). Once a
 * loop has been idle this long, suspend stops the fast cadence entirely.
 */
export const DEFAULT_POLL_SUSPEND_AFTER_MS = 120_000;
/**
 * Default backstop poll interval (ms) while SUSPENDED. A suspended loop still polls
 * on this long cadence so a job enqueued by ANOTHER device into the shared DeepLake
 * queue is eventually picked up; the local `wake()` path handles same-daemon jobs
 * instantly. Long enough that the pod scales to zero for the vast majority of idle
 * time, short enough that cross-device work is not stranded.
 */
export const DEFAULT_POLL_SUSPEND_BACKSTOP_MS = 300_000;

/**
 * A positive-integer tuning knob (ms): a non-numeric value falls back to the
 * default, a value below `min` is clamped up to `min`. A fat-fingered floor/ceiling
 * is tuning noise, never a config failure (mirrors `pollinating/config.ts`
 * `ClampedInt`).
 */
function ClampedInt(def: number, min = 1) {
	return z.preprocess((raw) => {
		const n = typeof raw === "number" ? raw : Number(raw);
		if (!Number.isFinite(n)) return def;
		return Math.max(min, Math.trunc(n));
	}, z.number().int());
}

/**
 * A 0..1 jitter fraction: a non-numeric value falls back to the default, an
 * out-of-range value is clamped into `[0, 1]`. Jitter is tuning, never a failure.
 */
function ClampedFraction(def: number) {
	return z.preprocess((raw) => {
		const n = typeof raw === "number" ? raw : Number(raw);
		if (!Number.isFinite(n)) return def;
		return Math.min(1, Math.max(0, n));
	}, z.number());
}

/**
 * The validated adaptive-backoff config the poll loops read. Resolved once and
 * injected; a consumer takes the resolved {@link PollBackoffConfig} as a dep and
 * never re-resolves it.
 *
 * `enabled` defaults FALSE-SAFE: with the flag off the workers MUST reproduce the
 * exact pre-PRD behavior (a flat `floorMs` interval, no doubling), so a regression
 * is a config rollback, not a redeploy (parent AC-9). Cost fixes ship DEFAULT-ON in
 * the daemon's own resolver (see {@link envPollBackoffConfigProvider}); this schema
 * default stays false so a bare `{}` (the parity test's "all flags off") is the
 * legacy path.
 */
export const PollBackoffConfigSchema = z.object({
	/** Master switch; off → flat `floorMs`, the exact pre-PRD cadence (AC-9). */
	enabled: BoolFlag.default(false),
	/** Fast floor the backoff starts at and resets to on any lease (AC-3). */
	floorMs: ClampedInt(DEFAULT_POLL_BACKOFF_FLOOR_MS).default(DEFAULT_POLL_BACKOFF_FLOOR_MS),
	/** Ceiling the backoff doubles toward while the queue stays empty (AC-2). */
	ceilingMs: ClampedInt(DEFAULT_POLL_BACKOFF_CEILING_MS).default(DEFAULT_POLL_BACKOFF_CEILING_MS),
	/** +/- jitter fraction of the current step, anti-thundering-herd. */
	jitter: ClampedFraction(DEFAULT_POLL_BACKOFF_JITTER).default(DEFAULT_POLL_BACKOFF_JITTER),
	/**
	 * Opt-in idle SUSPEND (PRD-062e). When on, a loop idle past {@link suspendAfterMs}
	 * stops the ~30s ceiling cadence and polls only on the long {@link suspendBackstopMs}
	 * backstop, so DeepLake's compute pod can scale to zero. Default OFF (FALSE-SAFE):
	 * an absent flag reproduces 062b's steady ceiling cadence, so this is non-breaking.
	 */
	suspendEnabled: BoolFlag.default(false),
	/** Accumulated idle (ms) at the ceiling before the loop suspends (AC: 062e). */
	suspendAfterMs: ClampedInt(DEFAULT_POLL_SUSPEND_AFTER_MS).default(DEFAULT_POLL_SUSPEND_AFTER_MS),
	/** Long backstop poll interval (ms) while suspended, so a job enqueued elsewhere is still caught. */
	suspendBackstopMs: ClampedInt(DEFAULT_POLL_SUSPEND_BACKSTOP_MS).default(DEFAULT_POLL_SUSPEND_BACKSTOP_MS),
});

/** The validated adaptive-backoff config every poll loop reads. */
export type PollBackoffConfig = z.infer<typeof PollBackoffConfigSchema>;

/**
 * Structured backoff-config error. Carries the flattened zod issues so the daemon
 * logs exactly which knob failed (mirrors `PollinatingConfigError`). A distinct
 * type so a backoff-config failure is never mistaken for a runtime request failure.
 */
export class PollBackoffConfigError extends Error {
	readonly issues: string[];
	constructor(issues: string[]) {
		super(`Invalid poll-backoff config: ${issues.join("; ")}`);
		this.name = "PollBackoffConfigError";
		this.issues = issues;
	}
}

/** The raw, un-validated shape the provider yields. */
export interface RawPollBackoffConfig {
	readonly enabled?: unknown;
	readonly floorMs?: unknown;
	readonly ceilingMs?: unknown;
	readonly jitter?: unknown;
	readonly suspendEnabled?: unknown;
	readonly suspendAfterMs?: unknown;
	readonly suspendBackstopMs?: unknown;
}

/**
 * The backoff-config provider seam (mirrors `PollinatingConfigProvider`). Returns
 * the raw, un-validated record so validation is the schema's job (one boundary, not
 * two). The env provider is the default; a test injects a fixed record.
 */
export interface PollBackoffConfigProvider {
	/** Read the raw backoff-config record. Missing keys yield undefined. */
	read(): RawPollBackoffConfig;
}

/**
 * Default provider: reads `HONEYCOMB_POLL_BACKOFF_*` from the environment. Daemon-
 * only code (never bundled into the OpenClaw target, which forbids `process.env`),
 * so a direct env read is correct here — mirrors `envPollinatingConfigProvider`.
 *
 * NOTE on the DEFAULT-ON posture (parent Locked-3 / AC-9): the cost fix ships
 * default-ON, so when the `HONEYCOMB_POLL_BACKOFF_ENABLED` env var is ABSENT this
 * provider yields `enabled: true` (adaptive backoff active). An EXPLICIT
 * `HONEYCOMB_POLL_BACKOFF_ENABLED=false` (or `0`) turns it off and restores the
 * flat 1000ms legacy cadence — the documented rollback. The parity test (AC-9)
 * drives the SCHEMA via a fixed `{}` record (enabled defaults false) to assert the
 * legacy path, independent of this env default.
 */
export function envPollBackoffConfigProvider(env: NodeJS.ProcessEnv = process.env): PollBackoffConfigProvider {
	return {
		read(): RawPollBackoffConfig {
			const raw = env.HONEYCOMB_POLL_BACKOFF_ENABLED;
			// Default-ON: an ABSENT flag means enabled. An explicit `false`/`0` rolls back.
			const enabled = raw === undefined ? true : raw;
			return {
				enabled,
				floorMs: env.HONEYCOMB_POLL_BACKOFF_FLOOR_MS,
				ceilingMs: env.HONEYCOMB_POLL_BACKOFF_CEILING_MS,
				jitter: env.HONEYCOMB_POLL_BACKOFF_JITTER,
				// Idle-suspend (PRD-062e) is OPT-IN / default-OFF: an absent flag leaves it off
				// (schema default false), so the steady 062b ceiling cadence is unchanged. An
				// explicit `HONEYCOMB_POLL_SUSPEND_ENABLED=true`/`1` turns it on.
				suspendEnabled: env.HONEYCOMB_POLL_SUSPEND_ENABLED,
				suspendAfterMs: env.HONEYCOMB_POLL_SUSPEND_AFTER_MS,
				suspendBackstopMs: env.HONEYCOMB_POLL_SUSPEND_BACKSTOP_MS,
			};
		},
	};
}

/**
 * Resolve the raw record into a validated {@link PollBackoffConfig}, then normalize
 * the bounds so the state machine never sees an impossible window: a `ceilingMs`
 * below the `floorMs` is lifted to the floor (a backwards window collapses to "no
 * backoff", never a negative step). The schema defaults every knob and clamps it,
 * so resolution succeeds for nearly any input; a structurally-impossible value
 * still throws {@link PollBackoffConfigError} listing every issue. This is the
 * single boundary where untrusted env crosses into typed backoff config
 * (zod-at-boundary).
 */
export function resolvePollBackoffConfig(
	provider: PollBackoffConfigProvider = envPollBackoffConfigProvider(),
): PollBackoffConfig {
	const parsed = PollBackoffConfigSchema.safeParse(provider.read());
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
		throw new PollBackoffConfigError(issues);
	}
	const cfg = parsed.data;
	// A ceiling below the floor is a no-op window: clamp it up to the floor so the
	// machine degenerates to a flat `floorMs` rather than ever stepping backwards.
	return cfg.ceilingMs < cfg.floorMs ? { ...cfg, ceilingMs: cfg.floorMs } : cfg;
}

/** A jitter source in `[-1, 1]`. Defaults to a uniform random draw; a test pins it. */
export type JitterSource = () => number;

/** Default jitter source: uniform in `[-1, 1)` (so the offset can be +/-). */
const defaultJitterSource: JitterSource = () => Math.random() * 2 - 1;

/**
 * The adaptive poll backoff state machine (PRD-062b). PURE: no I/O, no timer, no
 * wall-clock. The poll loop drives it:
 *
 *   - `onEmptyLease()` after a tick that leased NOTHING → step the delay toward the
 *     ceiling (double, capped).
 *   - `onLease()` after a tick that leased a job → reset the delay to the floor
 *     (AC-3: the first real job snaps the cadence back to fast).
 *   - `nextDelayMs()` → the ms to wait before the next tick, the current step plus
 *     a small bounded jitter (never below the floor, never meaningfully above the
 *     ceiling).
 *
 * `currentStepMs()` exposes the un-jittered step for assertions (the geometric
 * schedule a test checks reaches the ceiling).
 */
export class PollBackoff {
	private readonly floorMs: number;
	private readonly ceilingMs: number;
	private readonly jitter: number;
	private readonly jitterSource: JitterSource;
	/** The current un-jittered step. Starts at the floor; doubles toward the ceiling. */
	private stepMs: number;
	/** PRD-062e idle-suspend knobs (opt-in). */
	private readonly suspendEnabled: boolean;
	private readonly suspendAfterMs: number;
	private readonly backstopMs: number;
	/** Accumulated idle (ms) at the ceiling since the last lease; drives {@link shouldSuspend}. */
	private idleAccumMs = 0;

	/**
	 * @param config the resolved bounds + jitter fraction. The state machine is only
	 *   ever CONSTRUCTED when backoff is active; a loop with `config.enabled === false`
	 *   does not build one (it keeps its flat legacy interval), so this class need not
	 *   re-check the flag.
	 * @param jitterSource injectable `[-1, 1]` source — a test pins it to 0 to assert
	 *   the exact geometric schedule; production uses the uniform random default.
	 */
	constructor(
		config: Pick<PollBackoffConfig, "floorMs" | "ceilingMs" | "jitter"> &
			Partial<Pick<PollBackoffConfig, "suspendEnabled" | "suspendAfterMs" | "suspendBackstopMs">>,
		jitterSource: JitterSource = defaultJitterSource,
	) {
		this.floorMs = config.floorMs;
		// Guard the window here too (defense in depth) so a directly-constructed
		// machine with a backwards window still degrades to flat, never negative.
		this.ceilingMs = Math.max(config.floorMs, config.ceilingMs);
		this.jitter = config.jitter;
		this.jitterSource = jitterSource;
		this.stepMs = this.floorMs;
		// Suspend knobs default OFF/absent so a machine constructed with only the
		// legacy floor/ceiling/jitter (every existing caller + test) is unchanged.
		this.suspendEnabled = config.suspendEnabled ?? false;
		this.suspendAfterMs = config.suspendAfterMs ?? DEFAULT_POLL_SUSPEND_AFTER_MS;
		this.backstopMs = config.suspendBackstopMs ?? DEFAULT_POLL_SUSPEND_BACKSTOP_MS;
	}

	/**
	 * Step the delay toward the ceiling after an EMPTY lease (no job this tick):
	 * double the current step, capped at the ceiling. Idempotent at the ceiling (a
	 * fully-idle daemon stays there until a job arrives).
	 */
	onEmptyLease(): void {
		this.stepMs = Math.min(this.stepMs * 2, this.ceilingMs);
		// Accumulate idle time so the loop can suspend after `suspendAfterMs` (PRD-062e).
		// Charging the (new) step approximates the wait about to elapse before the next
		// empty tick; a few ticks at the ceiling cross the threshold.
		this.idleAccumMs += this.stepMs;
	}

	/**
	 * Reset the delay to the floor after a SUCCESSFUL lease (AC-3): the first real
	 * job snaps the cadence back to fast so an active session is unchanged. Also
	 * clears the idle accumulator so a busy loop never suspends.
	 */
	onLease(): void {
		this.stepMs = this.floorMs;
		this.idleAccumMs = 0;
	}

	/**
	 * True when the loop has been idle long enough to SUSPEND (PRD-062e, opt-in):
	 * suspend enabled AND accumulated idle at/above `suspendAfterMs`. The poll loop
	 * consults this after an empty tick and, when true, waits {@link suspendBackstopMs}
	 * instead of the ~30s ceiling so DeepLake's compute pod can scale to zero.
	 */
	shouldSuspend(): boolean {
		return this.suspendEnabled && this.idleAccumMs >= this.suspendAfterMs;
	}

	/** The long backstop interval to wait while suspended (catches cross-device jobs). */
	suspendBackstopMs(): number {
		return this.backstopMs;
	}

	/**
	 * Resume a suspended (or backed-off) loop: snap the cadence back to the floor and
	 * clear the idle accumulator. The poll loop calls this from `wake()` when a job is
	 * enqueued locally, so a captured memory is processed immediately rather than
	 * waiting for the backstop.
	 */
	resume(): void {
		this.stepMs = this.floorMs;
		this.idleAccumMs = 0;
	}

	/** The current un-jittered step (for assertions on the geometric schedule). */
	currentStepMs(): number {
		return this.stepMs;
	}

	/**
	 * The ms to wait before the next tick: the current step plus a bounded jitter.
	 * The jitter is a fraction of the step (`jitter * step`), so it scales with the
	 * step; the result is clamped to `[floorMs, ceilingMs]` so jitter never pushes
	 * the cadence below the fast floor (which would defeat the cost cut) or above the
	 * ceiling (which would blow the worst-case pickup-latency budget).
	 */
	nextDelayMs(): number {
		const offset = this.jitterSource() * this.jitter * this.stepMs;
		const delayed = this.stepMs + offset;
		return Math.min(this.ceilingMs, Math.max(this.floorMs, Math.round(delayed)));
	}
}
