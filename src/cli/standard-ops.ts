import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { HoneycombStandardOps, StandardOperationResult } from "../commands/standard-interface.js";
import type { DaemonClient } from "../commands/contracts.js";
import type { DaemonLifecycle } from "../commands/daemon.js";
import {
	doctorRegistryPath,
	HONEYCOMB_REGISTRY_NAME,
	registerHoneycombWithDoctor,
} from "../daemon/runtime/telemetry/fleet-registry.js";
import { HONEYCOMB_VERSION } from "../shared/constants.js";
import { honeycombStateDir } from "../shared/fleet-root.js";
import {
	createDaemonServiceController,
	serviceManagerForPlatform,
	type DaemonServiceController,
	type ServiceManager,
	type ServiceSpec,
} from "./daemon-service.js";

const execFileAsync = promisify(execFile);
const registrySchema = z
	.object({ daemons: z.array(z.object({ name: z.string() }).passthrough()).default([]) })
	.passthrough();
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const npmListSchema = z.object({
	dependencies: z.record(z.string(), z.object({ version: versionSchema })).default({}),
});

interface NpmInvocation {
	readonly file: string;
	readonly argvPrefix: readonly string[];
}

/** Resolve npm without a shell; Windows requires npm-cli.js because `.cmd` shims need shell parsing. */
export function resolveNpmInvocation(
	execPath = process.execPath,
	platform = process.platform,
	exists: (path: string) => boolean = existsSync,
): NpmInvocation {
	const executableDir = dirname(execPath);
	const candidates = [
		join(executableDir, "node_modules", "npm", "bin", "npm-cli.js"),
		resolve(executableDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
		resolve(executableDir, "..", "node_modules", "npm", "bin", "npm-cli.js"),
	];
	const npmCli = candidates.find(exists);
	if (npmCli !== undefined) return { file: execPath, argvPrefix: [npmCli] };
	if (platform !== "win32") return { file: "npm", argvPrefix: [] };
	throw new Error("Could not locate npm-cli.js beside the active Node.js runtime.");
}

export type NpmRunner = (args: readonly string[]) => Promise<string>;

async function npm(args: readonly string[]): Promise<string> {
	const invocation = resolveNpmInvocation();
	const { stdout } = await execFileAsync(invocation.file, [...invocation.argvPrefix, ...args], {
		windowsHide: true,
		timeout: 120_000,
	});
	return stdout.trim();
}

async function globallyInstalledVersion(runNpm: NpmRunner): Promise<string> {
	const raw = await runNpm(["list", "--global", "@legioncodeinc/honeycomb", "--depth=0", "--json"]);
	const parsed = npmListSchema.parse(JSON.parse(raw));
	const installed = parsed.dependencies["@legioncodeinc/honeycomb"]?.version;
	if (installed === undefined) throw new Error("npm did not report an installed Honeycomb version.");
	return installed;
}

async function waitHealthy(daemon: DaemonClient, attempts = 100): Promise<boolean> {
	for (let i = 0; i < attempts; i++) {
		if (await daemon.ping()) return true;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	return false;
}

export interface HoneycombUpdateDeps {
	readonly daemon: DaemonClient;
	readonly isServiceInstalled: () => Promise<boolean>;
	readonly restartService: () => Promise<StandardOperationResult>;
	readonly runNpm?: NpmRunner;
	readonly healthAttempts?: number;
}

/** Update through npm's fixed argv and verify both the target and any required rollback end-to-end. */
export async function updateHoneycomb(checkOnly: boolean, deps: HoneycombUpdateDeps): Promise<StandardOperationResult> {
	const runNpm = deps.runNpm ?? npm;
	if (!(await deps.isServiceInstalled())) {
		return {
			ok: false,
			message: "Honeycomb update requires an installed OS service; run `honeycomb service-install`.",
		};
	}
	const target = versionSchema.parse(
		await runNpm(["view", "@legioncodeinc/honeycomb", "version", "--json"]).then((raw) => JSON.parse(raw)),
	);
	if (checkOnly || target === HONEYCOMB_VERSION) {
		return {
			ok: true,
			changed: false,
			message:
				target === HONEYCOMB_VERSION
					? `Honeycomb is current at v${HONEYCOMB_VERSION}.`
					: `Honeycomb v${target} is available (installed v${HONEYCOMB_VERSION}).`,
			details: { fromVersion: HONEYCOMB_VERSION, toVersion: target, available: target !== HONEYCOMB_VERSION },
		};
	}
	let healthy = false;
	try {
		await runNpm(["install", "--global", `@legioncodeinc/honeycomb@${target}`]);
		const targetInstalled = (await globallyInstalledVersion(runNpm)) === target;
		const restarted = targetInstalled ? await deps.restartService() : { ok: false };
		healthy = restarted.ok && (await waitHealthy(deps.daemon, deps.healthAttempts));
	} catch {
		// An npm/list/restart verification failure may occur after npm has already replaced files.
		// Treat every such failure as potentially partial and drive the same verified rollback below.
		healthy = false;
	}
	if (healthy) {
		return {
			ok: true,
			changed: true,
			message: `Honeycomb updated from v${HONEYCOMB_VERSION} to v${target}.`,
			details: { fromVersion: HONEYCOMB_VERSION, toVersion: target },
		};
	}

	let rollbackVerified = false;
	try {
		await runNpm(["install", "--global", `@legioncodeinc/honeycomb@${HONEYCOMB_VERSION}`]);
		const restoredVersion = (await globallyInstalledVersion(runNpm)) === HONEYCOMB_VERSION;
		const rollbackRestarted = restoredVersion ? await deps.restartService() : { ok: false };
		rollbackVerified = rollbackRestarted.ok && (await waitHealthy(deps.daemon, deps.healthAttempts));
	} catch {
		rollbackVerified = false;
	}
	return rollbackVerified
		? {
				ok: false,
				message: `Update to v${target} failed health verification; Honeycomb was rolled back to v${HONEYCOMB_VERSION} and verified healthy.`,
				details: { fromVersion: HONEYCOMB_VERSION, toVersion: target, rolledBack: true },
			}
		: {
				ok: false,
				message: `Update to v${target} failed and rollback to v${HONEYCOMB_VERSION} could not be verified. Manual recovery is required.`,
				details: { fromVersion: HONEYCOMB_VERSION, toVersion: target, rolledBack: false },
			};
}

export function registrationExists(path = doctorRegistryPath()): boolean {
	if (!existsSync(path)) return false;
	const parsed = registrySchema.parse(JSON.parse(readFileSync(path, "utf8")));
	return parsed.daemons.some((entry) => entry.name === HONEYCOMB_REGISTRY_NAME);
}

export interface StandardOpsOptions {
	readonly manager?: ServiceManager | null;
	readonly controllerFor?: (manager: ServiceManager) => DaemonServiceController;
	readonly healthAttempts?: number;
	readonly stopAttempts?: number;
	readonly serviceStateAttempts?: number;
	readonly runNpm?: NpmRunner;
}

export function buildHoneycombStandardOps(
	daemon: DaemonClient,
	lifecycle: DaemonLifecycle,
	serviceSpec: ServiceSpec,
	options: StandardOpsOptions = {},
): HoneycombStandardOps {
	const manager = options.manager !== undefined ? options.manager : serviceManagerForPlatform();
	const controllerFor = options.controllerFor ?? createDaemonServiceController;
	function serviceController(): DaemonServiceController {
		if (manager === null) throw new Error("No supported OS service manager is available on this platform.");
		return controllerFor(manager);
	}
	async function isServiceInstalled(): Promise<boolean> {
		return serviceController().isRegistered(serviceSpec);
	}
	async function waitForServiceRunning(controller: DaemonServiceController): Promise<boolean> {
		// Health alone cannot prove the installed manager owns the responder; an absent identity/state
		// probe therefore fails closed instead of accepting a detached or unrelated loopback process.
		if (controller.isRunning === undefined) return false;
		const attempts = options.serviceStateAttempts ?? 20;
		for (let attempt = 0; attempt < attempts; attempt++) {
			if (controller.isRunning(serviceSpec)) return true;
			if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return false;
	}
	async function waitForDaemonStopped(): Promise<boolean> {
		const attempts = options.stopAttempts ?? 100;
		for (let attempt = 0; attempt < attempts; attempt++) {
			if (!(await lifecycle.status()).running) return true;
			if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 150));
		}
		return false;
	}
	async function requireInstalled(command: string): Promise<DaemonServiceController | StandardOperationResult> {
		const controller = serviceController();
		if (!controller.isRegistered(serviceSpec))
			return {
				ok: false,
				message: `${command}: Honeycomb's OS service is not installed; run \`honeycomb service-install\`.`,
			};
		return controller;
	}
	async function restartService(): Promise<StandardOperationResult> {
		const installed = await requireInstalled("restart");
		if (!("manager" in installed)) return installed;
		const result = installed.restart(serviceSpec);
		if (!result.ok) return { ok: false, message: "Honeycomb's OS service manager rejected restart." };
		const healthy = await waitHealthy(daemon, options.healthAttempts);
		return healthy
			? { ok: true, changed: true, message: "Honeycomb restarted through its OS service and passed health." }
			: { ok: false, message: "Honeycomb's OS service restarted but did not pass health within the timeout." };
	}
	return {
		configPath: honeycombStateDir(),
		logPath: serviceSpec.logPath ?? join(honeycombStateDir(), "service.log"),
		async start(): Promise<StandardOperationResult> {
			const installed = await requireInstalled("start");
			if (!("manager" in installed)) return installed;
			if (await daemon.ping()) return { ok: true, changed: false, message: "Honeycomb is already running." };
			const result = installed.restart(serviceSpec);
			if (!result.ok) return { ok: false, message: "Honeycomb's OS service manager rejected start." };
			return (await waitHealthy(daemon, options.healthAttempts))
				? { ok: true, changed: true, message: "Honeycomb started through its installed OS service." }
				: { ok: false, message: "Honeycomb's OS service did not become healthy within the start timeout." };
		},
		async stop(): Promise<StandardOperationResult> {
			const installed = await requireInstalled("stop");
			if (!("manager" in installed)) return installed;
			if (!(await lifecycle.status()).running)
				return { ok: true, changed: false, message: "Honeycomb is already stopped." };
			const result = installed.stop(serviceSpec);
			if (!result.ok) return { ok: false, message: "Honeycomb's OS service manager rejected stop." };
			return (await waitForDaemonStopped())
				? { ok: true, changed: true, message: "Honeycomb stopped through its installed OS service." }
				: { ok: false, message: "Honeycomb did not stop within the bounded timeout." };
		},
		async restart(): Promise<StandardOperationResult> {
			return restartService();
		},
		isServiceInstalled,
		async serviceInstall(): Promise<StandardOperationResult> {
			const controller = serviceController();
			mkdirSync(honeycombStateDir(), { recursive: true });
			const existed = controller.isRegistered(serviceSpec);
			controller.register(serviceSpec);
			if (!(await waitForServiceRunning(controller)))
				return {
					ok: false,
					message: `Honeycomb service was registered with ${controller.manager}, but the manager reports it is not running.`,
				};
			const healthy = await waitHealthy(daemon, options.healthAttempts);
			return healthy
				? {
						ok: true,
						changed: !existed,
						message: existed
							? `Honeycomb service reconciled with ${controller.manager}.`
							: `Honeycomb service installed with ${controller.manager}.`,
						details: { manager: controller.manager },
					}
				: {
						ok: false,
						message: `Honeycomb service was registered with ${controller.manager}, but did not become healthy.`,
					};
		},
		async serviceUninstall(): Promise<StandardOperationResult> {
			const controller = serviceController();
			const existed = controller.isRegistered(serviceSpec);
			controller.unregister(serviceSpec);
			if (!(await waitForDaemonStopped()))
				return {
					ok: false,
					message: `Honeycomb service removal from ${controller.manager} could not verify that the daemon stopped.`,
				};
			return {
				ok: true,
				changed: existed,
				message: existed
					? `Honeycomb service removed from ${controller.manager}; product state and registration were preserved.`
					: "Honeycomb service is already absent.",
			};
		},
		async isRegistered(): Promise<boolean> {
			return registrationExists();
		},
		async register(): Promise<StandardOperationResult> {
			const existed = registrationExists();
			const result = registerHoneycombWithDoctor();
			return {
				ok: true,
				changed: !existed,
				message: existed ? "Honeycomb's Doctor registration was reconciled." : "Honeycomb registered with Doctor.",
				details: { registryPath: result.registryPath },
			};
		},
		async update(checkOnly: boolean): Promise<StandardOperationResult> {
			return updateHoneycomb(checkOnly, {
				daemon,
				isServiceInstalled,
				restartService,
				...(options.runNpm !== undefined ? { runNpm: options.runNpm } : {}),
				...(options.healthAttempts !== undefined ? { healthAttempts: options.healthAttempts } : {}),
			});
		},
	};
}
