import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, watch } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { posix, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { LogFileSystem } from "@legioncodeinc/cli-kit";
import type { HoneycombStandardOps, StandardOperationResult } from "../commands/standard-interface.js";
import type { DaemonClient } from "../commands/contracts.js";
import type { DaemonLifecycle } from "../commands/daemon.js";
import {
	doctorRegistryPath,
	HONEYCOMB_REGISTRY_NAME,
	registerHoneycombWithDoctor,
} from "../daemon/runtime/telemetry/fleet-registry.js";
import { HONEYCOMB_VERSION } from "../shared/constants.js";
import { honeycombServiceLogPath, honeycombStateDir, resolveFleetRoot } from "../shared/fleet-root.js";
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

/** Candidate construction is intentionally closed over the active runtime, never caller input. */
function trustedNpmInvocationCandidates(): readonly string[] {
	const pathApi = process.platform === "win32" ? win32 : posix;
	const executableDir = pathApi.dirname(process.execPath);
	return [
		pathApi.join(executableDir, "node_modules", "npm", "bin", "npm-cli.js"),
		pathApi.resolve(executableDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
		pathApi.resolve(executableDir, "..", "node_modules", "npm", "bin", "npm-cli.js"),
	];
}

/** Pure fail-closed selection once the trusted production probe has located npm-cli.js. */
export function selectNpmInvocation(
	execPath: string,
	platform: NodeJS.Platform,
	npmCli: string | undefined,
): NpmInvocation {
	if (npmCli !== undefined) return { file: execPath, argvPrefix: [npmCli] };
	if (platform !== "win32") return { file: "npm", argvPrefix: [] };
	throw new Error("Could not locate npm-cli.js beside the active Node.js runtime.");
}

/** Resolve npm from the active runtime only; no caller-controlled path reaches the filesystem. */
export function resolveNpmInvocation(): NpmInvocation {
	const candidates = trustedNpmInvocationCandidates();
	return selectNpmInvocation(
		process.execPath,
		process.platform,
		candidates.find((candidate) => existsSync(candidate)),
	);
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** Bind cli-kit's generic log reader to Honeycomb's two fixed product-owned paths. */
function createHoneycombLogFileSystem(): LogFileSystem {
	const root = honeycombStateDir();
	const log = honeycombServiceLogPath();
	return {
		async readFile(candidate: string): Promise<string> {
			if (candidate !== log) throw new Error("Honeycomb log reader rejected a non-product path.");
			return readFile(log, "utf8");
		},
		async realpath(candidate: string): Promise<string> {
			if (candidate === root) return realpath(root);
			if (candidate === log) return realpath(log);
			throw new Error("Honeycomb log reader rejected a non-product path.");
		},
		watch(candidate: string, onChange: () => void): { close(): void } {
			if (candidate !== log) throw new Error("Honeycomb log reader rejected a non-product path.");
			return watch(log, onChange);
		},
	};
}

async function waitHealthy(daemon: DaemonClient, attempts = 100): Promise<boolean> {
	for (let i = 0; i < attempts; i++) {
		if (await daemon.ping()) return true;
		await sleep(150);
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

/** Parse a Doctor registry document without granting the caller filesystem access. */
export function registryContainsHoneycomb(raw: string): boolean {
	const parsed = registrySchema.parse(JSON.parse(raw));
	return parsed.daemons.some((entry) => entry.name === HONEYCOMB_REGISTRY_NAME);
}

export function registrationExists(): boolean {
	const path = doctorRegistryPath();
	const expected = resolve(resolveFleetRoot(), "registry.json");
	if (resolve(path) !== expected) throw new Error("Doctor registry path escaped the fleet root.");
	if (!existsSync(path)) return false;
	return registryContainsHoneycomb(readFileSync(path, "utf8"));
}

export interface StandardOpsOptions {
	readonly manager?: ServiceManager | null;
	readonly controllerFor?: (manager: ServiceManager) => DaemonServiceController;
	readonly healthAttempts?: number;
	readonly stopAttempts?: number;
	readonly serviceStateAttempts?: number;
	readonly runNpm?: NpmRunner;
}

interface ServiceLifecycleOps {
	readonly start: HoneycombStandardOps["start"];
	readonly stop: HoneycombStandardOps["stop"];
	readonly restartService: HoneycombStandardOps["restart"];
	readonly serviceInstall: HoneycombStandardOps["serviceInstall"];
	readonly serviceUninstall: HoneycombStandardOps["serviceUninstall"];
	readonly isServiceInstalled: HoneycombStandardOps["isServiceInstalled"];
}

interface ServiceContext {
	readonly daemon: DaemonClient;
	readonly lifecycle: DaemonLifecycle;
	readonly serviceSpec: ServiceSpec;
	readonly options: StandardOpsOptions;
	readonly controller: () => DaemonServiceController;
}

function createServiceContext(
	daemon: DaemonClient,
	lifecycle: DaemonLifecycle,
	serviceSpec: ServiceSpec,
	options: StandardOpsOptions = {},
): ServiceContext {
	const manager = options.manager !== undefined ? options.manager : serviceManagerForPlatform();
	const controllerFor = options.controllerFor ?? createDaemonServiceController;
	return {
		daemon,
		lifecycle,
		serviceSpec,
		options,
		controller(): DaemonServiceController {
			if (manager === null) throw new Error("No supported OS service manager is available on this platform.");
			return controllerFor(manager);
		},
	};
}

async function waitForServiceRunning(context: ServiceContext, controller: DaemonServiceController): Promise<boolean> {
	// Health alone cannot prove the installed manager owns the responder; an absent identity/state
	// probe therefore fails closed instead of accepting a detached or unrelated loopback process.
	if (controller.isRunning === undefined) return false;
	const attempts = context.options.serviceStateAttempts ?? 20;
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (controller.isRunning(context.serviceSpec)) return true;
		if (attempt + 1 < attempts) await sleep(100);
	}
	return false;
}

async function waitForDaemonStopped(context: ServiceContext): Promise<boolean> {
	const attempts = context.options.stopAttempts ?? 100;
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (!(await context.lifecycle.status()).running) return true;
		if (attempt + 1 < attempts) await sleep(150);
	}
	return false;
}

function requireInstalled(context: ServiceContext, command: string): DaemonServiceController | StandardOperationResult {
	const controller = context.controller();
	if (!controller.isRegistered(context.serviceSpec))
		return {
			ok: false,
			message: `${command}: Honeycomb's OS service is not installed; run \`honeycomb service-install\`.`,
		};
	return controller;
}

async function restartService(context: ServiceContext): Promise<StandardOperationResult> {
	const installed = requireInstalled(context, "restart");
	if (!("manager" in installed)) return installed;
	const result = installed.restart(context.serviceSpec);
	if (!result.ok) return { ok: false, message: "Honeycomb's OS service manager rejected restart." };
	const healthy = await waitHealthy(context.daemon, context.options.healthAttempts);
	return healthy
		? { ok: true, changed: true, message: "Honeycomb restarted through its OS service and passed health." }
		: { ok: false, message: "Honeycomb's OS service restarted but did not pass health within the timeout." };
}

function createRuntimeLifecycleOps(
	context: ServiceContext,
): Pick<ServiceLifecycleOps, "start" | "stop" | "restartService"> {
	return {
		async start(): Promise<StandardOperationResult> {
			const installed = requireInstalled(context, "start");
			if (!("manager" in installed)) return installed;
			if (await context.daemon.ping()) return { ok: true, changed: false, message: "Honeycomb is already running." };
			const result = installed.restart(context.serviceSpec);
			if (!result.ok) return { ok: false, message: "Honeycomb's OS service manager rejected start." };
			return (await waitHealthy(context.daemon, context.options.healthAttempts))
				? { ok: true, changed: true, message: "Honeycomb started through its installed OS service." }
				: { ok: false, message: "Honeycomb's OS service did not become healthy within the start timeout." };
		},
		async stop(): Promise<StandardOperationResult> {
			const installed = requireInstalled(context, "stop");
			if (!("manager" in installed)) return installed;
			if (!(await context.lifecycle.status()).running)
				return { ok: true, changed: false, message: "Honeycomb is already stopped." };
			const result = installed.stop(context.serviceSpec);
			if (!result.ok) return { ok: false, message: "Honeycomb's OS service manager rejected stop." };
			return (await waitForDaemonStopped(context))
				? { ok: true, changed: true, message: "Honeycomb stopped through its installed OS service." }
				: { ok: false, message: "Honeycomb did not stop within the bounded timeout." };
		},
		restartService: () => restartService(context),
	};
}

function createServiceRegistrationOps(
	context: ServiceContext,
): Pick<ServiceLifecycleOps, "serviceInstall" | "serviceUninstall" | "isServiceInstalled"> {
	return {
		async isServiceInstalled(): Promise<boolean> {
			return context.controller().isRegistered(context.serviceSpec);
		},
		async serviceInstall(): Promise<StandardOperationResult> {
			const controller = context.controller();
			mkdirSync(honeycombStateDir(), { recursive: true });
			const existed = controller.isRegistered(context.serviceSpec);
			controller.register(context.serviceSpec);
			if (!(await waitForServiceRunning(context, controller)))
				return {
					ok: false,
					message: `Honeycomb service was registered with ${controller.manager}, but the manager reports it is not running.`,
				};
			const healthy = await waitHealthy(context.daemon, context.options.healthAttempts);
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
			const controller = context.controller();
			const existed = controller.isRegistered(context.serviceSpec);
			controller.unregister(context.serviceSpec);
			if (!(await waitForDaemonStopped(context)))
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
	};
}

function createServiceLifecycleOps(
	daemon: DaemonClient,
	lifecycle: DaemonLifecycle,
	serviceSpec: ServiceSpec,
	options: StandardOpsOptions = {},
): ServiceLifecycleOps {
	const context = createServiceContext(daemon, lifecycle, serviceSpec, options);
	return { ...createRuntimeLifecycleOps(context), ...createServiceRegistrationOps(context) };
}

/** Assemble the product-owned baseline operations from focused lifecycle, registry, and updater adapters. */
export function buildHoneycombStandardOps(
	daemon: DaemonClient,
	lifecycle: DaemonLifecycle,
	serviceSpec: ServiceSpec,
	options: StandardOpsOptions = {},
): HoneycombStandardOps {
	const service = createServiceLifecycleOps(daemon, lifecycle, serviceSpec, options);
	return {
		configPath: honeycombStateDir(),
		logPath: serviceSpec.logPath ?? honeycombServiceLogPath(),
		logFs: createHoneycombLogFileSystem(),
		start: service.start,
		stop: service.stop,
		restart: service.restartService,
		serviceInstall: service.serviceInstall,
		serviceUninstall: service.serviceUninstall,
		isServiceInstalled: service.isServiceInstalled,
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
				isServiceInstalled: service.isServiceInstalled,
				restartService: service.restartService,
				...(options.runNpm !== undefined ? { runNpm: options.runNpm } : {}),
				...(options.healthAttempts !== undefined ? { healthAttempts: options.healthAttempts } : {}),
			});
		},
	};
}
