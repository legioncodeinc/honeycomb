/**
 * The real OS-service manager (PRD-064b) - the module the CLI's `install-service` /
 * `uninstall-service` commands delegate to via the {@link ServiceModule} seam declared in
 * src/cli/service-stub.ts.
 *
 * It does the three things the stub promised would land in 064b:
 *   - installService()  : resolve the platform plan, write the unit file (when file-based),
 *                         then run the manager's install argv. Userland scope by default,
 *                         privileged fallback ordering computed in {@link resolveServicePlan}.
 *   - uninstallService(): run the manager's uninstall argv, then delete the unit file, so
 *                         the unit does not resurrect on next boot (AC-064b.5).
 *   - serviceStatus()   : run the manager's status argv and classify the result.
 *
 * Crash-safe (parent AC-8 / design principle 1): every shell-out is the injected
 * {@link CommandRunner} (execFile, no shell) which never throws; every fs call is behind the
 * injected {@link ServiceFs} and wrapped, so a permission error becomes a returned {@link ServiceResult}
 * (never a thrown stack). The whole module is hermetic: a test injects a recording runner +
 * an in-memory fs and asserts the EXACT argv + unit text without touching the OS.
 *
 * Built-ins only: the production fs uses node:fs, the runner uses node:child_process.execFile.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createExecFileRunner, type CommandRunner } from "../remediation.js";
import type { Logger } from "../logger.js";
import { silentLogger } from "../logger.js";
import type { ServiceModule, ServiceResult } from "../cli/service-stub.js";
import { installCommands, statusCommand, uninstallCommands, type ServiceCommand } from "./argv.js";
import {
	resolveServiceContext,
	resolveServicePlan,
	type ServiceEnvironment,
	type ServicePlan,
} from "./platform.js";
import { renderUnit } from "./templates.js";

/** A coarse, classified service status (what `hivedoctor status` reports). */
export type ServiceStatus = "running" | "not-running" | "unknown";

/** Per-command timeout for a service-manager shell-out (these are fast, local commands). */
const SERVICE_COMMAND_TIMEOUT_MS = 15_000;

/** The minimal filesystem surface the service module needs (injected so tests are hermetic). */
export interface ServiceFs {
	/** Create a directory (recursive). Must be idempotent (no throw if it already exists). */
	mkdirp(dir: string): void;
	/** Write a file's text content, overwriting. */
	writeFile(path: string, content: string): void;
	/** Remove a file. Must NOT throw when the file is already absent. */
	removeFile(path: string): void;
}

/** The production {@link ServiceFs} over node:fs. */
export function createNodeServiceFs(): ServiceFs {
	return {
		mkdirp(dir: string): void {
			mkdirSync(dir, { recursive: true });
		},
		writeFile(path: string, content: string): void {
			writeFileSync(path, content, { encoding: "utf8" });
		},
		removeFile(path: string): void {
			// `force: true` makes a missing file a no-op (idempotent uninstall).
			rmSync(path, { force: true });
		},
	};
}

/** Construction deps for {@link createServiceModule}. All have production defaults. */
export interface ServiceModuleDeps {
	/** The absolute path to the `hivedoctor` bin the unit execs. */
	readonly execPath: string;
	/** Opt into a system-scoped unit when privileged (enterprise path). Default false. */
	readonly preferSystemScope?: boolean;
	/** The command runner (execFile, no shell). Default: the real {@link createExecFileRunner}. */
	readonly runner?: CommandRunner;
	/** The filesystem seam. Default: the real {@link createNodeServiceFs}. */
	readonly fs?: ServiceFs;
	/** The numeric uid for launchd's `gui/<uid>` domain. Default: live uid (0 when unavailable). */
	readonly uid?: number;
	/** Override the resolved environment (tests inject a fixed platform/home/privilege). */
	readonly environment?: ServiceEnvironment;
	/** Logger (default: silent). */
	readonly logger?: Logger;
}

/** Read the live numeric uid, defaulting to 0 when the platform does not expose it. */
function liveUid(): number {
	try {
		const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
		return typeof getuid === "function" ? getuid() : 0;
	} catch {
		return 0;
	}
}

/** Human-readable scope phrase for the result line. */
function scopePhrase(plan: ServicePlan): string {
	const base = plan.scope === "user" ? "user scope" : "system scope";
	return plan.fellBackToUser ? `${base} (fell back from system - unprivileged)` : base;
}

/**
 * Run an ordered list of commands, stopping at the first hard failure. Returns the list of
 * results so the caller can build an honest message. Never throws (the runner never does).
 * A command whose failure is tolerable (e.g. `bootout` on an absent unit during reinstall)
 * is the caller's concern; here we report every result faithfully.
 */
async function runAll(
	runner: CommandRunner,
	commands: readonly ServiceCommand[],
): Promise<{ allOk: boolean; firstFailure: ServiceCommand | null }> {
	let firstFailure: ServiceCommand | null = null;
	for (const cmd of commands) {
		const result = await runner.run(cmd.command, cmd.args, { timeoutMs: SERVICE_COMMAND_TIMEOUT_MS });
		if (!result.ok && firstFailure === null) {
			firstFailure = cmd;
		}
	}
	return { allOk: firstFailure === null, firstFailure };
}

/**
 * Build the real {@link ServiceModule}. The composition root / CLI inject the resolved
 * exec path; tests inject the runner + fs + a fixed environment so nothing real runs.
 */
export function createServiceModule(deps: ServiceModuleDeps): ServiceModule {
	const runner = deps.runner ?? createExecFileRunner();
	const fs = deps.fs ?? createNodeServiceFs();
	const logger = deps.logger ?? silentLogger;
	const uid = deps.uid ?? liveUid();
	const environment =
		deps.environment ?? resolveServiceContext(deps.execPath, deps.preferSystemScope ?? false);

	/** Resolve the plan, mapping an unsupported platform to a thrown error the caller catches. */
	function plan(): ServicePlan {
		return resolveServicePlan(environment);
	}

	return {
		async install(): Promise<ServiceResult> {
			let p: ServicePlan;
			try {
				p = plan();
			} catch (error) {
				return {
					ok: false,
					message: `Could not register HiveDoctor service: ${error instanceof Error ? error.message : "unknown error"}.`,
				};
			}

			// 1) Write the unit file FIRST (when this manager is file-based). schtasks consumes the
			//    XML file too, so a non-empty unitPath OR the schtasks manager means we lay down text.
			const needsFile = p.unitPath !== "" || p.manager === "schtasks";
			let unitTarget = p.unitPath;
			if (needsFile) {
				try {
					if (p.manager === "schtasks" && unitTarget === "") {
						// Per-user task: stage the XML beside HiveDoctor's workspace so schtasks /XML can read it.
						unitTarget = `${p.home}/.honeycomb/hivedoctor/hivedoctor-task.xml`;
					}
					fs.mkdirp(dirname(unitTarget));
					fs.writeFile(unitTarget, renderUnit(p));
				} catch (error) {
					return {
						ok: false,
						message: `Could not write the HiveDoctor unit file at ${unitTarget}: ${error instanceof Error ? error.message : "unknown error"}.`,
					};
				}
			}

			// 2) Run the manager's install argv. For schtasks the staged file path is the unit path.
			const planForArgv: ServicePlan = unitTarget === p.unitPath ? p : { ...p, unitPath: unitTarget };
			const { allOk, firstFailure } = await runAll(runner, installCommands(planForArgv, uid));
			if (!allOk) {
				// A manager-command failure (e.g. schtasks /Create rejecting invalid XML) is NOT a
				// successful install: surface ok:false so the CLI maps it to a non-zero exit (IRD-192 AC-6).
				logger.warn("service.install_command_failed", { command: firstFailure?.command });
				return {
					ok: false,
					message: `Registered the HiveDoctor unit but a service-manager command failed (${firstFailure?.command ?? "unknown"}). It will start at next login/boot; run \`hivedoctor status\` to check.`,
				};
			}

			logger.info("service.installed", { manager: p.manager, scope: p.scope });
			return {
				ok: true,
				message: `HiveDoctor registered as a ${p.manager} service (${scopePhrase(p)}) and started. It will restart on crash and start on boot.`,
			};
		},

		async uninstall(): Promise<ServiceResult> {
			let p: ServicePlan;
			try {
				p = plan();
			} catch (error) {
				return {
					ok: false,
					message: `Could not unregister HiveDoctor service: ${error instanceof Error ? error.message : "unknown error"}.`,
				};
			}

			// 1) Stop + deregister via the manager (idempotent - a missing unit is tolerated).
			const { allOk, firstFailure } = await runAll(runner, uninstallCommands(p, uid));

			// 2) Delete the unit file so it cannot resurrect on next boot (AC-064b.5). For schtasks the
			//    staged XML lives beside the workspace; remove that too.
			const stagedXml = p.manager === "schtasks" ? `${p.home}/.honeycomb/hivedoctor/hivedoctor-task.xml` : "";
			try {
				if (p.unitPath !== "") fs.removeFile(p.unitPath);
				if (stagedXml !== "") fs.removeFile(stagedXml);
			} catch (error) {
				logger.warn("service.unit_remove_failed", {
					reason: error instanceof Error ? error.message : "unknown",
				});
			}

			if (!allOk) {
				logger.warn("service.uninstall_command_failed", { command: firstFailure?.command });
				return {
					ok: false,
					message: `Removed the HiveDoctor unit file; a deregister command (${firstFailure?.command ?? "unknown"}) reported an error (often because it was already gone).`,
				};
			}
			logger.info("service.uninstalled", { manager: p.manager, scope: p.scope });
			return {
				ok: true,
				message: `HiveDoctor service unregistered (${p.manager}, ${scopePhrase(p)}). It will not start on next boot.`,
			};
		},
	};
}

/**
 * Probe the current service status (used by `hivedoctor status` once 064b is wired). Returns
 * a coarse {@link ServiceStatus}; never throws. Exposed separately because the CLI's
 * `serviceState` dep reads status without the full install/uninstall surface.
 */
export async function serviceStatus(deps: ServiceModuleDeps): Promise<ServiceStatus> {
	const runner = deps.runner ?? createExecFileRunner();
	const uid = deps.uid ?? liveUid();
	const environment =
		deps.environment ?? resolveServiceContext(deps.execPath, deps.preferSystemScope ?? false);
	let p: ServicePlan;
	try {
		p = resolveServicePlan(environment);
	} catch {
		return "unknown";
	}
	const cmd = statusCommand(p, uid);
	const result = await runner.run(cmd.command, cmd.args, { timeoutMs: SERVICE_COMMAND_TIMEOUT_MS });
	if (!result.ok) {
		// systemd `is-active` exits non-zero when inactive; schtasks/sc/launchctl non-zero when absent.
		// Treat a clean "inactive"/"not found" as not-running; an actual spawn error as unknown.
		if (result.detail !== undefined && /ENOENT|spawn/i.test(result.detail)) return "unknown";
		return "not-running";
	}
	// systemd is-active prints "active"; launchctl print / schtasks query / sc query a populated block.
	if (p.manager === "systemd") {
		return /\bactive\b/.test(result.stdout) && !/inactive|failed/.test(result.stdout) ? "running" : "not-running";
	}
	return "running";
}

export { resolveServicePlan, resolveServiceContext } from "./platform.js";
export type { ServicePlan, ServiceEnvironment } from "./platform.js";
