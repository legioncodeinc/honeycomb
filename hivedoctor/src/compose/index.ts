/**
 * The HiveDoctor composition root (PRD-064f - the production assembly).
 *
 * `createHiveDoctor()` constructs the WHOLE watchdog from the wave-built primitives and
 * returns a `{ start, stop }` handle the OS service (064b/064h) execs. It wires:
 *
 *   - the supervisor watch loop (064a) over the real probe + the remediation ladder with
 *     rungs 1/2/3 REGISTERED for production (the prior wave left rungs 2/3 as ladder slots
 *     in the supervisor path; this is where they are plugged in);
 *   - the escalation hook (064c -> 064g) wired to BOTH the local needs-attention store and
 *     the hosted PostHog sink, so a give-up reaches a human even when the daemon is down;
 *   - the auto-update poll loop (064e), respecting the resolved opt-out precedence
 *     (--no-auto-update flag > env > state > pin) computed here;
 *   - the local status page (064g) on the loopback comfort port.
 *
 * EVERYTHING is fail-soft (design principle 1, "incapable of crashing"): every external
 * action is behind an injected seam that resolves a value, the crash net is installed, and
 * `start()` never throws. `stop()` disarms every loop + closes the status page idempotently.
 *
 * The `self-update` boundary is SACRED here too: this assembly wires the auto-update engine
 * HARD-CODED to the PRIMARY daemon package (`@legioncodeinc/honeycomb`). There is no code
 * path in this composition that installs `@legioncodeinc/hivedoctor`; that is reachable
 * ONLY through the explicit CLI `self-update` command (AC-064f.5 / parent AC-6).
 *
 * Built-ins only; all I/O behind seams so the smoke test drives the whole assembly hermetic.
 */

import { createBackoff } from "../backoff.js";
import { resolveConfig, type HiveDoctorConfig } from "../config.js";
import { probeHealth } from "../health-probe.js";
import { createIncidentLog } from "../incidents.js";
import { createInstallLock } from "../install-lock.js";
import { createLogger, type Logger, type LogLevel } from "../logger.js";
import {
	createRemediationLadder,
	createReinstallRung,
	createRestartRung,
	createUninstallHivemindRung,
	createNpmHivemindDetector,
	createExecFileRunner,
	type CommandRunner,
	type EscalationHook,
	type RemediationLadder,
	type RestartFn,
} from "../remediation.js";
import { createStateStore, type StateStore } from "../state.js";
import { createSupervisor, installCrashNet, type Supervisor, type SupervisorClock } from "../supervisor.js";
import { readDaemonVersion } from "../cli/daemon-version.js";
import { resolveOptOut, type ResolvedOptOut } from "../cli/opt-out.js";
import { createNeedsAttentionStore, type NeedsAttentionStore } from "../escalation/needs-attention-store.js";
import { emitEscalationToHostedSink } from "../escalation/hosted-sink.js";
import { createStatusPageServer, DEFAULT_STATUS_PAGE_PORT, type StatusPageServer } from "../status-page/server.js";
import {
	createUpdateEngine,
	createUpdatePollLoop,
	createRegistryLatestReader,
	fetchBlessedVersion,
	PRIMARY_PACKAGE,
	type BlessedChannelOptions,
	type UpdateEngine,
	type UpdatePollLoop,
} from "../update/index.js";
import { HIVEDOCTOR_VERSION } from "../version.js";

/** A real wall-clock {@link SupervisorClock} (timers + Date.now), used by both loops. */
export function createRealClock(): SupervisorClock {
	return {
		now: () => Date.now(),
		sleep: (ms: number) =>
			new Promise<void>((resolve) => {
				const t = setTimeout(resolve, ms);
				// Do not keep the event loop alive purely for a sleep timer.
				if (typeof t.unref === "function") t.unref();
			}),
	};
}

/** Options for {@link createHiveDoctor}. All have production defaults; tests inject seams. */
export interface CreateHiveDoctorOptions {
	/** Resolved config (default: {@link resolveConfig} over the real env + home). */
	readonly config?: HiveDoctorConfig;
	/** The process env (for opt-out resolution). Defaults to `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
	/** True when `--no-auto-update` was passed (the highest-precedence opt-out). */
	readonly cliNoAutoUpdate?: boolean;
	/** Logger (default: a leveled logger at `info`). */
	readonly logger?: Logger;
	/** Log level for the default logger. */
	readonly logLevel?: LogLevel;
	/** Injected clock (default: the real wall-clock). Tests inject a fake. */
	readonly clock?: SupervisorClock;
	/** The shared device id (PRD-033 UUID) stamped on telemetry + escalation. */
	readonly deviceId?: string;
	/**
	 * A static blessed version rung 2 verifies against. Normally left unset: the composition
	 * resolves the live blessed version from the blessed channel at remediation time (fail-soft).
	 * When set, it is the fallback the rung uses if the channel is unreachable/unparseable.
	 */
	readonly blessedVersion?: string;
	/**
	 * Injectable blessed-channel options (the network seam). Tests pass a recorder fetch so no
	 * real HTTP runs; production omits this and the channel hits the real CDN over global fetch.
	 */
	readonly blessedChannel?: BlessedChannelOptions;
	/** The status-page port (default {@link DEFAULT_STATUS_PAGE_PORT}). */
	readonly statusPagePort?: number;

	// ── Injectable production seams (tests override these so nothing real runs) ──
	/** The restart action (064b/064h owns the real OS restart; default is a logged no-op). */
	readonly restart?: RestartFn;
	/** The command runner used by rungs 2/3 + auto-update (default: execFile, no shell). */
	readonly runner?: CommandRunner;
	/** Override the probe (default: the real node:http probe against config.healthUrl). */
	readonly probe?: () => ReturnType<typeof probeHealth>;
	/** Override the auto-update engine (default: the real 064e engine). */
	readonly updateEngine?: UpdateEngine;
	/** Override the hosted escalation sink (default: emit through the 064d chokepoint). */
	readonly hostedEscalation?: EscalationHook;
}

/** The running HiveDoctor handle the OS service execs. */
export interface HiveDoctor {
	/** Arm every loop + the status page + the crash net. Fail-soft; never throws. */
	start(): Promise<void>;
	/** Disarm every loop + close the status page + remove the crash net. Idempotent. */
	stop(): Promise<void>;
	/** The supervisor (exposed for the smoke test to step a tick). */
	readonly supervisor: Supervisor;
	/** The auto-update poll loop (exposed so the smoke test asserts opt-out wiring). */
	readonly pollLoop: UpdatePollLoop;
	/** The status page server (exposed so the smoke test asserts it started). */
	readonly statusPage: StatusPageServer;
	/** The resolved opt-out (exposed so the smoke test asserts precedence). */
	readonly optOut: ResolvedOptOut;
	/** The remediation ladder (exposed so the smoke test confirms rungs 1/2/3 + escalate). */
	readonly ladder: RemediationLadder;
}

/**
 * Build the full production HiveDoctor assembly. Every collaborator is constructed here and
 * wired together; the result starts the watch loop, the auto-update poll loop, and the
 * status page, all fail-soft. Returns a handle exposing the wired pieces for the smoke test.
 */
export function createHiveDoctor(options: CreateHiveDoctorOptions = {}): HiveDoctor {
	const env = options.env ?? process.env;
	const config = options.config ?? resolveConfig(env);
	const logger = options.logger ?? createLogger({ level: options.logLevel ?? "info" });
	const clock = options.clock ?? createRealClock();
	const deviceId = options.deviceId ?? "unknown-device";
	const runner = options.runner ?? createExecFileRunner();

	// Durable state + incident log + install lock, all bound to the workspace dir.
	const stateStore: StateStore = createStateStore({ workspaceDir: config.workspaceDir, logger });
	const incidents = createIncidentLog({ workspaceDir: config.workspaceDir, logger });
	const installLock = createInstallLock({ workspaceDir: config.workspaceDir, logger });

	// The needs-attention store (064g) - the dashboard read seam + incident append.
	const needsAttention: NeedsAttentionStore = createNeedsAttentionStore({
		workspaceDir: config.workspaceDir,
		incidentLog: incidents,
		logger,
	});

	// Probe + version reads (injected so the assembly is hermetic in tests).
	const probe = options.probe ?? (() => probeHealth({ healthUrl: config.healthUrl, timeoutMs: config.probeTimeoutMs }));
	const readInstalledVersion = (): Promise<string | null> =>
		readDaemonVersion({ healthUrl: config.healthUrl, timeoutMs: config.probeTimeoutMs });
	const isHealthy = async (): Promise<boolean> => (await probe()).kind === "ok";

	// Restart: 064b/064h owns the real OS restart; default to a logged no-op that reports it
	// could not act, so the give-up path still escalates rather than silently "succeeding".
	const restart: RestartFn =
		options.restart ??
		(async (): Promise<boolean> => {
			logger.warn("compose.restart_no_os_service");
			return false;
		});

	// ── The remediation ladder with rungs 1/2/3 REGISTERED for production ──────────
	let lastRestartAt: number | null = null;
	const restartRung = createRestartRung({
		restart,
		readDaemonPid: async () => null, // 064b owns the PID/lock read; null = "no lock observed".
		isHealthy,
		cooldownMs: config.restartCooldownMs,
		clock,
		lastRestartAt: () => lastRestartAt,
		markRestarted: (at: number) => {
			lastRestartAt = at;
		},
	});
	// Resolve the blessed version from the blessed channel at remediation time, fail-soft: a
	// non-ok channel (unreachable until B-3 ships the CDN object) yields "" so the reinstall
	// rung degrades its verify gracefully and still proceeds (it never throws or blocks).
	const resolveBlessedVersion = async (): Promise<string> => {
		const result = await fetchBlessedVersion(options.blessedChannel);
		return result.ok ? result.manifest.version : "";
	};
	const reinstallRung = createReinstallRung({
		runner,
		installLock,
		blessedVersion: options.blessedVersion ?? "",
		resolveBlessedVersion,
		readInstalledVersion,
	});
	const uninstallRung = createUninstallHivemindRung({
		runner,
		detectHivemind: createNpmHivemindDetector(runner),
		workspaceDir: config.workspaceDir,
	});

	// The escalation hook (064c -> 064g): record locally AND emit to the hosted sink, both
	// fail-soft. This is the give-up surface the ladder calls when it cannot heal.
	const hostedEscalation: EscalationHook =
		options.hostedEscalation ??
		(async (record): Promise<void> => {
			const daemonVersion = (await readInstalledVersion()) ?? "unknown";
			await emitEscalationToHostedSink({
				escalation: record,
				deviceId,
				hivedoctorVersion: HIVEDOCTOR_VERSION,
				daemonVersion,
				logger,
			});
		});
	const escalationHook: EscalationHook = async (record): Promise<void> => {
		// Local needs-attention store first (the dashboard read seam), then the hosted sink.
		needsAttention.record(record);
		await hostedEscalation(record);
	};

	const ladder = createRemediationLadder({
		rungs: [restartRung, reinstallRung, uninstallRung],
		restartGiveUpThreshold: config.restartGiveUpThreshold,
		logger,
		escalationHook,
	});

	const backoff = createBackoff({ floorMs: config.backoffFloorMs, ceilingMs: config.backoffCeilingMs });

	const supervisor = createSupervisor({
		probe,
		ladder,
		backoff,
		stateStore,
		incidents,
		logger,
		clock,
		probeIntervalMs: config.probeIntervalMs,
	});

	// ── Auto-update poll loop (064e), respecting the resolved opt-out precedence ───
	const optOut = resolveOptOut({
		cliNoAutoUpdate: options.cliNoAutoUpdate ?? false,
		env,
		// Wave-0 state.json has no auto-update toggle/pin fields yet; read defensively as absent.
		stateAutoUpdateDisabled: undefined,
		statePinnedVersion: undefined,
	});

	const updateEngine: UpdateEngine =
		options.updateEngine ??
		createUpdateEngine({
			runner,
			installLock,
			readLatestVersion: createRegistryLatestReader({ pkg: PRIMARY_PACKAGE }),
			readInstalledVersion,
			restartDaemon: async () => {
				await restart();
			},
			verifyHealthy: isHealthy,
			optOut: {
				autoUpdateDisabled: optOut.autoUpdateDisabled,
				...(optOut.pinnedVersion !== undefined ? { pinnedVersion: optOut.pinnedVersion } : {}),
			},
			deviceId,
			logger,
		});

	const pollLoop = createUpdatePollLoop({
		engine: updateEngine,
		logger,
		clock,
		autoUpdateDisabled: optOut.autoUpdateDisabled,
	});

	// ── Local status page (064g) on the loopback comfort port ─────────────────────
	const statusPage = createStatusPageServer({
		port: options.statusPagePort ?? DEFAULT_STATUS_PAGE_PORT,
		state: {
			health: () => {
				const s = stateStore.read();
				const h = s.lastKnownHealth;
				return h === "ok" || h === "degraded" || h === "unreachable" ? h : "unknown";
			},
			escalation: () => needsAttention.read(),
		},
		logger,
	});

	let uninstallCrashNet: (() => void) | null = null;
	let running = false;
	let supervisorRun: Promise<void> | null = null;
	let pollRun: Promise<void> | null = null;

	return {
		supervisor,
		pollLoop,
		statusPage,
		optOut,
		ladder,

		async start(): Promise<void> {
			if (running) return;
			running = true;
			// The crash net first - so anything thrown during wiring/boot is caught (parent AC-8).
			uninstallCrashNet = installCrashNet(logger);
			logger.info("compose.start", { autoUpdateDisabled: optOut.autoUpdateDisabled });

			// Status page is best-effort: a bind failure is swallowed inside start() already.
			try {
				statusPage.start();
			} catch (error) {
				logger.warn("compose.status_page_start_failed", {
					reason: error instanceof Error ? error.message : "unknown",
				});
			}

			// Arm the loops. Each loop's start() resolves only when stopped, so do NOT await them
			// here - hold the promises and let stop() resolve them. A disabled poll loop is a no-op.
			supervisorRun = supervisor.start();
			pollRun = pollLoop.start();
			// Surface (but never rethrow) a loop that rejected unexpectedly.
			void supervisorRun.catch((error: unknown) => {
				logger.error("compose.supervisor_loop_threw", {
					reason: error instanceof Error ? error.message : "unknown",
				});
			});
			void pollRun.catch((error: unknown) => {
				logger.error("compose.poll_loop_threw", {
					reason: error instanceof Error ? error.message : "unknown",
				});
			});
		},

		async stop(): Promise<void> {
			if (!running) return;
			running = false;
			logger.info("compose.stop");
			supervisor.stop();
			pollLoop.stop();
			try {
				statusPage.stop();
			} catch (error) {
				logger.warn("compose.status_page_stop_failed", {
					reason: error instanceof Error ? error.message : "unknown",
				});
			}
			// Let the loops unwind their final iteration.
			try {
				await Promise.allSettled([supervisorRun ?? Promise.resolve(), pollRun ?? Promise.resolve()]);
			} catch {
				// allSettled never rejects; this catch is belt-and-suspenders.
			}
			supervisorRun = null;
			pollRun = null;
			if (uninstallCrashNet !== null) {
				uninstallCrashNet();
				uninstallCrashNet = null;
			}
		},
	};
}
