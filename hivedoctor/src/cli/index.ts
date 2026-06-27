/**
 * The `hivedoctor` CLI entry point (PRD-063f - the bin target).
 *
 * Builds the PRODUCTION {@link CliContext} - real stdout/stderr, a readline confirm
 * prompt, and live injected deps wired from the resolved config + the same primitives the
 * composition root uses - then dispatches one invocation and exits with the returned code.
 *
 * The heavy assembly (probe, ladder, update engine) is constructed here lazily for the CLI
 * surface; the long-running watchdog assembly lives in src/compose. Keeping the CLI's deps
 * here (rather than spinning the whole supervisor) means `status`/`diagnose` are cheap and
 * work with the daemon down (AC-063f.6).
 *
 * Built-ins only: node:readline/promises for the confirm prompt, node:process for argv +
 * streams. The `self-update` action is the SOLE path wired to HiveDoctor's own package.
 */

import { createInterface } from "node:readline/promises";

import { createHiveDoctor } from "../compose/index.js";
import { resolveConfig } from "../config.js";
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
import { createServiceModule } from "../service/index.js";
import { createStateStore } from "../state.js";
import {
	createRegistryLatestReader,
	createUpdateEngine,
	outcomeOf,
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

	const probe = (): Promise<HealthClassification> =>
		probeHealth({ healthUrl: config.healthUrl, timeoutMs: config.probeTimeoutMs });
	const readInstalled = (): Promise<string | null> =>
		readDaemonVersion({ healthUrl: config.healthUrl, timeoutMs: config.probeTimeoutMs });
	const isHealthy = async (): Promise<boolean> => (await probe()).kind === "ok";

	let lastRestartAt: number | null = null;
	const clock = { now: () => Date.now() };
	const restartRung = createRestartRung({
		// The CLI cannot itself restart the OS service (063b); a manual `restart` reports it.
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
	const reinstallRung = createReinstallRung({ runner, installLock, blessedVersion: "", readInstalledVersion: readInstalled });
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
		readInstalledVersion: readInstalled,
		restartDaemon: async () => {
			logger.warn("cli.update_restart_no_os_service");
		},
		verifyHealthy: isHealthy,
		optOut: {
			autoUpdateDisabled: optOut.autoUpdateDisabled,
			...(optOut.pinnedVersion !== undefined ? { pinnedVersion: optOut.pinnedVersion } : {}),
		},
		deviceId: "unknown-device",
		logger,
	});

	const selfUpdate = createSelfUpdate({ runner, logger });

	// The real 063b OS-service module. The unit it registers execs `node <this-script> run`,
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
			readDaemonVersion: readInstalled,
			hivedoctorVersion: HIVEDOCTOR_VERSION,
			ladder,
			rungContextFor,
			decideRung: (n) => ladder.decide(n),
			readConsecutiveFailures: () => stateStore.read().consecutiveRestartFailures,
			readStatusState: () => {
				const s = stateStore.read();
				return { lastHealAt: s.lastHealAt, lastKnownHealth: s.lastKnownHealth };
			},
			// serviceState is the SYNC coarse read `status` prints; the real async probe is
			// serviceStatus() (exported from src/service), wired for 063g/063f follow-up. Kept
			// "unknown" here so a sync `status` never blocks on a shell-out.
			serviceState: () => "unknown",
			serviceModule,
			optOut,
			update: {
				checkPrimaryUpdate: async () => {
					const result = await updateEngine.runUpdateTransaction();
					// --check should not install; the engine's gate already declines when not eligible,
					// but for a clean preview we report the decision the gate would reach.
					if (result.status === "no_update") {
						return `No update: ${result.noUpdateReason ?? "not eligible"}.`;
					}
					return `Update available: ${result.fromVersion ?? "?"} -> ${result.toVersion ?? "?"} (${result.status}).`;
				},
				applyPrimaryUpdate: async () => {
					const result = await updateEngine.runUpdateTransaction();
					const outcome = outcomeOf(result.status);
					return outcome === null
						? `No update applied (${result.status}${result.noUpdateReason ? `: ${result.noUpdateReason}` : ""}).`
						: `Update ${result.status}: ${result.fromVersion ?? "?"} -> ${result.toVersion ?? "?"}.`;
				},
				selfUpdate,
			},
			tailIncidents: createIncidentsTail(config.workspaceDir),
		},
	};
}

/**
 * The long-running `run` entry the OS service execs (PRD-063b). It is NOT a return-then-exit
 * command: it builds the full watchdog assembly (compose root, 063f) and keeps the process
 * alive until the service manager sends SIGTERM/SIGINT, then stops every loop gracefully so
 * the OS records a clean shutdown rather than a crash. Resolves with an exit code only after
 * the process is asked to stop. Crash-safe: a wiring error is caught and mapped to exit 1.
 */
async function runWatchdog(argv: readonly string[]): Promise<number> {
	const cliNoAutoUpdate = hasFlag(parseArgs(argv), "no-auto-update");
	const doctor = createHiveDoctor({ cliNoAutoUpdate });
	await doctor.start();
	// Block until a termination signal arrives; the service manager owns the lifecycle.
	await new Promise<void>((resolve) => {
		const stop = (): void => resolve();
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
	});
	await doctor.stop();
	return 0;
}

/** Run the CLI: build the context, dispatch, resolve the exit code. Never throws. */
export async function runCli(argv: readonly string[]): Promise<number> {
	try {
		// `run` is the long-running OS-service entry (063b); it bypasses the return-then-exit
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
