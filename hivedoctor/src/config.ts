/**
 * HiveDoctor configuration resolution (PRD-064a, foundation).
 *
 * Resolves the watchdog's runtime config from environment variables layered over
 * built-in defaults, hand-validated with no zod (design principle 1: runtime is
 * Node built-ins ONLY; zod is a runtime npm dependency and is therefore banned from
 * the can't-crash process). Every parse is defensive: a malformed env value falls
 * back to the default rather than throwing, so a typo in an env var can never wedge
 * the watchdog at startup.
 *
 * Defaults mirror the PRD-064 / 064a rulings:
 *   - probe interval        30s  (064a goal)
 *   - target /health URL    http://127.0.0.1:3850/health  (the primary daemon)
 *   - backoff floor / ceil  1s / 30s  (064a scope: geometric, floor 1s, ceiling 30s)
 *   - restart give-up        3   (OD-4 resolved: reinstall after 3 failed restarts)
 *   - workspace dir          ~/.honeycomb/hivedoctor  (PRD-064 data-model section)
 *
 * Secret-free by construction: no value here is a credential. The daemon PID/lock
 * path (~/.honeycomb/daemon.pid) is included because rung 1 must respect it (064a
 * AC-064a.6 idempotency), and it mirrors the daemon's own `runtimeDir()/daemon.pid`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_STATUS_PAGE_PORT } from "./status-page/server.js";

/** The fully-resolved, validated watchdog config the supervisor consumes. */
export interface HiveDoctorConfig {
	/** How often the watch loop probes `/health`, in ms (default 30000). */
	readonly probeIntervalMs: number;
	/** Per-probe HTTP timeout, in ms (default 2000). A wedged socket must never hang the loop. */
	readonly probeTimeoutMs: number;
	/** Cold-boot / post-restart grace window, in ms (default 60000). */
	readonly startupGraceMs: number;
	/** The primary daemon health URL (default http://127.0.0.1:3850/health). */
	readonly healthUrl: string;
	/** The loopback status-page port (default 3852; 0 asks the OS for an ephemeral port). */
	readonly statusPagePort: number;
	/** Geometric-backoff floor, in ms (default 1000). */
	readonly backoffFloorMs: number;
	/** Geometric-backoff ceiling, in ms (default 30000). */
	readonly backoffCeilingMs: number;
	/** Consecutive failed restarts before advancing off rung 1 (default 3, OD-4). */
	readonly restartGiveUpThreshold: number;
	/** Cooldown after a restart HiveDoctor performed, in ms (default 5000), so it does not fight the daemon's own restart-helper. */
	readonly restartCooldownMs: number;
	/** How often the install-health telemetry snapshot is emitted, in ms (default 3600000 = 60 min, PRD-064d AC-064d.2). */
	readonly installHealthIntervalMs: number;
	/** HiveDoctor's own workspace dir (default ~/.honeycomb/hivedoctor). */
	readonly workspaceDir: string;
	/** The primary daemon PID/lock file HiveDoctor respects (default ~/.honeycomb/daemon.pid). */
	readonly daemonPidPath: string;
}

/** Built-in defaults, factored so resolution and tests share one source of truth. */
export interface ConfigDefaults {
	readonly probeIntervalMs: number;
	readonly probeTimeoutMs: number;
	readonly startupGraceMs: number;
	readonly healthUrl: string;
	readonly statusPagePort: number;
	readonly backoffFloorMs: number;
	readonly backoffCeilingMs: number;
	readonly restartGiveUpThreshold: number;
	readonly restartCooldownMs: number;
	readonly installHealthIntervalMs: number;
}

/** The canonical Wave-0 defaults (PRD-064 / 064a). */
export const DEFAULTS: ConfigDefaults = {
	probeIntervalMs: 30_000,
	probeTimeoutMs: 2_000,
	startupGraceMs: 60_000,
	healthUrl: "http://127.0.0.1:3850/health",
	statusPagePort: DEFAULT_STATUS_PAGE_PORT,
	backoffFloorMs: 1_000,
	backoffCeilingMs: 30_000,
	restartGiveUpThreshold: 3,
	restartCooldownMs: 5_000,
	// 60 minutes: a heartbeat coarse enough to be cheap, frequent enough to spot a box that
	// never heals (PRD-064d AC-064d.2). Operator-overridable via HIVEDOCTOR_INSTALL_HEALTH_INTERVAL_MS.
	installHealthIntervalMs: 3_600_000,
};

/**
 * Parse a positive-integer env value, falling back to `fallback` on anything that is
 * not a finite integer > 0. Defensive by design: a bad value never throws and never
 * yields a nonsensical (zero/negative/NaN) interval that would spin the loop.
 */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number.parseInt(raw.trim(), 10);
	return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Parse a non-negative-integer env value (cooldown may legitimately be 0), falling
 * back on anything that is not a finite integer >= 0.
 */
function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number.parseInt(raw.trim(), 10);
	return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Parse a TCP port. `0` is valid and asks the OS to choose an ephemeral port. */
function parsePort(raw: string | undefined, fallback: number): number {
	const n = parseNonNegativeInt(raw, fallback);
	return n <= 65_535 ? n : fallback;
}

/**
 * Validate a `/health` URL string: must parse as an http/https URL. Anything else
 * (empty, garbage, a non-http scheme) falls back to the default so a typo cannot
 * point the probe at an unparseable target.
 */
function parseHealthUrl(raw: string | undefined, fallback: string): string {
	if (raw === undefined || raw.trim() === "") return fallback;
	try {
		const url = new URL(raw.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
		return url.toString();
	} catch {
		// Unparseable URL: keep the safe default rather than crashing or probing junk.
		return fallback;
	}
}

/**
 * Resolve the watchdog config from `env` layered over {@link DEFAULTS}. The home
 * directory and env are injected so tests are hermetic (no real `~`, no real
 * `process.env`). Floor/ceiling are normalized so the ceiling is never below the
 * floor even if an operator inverts them.
 *
 * Recognized env vars (all optional, all defaulted):
 *   - HIVEDOCTOR_PROBE_INTERVAL_MS
 *   - HIVEDOCTOR_PROBE_TIMEOUT_MS
 *   - HIVEDOCTOR_STARTUP_GRACE_MS
 *   - HIVEDOCTOR_HEALTH_URL
 *   - HIVEDOCTOR_STATUS_PAGE_PORT
 *   - HIVEDOCTOR_BACKOFF_FLOOR_MS
 *   - HIVEDOCTOR_BACKOFF_CEILING_MS
 *   - HIVEDOCTOR_RESTART_GIVE_UP
 *   - HIVEDOCTOR_RESTART_COOLDOWN_MS
 *   - HIVEDOCTOR_INSTALL_HEALTH_INTERVAL_MS
 *   - HIVEDOCTOR_WORKSPACE_DIR
 *   - HONEYCOMB_DAEMON_PID_PATH
 */
export function resolveConfig(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): HiveDoctorConfig {
	const defaultWorkspace = join(home, ".honeycomb", "hivedoctor");
	const defaultPidPath = join(home, ".honeycomb", "daemon.pid");

	const floor = parsePositiveInt(env.HIVEDOCTOR_BACKOFF_FLOOR_MS, DEFAULTS.backoffFloorMs);
	const ceilingRaw = parsePositiveInt(env.HIVEDOCTOR_BACKOFF_CEILING_MS, DEFAULTS.backoffCeilingMs);
	// Normalize: a ceiling below the floor is incoherent; clamp it up to the floor.
	const ceiling = ceilingRaw < floor ? floor : ceilingRaw;

	const workspaceRaw = env.HIVEDOCTOR_WORKSPACE_DIR;
	const pidRaw = env.HONEYCOMB_DAEMON_PID_PATH;

	return {
		probeIntervalMs: parsePositiveInt(env.HIVEDOCTOR_PROBE_INTERVAL_MS, DEFAULTS.probeIntervalMs),
		probeTimeoutMs: parsePositiveInt(env.HIVEDOCTOR_PROBE_TIMEOUT_MS, DEFAULTS.probeTimeoutMs),
		startupGraceMs: parsePositiveInt(env.HIVEDOCTOR_STARTUP_GRACE_MS, DEFAULTS.startupGraceMs),
		healthUrl: parseHealthUrl(env.HIVEDOCTOR_HEALTH_URL, DEFAULTS.healthUrl),
		statusPagePort: parsePort(env.HIVEDOCTOR_STATUS_PAGE_PORT, DEFAULTS.statusPagePort),
		backoffFloorMs: floor,
		backoffCeilingMs: ceiling,
		restartGiveUpThreshold: parsePositiveInt(env.HIVEDOCTOR_RESTART_GIVE_UP, DEFAULTS.restartGiveUpThreshold),
		restartCooldownMs: parseNonNegativeInt(env.HIVEDOCTOR_RESTART_COOLDOWN_MS, DEFAULTS.restartCooldownMs),
		installHealthIntervalMs: parsePositiveInt(env.HIVEDOCTOR_INSTALL_HEALTH_INTERVAL_MS, DEFAULTS.installHealthIntervalMs),
		workspaceDir: workspaceRaw !== undefined && workspaceRaw.trim() !== "" ? workspaceRaw.trim() : defaultWorkspace,
		daemonPidPath: pidRaw !== undefined && pidRaw.trim() !== "" ? pidRaw.trim() : defaultPidPath,
	};
}
