/**
 * The `hivedoctor` CLI entry point (PRD-064f - the bin target).
 *
 * Builds the PRODUCTION {@link CliContext} - real stdout/stderr, a readline confirm
 * prompt, and live injected deps wired from the resolved config + the same primitives the
 * composition root uses - then dispatches one invocation and exits with the returned code.
 *
 * The heavy assembly (probe, ladder, update engine) is constructed here lazily for the CLI
 * surface; the long-running watchdog assembly lives in src/compose. Keeping the CLI's deps
 * here (rather than spinning the whole supervisor) means `status`/`diagnose` are cheap and
 * work with the daemon down (AC-064f.6).
 *
 * Built-ins only: node:readline/promises for the confirm prompt, node:process for argv +
 * streams. The `self-update` action is the SOLE path wired to HiveDoctor's own package.
 */

import { createInterface } from "node:readline/promises";

import { createHiveDoctor } from "../compose/index.js";
import { resolveConfig } from "../config.js";
import { resolveDeviceId } from "../device-id.js";
import { probeHealth } from "../health-probe.js";
import { createInstallLock } from "../install-lock.js";
import { createLogger } from "../logger.js";
import {
	createRemediationLadder,
	createReinstallRung,
	createRestartRung,
	createUninstallHivemindRung,
	createNpmHivemindDetector,
	createExecFileRunner,
} from "../remediation.js";
import { createServiceModule, serviceStatus } from "../service/index.js";
import { createStateStore } from "../state.js";
import {
	createInstalledPackageVersionReader,
	createRegistryLatestReader,
	createUpdateEngine,
	PRIMARY_PACKAGE,
} from "../update/index.js";
import { HIVEDOCTOR_VERSION } from "../version.js";
import { parseArgs, hasFlag } from "./arg-parse.js";
import { createColors } from "./colors.js";
import { readDaemonVersion } from "./daemon-version.js";
import { dispatch } from "./dispatch.js";
import { createIncidentsTail } from "./incidents-tail.js";
import { resolveOptOut } from "./opt-out.js";
import { createSelfUpdate } from "./self-update.js";
import { createUpdateActions } from "./update-actions.js";
import type { CliContext, ConfirmFn, OutputSink } from "./context.js";
import type { HealthClassification } from "../health-probe.js";
import type { RungContext } from "../remediation.js";

/** The production output sink: writes to the real stdout/stderr. */
function realOutputSink(): OutputSink {
	return {
		out(text: string): void {
			process.stdout.write(`${text}\n`);
		},
		err(text: string): void {
			process.stderr.write(`${text}\n`);
		},
	};
}

/** A readline-backed confirm prompt; treats a non-interactive stdin as "no". */
function realConfirm(): ConfirmFn {
	return async (question: string): Promise<boolean> => {
		// A non-TTY stdin (piped/CI) can never confirm a destructive action: default to no.
		if (!process.stdin.isTTY) return false;
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
			return answer === "y" || answer === "yes";
		} finally {
			rl.close();
		}
	};
}

/** Build the production {@link CliContext}. Lazily wires the deps the commands need. */
export function buildCliContext(argv: readonly string[]): CliContext {
	const env = process.env;
	const config = resolveConfig(env);
	const logger = createLogger({ level: "warn" }); // The CLI is quiet unless something is wrong.
	const colors = createColors();
	const runner = createExecFileRunner();

	const stateStore = createStateStore({ workspaceDir: config.workspaceDir, logger });
	const installLock = createInstallLock({ workspaceDir: config.workspaceDir, logger });

	// The SHARED per-install device id (PRD-033/064d): the daemon and HiveDoctor read/mint the
	// same ~/.honeycomb/device.json so every telemetry stream correlates to one install.
	// resolveDeviceId never throws; the try/catch keeps "unknown-device" as the last-resort net.
	let deviceId = "unknown-device";
	try {
		deviceId = resolveDeviceId();
	} catch {
		// Impossible (resolveDeviceId is defensive); the sentinel keeps the CLI build total.
	}

	const probe = (): Promise<HealthClassification> =>
		probeHealth({ healthUrl: config.healthUrl, timeoutMs: config.probeTimeoutMs });
	// The RUNNING daemon's reported version (from `/health`). This is what `status` shows, and
	// it is null when the daemon is down -- correct for a "what is running right now" display.
	const readDaemonVersionFn = (): Promise<string | null> =>
		readDaemonVersion({ healthUrl: config.healthUrl, timeoutMs: config.probeTimeoutMs });
	// The GLOBALLY-INSTALLED package version (from `npm ls -g`). This is what the update engine
	// and the reinstall rung's post-install verify mean by "installed": it is on disk even when
	// the daemon is DOWN, so auto-update/repair can still establish a rollback target then.
	const readInstalledPackageVersion = createInstalledPackageVersionReader({ runner, pkg: PRIMARY_PACKAGE });
	const isHealthy = async (): Promise<boolean> => (await probe()).kind === "ok";

	let lastRestartAt: number | null = null;
	const clock = { now: () => Date.now() };
	const restartRung = createRestartRung({
		// The CLI cannot itself restart the OS service (064b); a manual `restart` reports it.
		restart: async () => {
			logger.warn("cli.restart_no_os_service");
			return false;
		},
		readDaemonPid: async () => null,
		isHealthy,
		cooldownMs: config.restartCooldownMs,
		clock,
		lastRestartAt: () => lastRestartAt,
		markRestarted: (at: number) => {
			lastRestartAt = at;
		},
	});
	const reinstallRung = createReinstallRung({ runner, installLock, blessedVersion: "", readInstalledVersion: readInstalledPackageVersion });
	const uninstallRung = createUninstallHivemindRung({
		runner,
		detectHivemind: createNpmHivemindDetector(runner),
		workspaceDir: config.workspaceDir,
	});
	const ladder = createRemediationLadder({
		rungs: [restartRung, reinstallRung, uninstallRung],
		restartGiveUpThreshold: config.restartGiveUpThreshold,
		logger,
	});

	const optOut = resolveOptOut({ cliNoAutoUpdate: hasFlag(parseArgs(argv), "no-auto-update"), env });

	const updateEngine = createUpdateEngine({
		runner,
		installLock,
		readLatestVersion: createRegistryLatestReader({ pkg: PRIMARY_PACKAGE }),
		readInstalledVersion: readInstalledPackageVersion,
		// The CLI itself cannot restart the OS service (064b owns that); report `false` so the
		// engine's FIX-2 verify rule knows there is no supervised daemon to restart through and
		// does NOT roll back a still-unhealthy /health (it would only discard the new version).
		restartDaemon: async (): Promise<boolean> => {
			logger.warn("cli.update_restart_no_os_service");
			return false;
		},
		verifyHealthy: isHealthy,
		optOut: {
			autoUpdateDisabled: optOut.autoUpdateDisabled,
			...(optOut.pinnedVersion !== undefined ? { pinnedVersion: optOut.pinnedVersion } : {}),
		},
		deviceId,
		logger,
	});

	const selfUpdate = createSelfUpdate({ runner, logger });

	// The real 064b OS-service module. The unit it registers execs `node <this-script> run`,
	// so the exec path is the running CLI script (process.argv[1]); the bundled bin resolves to
	// the same path under a global install. Userland scope is the default; an operator opts into
	// a system unit via HIVEDOCTOR_SERVICE_SYSTEM=1 (the enterprise path, parent index ruling).
	const serviceExecPath = process.argv[1] ?? "hivedoctor";
	const preferSystemScope = (env["HIVEDOCTOR_SERVICE_SYSTEM"] ?? "") === "1";
	const serviceModule = createServiceModule({ execPath: serviceExecPath, preferSystemScope, runner, logger });

	const rungContextFor = (classification: HealthClassification): RungContext => ({ classification, logger });

	return {
		io: realOutputSink(),
		confirm: realConfirm(),
		colors,
		deps: {
			probe,
			readDaemonVersion: readDaemonVersionFn,
			hivedoctorVersion: HIVEDOCTOR_VERSION,
			ladder,
			rungContextFor,
			decideRung: (n) => ladder.decide(n),
			readConsecutiveFailures: () => stateStore.read().consecutiveRestartFailures,
			readStatusState: () => {
				const s = stateStore.read();
				return { lastHealAt: s.lastHealAt, lastKnownHealth: s.lastKnownHealth };
			},
			// serviceState is the SYNC coarse read the test harness injects directly; the production
			// wiring prefers the bounded ASYNC probe below (serviceStateAsync) so `status` reports the
			// real service-manager state. Kept "unknown" so the sync seam never claims a state it did
			// not probe (it is only used when the async probe is absent, i.e. in tests).
			serviceState: () => "unknown",
			// IRD-192 AC-5: the real OS-service-manager probe (schtasks/launchctl/systemctl is-active),
			// bounded by SERVICE_COMMAND_TIMEOUT_MS inside serviceStatus(). Never throws; resolves
			// "unknown" on a spawn error or unsupported platform, so `status` stays fast and fail-safe.
			serviceStateAsync: () => serviceStatus({ execPath: serviceExecPath, preferSystemScope, runner }),
			serviceModule,
			optOut,
			// `update --check` previews via previewUpdate() (READ-ONLY, never mutates); `update`
			// applies via runUpdateTransaction(); `self-update` is the sole own-package path.
			update: createUpdateActions(updateEngine, selfUpdate),
			tailIncidents: createIncidentsTail(config.workspaceDir),
		},
	};
}

/**
 * The long-running `run` entry the OS service execs (PRD-064b). It is NOT a return-then-exit
 * command: it builds the full watchdog assembly (compose root, 064f) and keeps the process
 * alive until the service manager sends SIGTERM/SIGINT, then stops every loop gracefully so
 * the OS records a clean shutdown rather than a crash. Resolves with an exit code only after
 * the process is asked to stop. Crash-safe: a wiring error is caught and mapped to exit 1.
 */
async function runWatchdog(argv: readonly string[]): Promise<number> {
	const cliNoAutoUpdate = hasFlag(parseArgs(argv), "no-auto-update");
	const doctor = createHiveDoctor({ cliNoAutoUpdate });
	await doctor.start();
	// Keep `run` alive even when optional referenced handles (notably the status page)
	// fail to bind and all internal loop timers are deliberately unref'ed.
	const keepAlive = setInterval(() => undefined, 60 * 60 * 1000);
	try {
		// Block until a termination signal arrives; the service manager owns the lifecycle.
		await new Promise<void>((resolve) => {
			const stop = (): void => resolve();
			process.once("SIGTERM", stop);
			process.once("SIGINT", stop);
		});
	} finally {
		clearInterval(keepAlive);
		await doctor.stop();
	}
	return 0;
}

/** Run the CLI: build the context, dispatch, resolve the exit code. Never throws. */
export async function runCli(argv: readonly string[]): Promise<number> {
	try {
		// `run` is the long-running OS-service entry (064b); it bypasses the return-then-exit
		// dispatcher and stays alive until a termination signal.
		if (argv[0] === "run") {
			return await runWatchdog(argv);
		}
		const ctx = buildCliContext(argv);
		return await dispatch(argv, ctx);
	} catch (error) {
		// Last-resort net: even a wiring error must not crash with a stack trace.
		process.stderr.write(`hivedoctor: ${error instanceof Error ? error.message : "unexpected error"}\n`);
		return 1;
	}
}
