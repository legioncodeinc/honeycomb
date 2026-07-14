import { watch } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import {
	formatStatus,
	parseLogTailOptions,
	redactLogSecrets,
	statusToJson,
	tailProductLog,
	type ServiceStatus,
} from "@legioncodeinc/cli-kit";
import { HONEYCOMB_VERSION } from "../shared/constants.js";
import type { CommandDeps, CommandResult, OutputSink } from "./contracts.js";
import type { DaemonLifecycle } from "./daemon.js";

export interface StandardOperationResult {
	readonly ok: boolean;
	readonly message: string;
	readonly changed?: boolean;
	readonly details?: Readonly<Record<string, unknown>>;
}

/** Product-owned effects required by the shared baseline but assembled outside `src/commands`. */
export interface HoneycombStandardOps {
	start(): Promise<StandardOperationResult>;
	stop(): Promise<StandardOperationResult>;
	restart(): Promise<StandardOperationResult>;
	serviceInstall(): Promise<StandardOperationResult>;
	serviceUninstall(): Promise<StandardOperationResult>;
	isServiceInstalled(): Promise<boolean>;
	register(): Promise<StandardOperationResult>;
	isRegistered(): Promise<boolean>;
	update(checkOnly: boolean): Promise<StandardOperationResult>;
	readonly configPath: string;
	readonly logPath: string;
}

export interface StandardCommandDeps extends CommandDeps {
	readonly lifecycle?: DaemonLifecycle;
	readonly standard?: HoneycombStandardOps;
}

function emit(
	out: OutputSink,
	err: OutputSink,
	json: boolean,
	command: string,
	result: StandardOperationResult,
): CommandResult {
	const safeMessage = redactLogSecrets(result.message);
	if (json) {
		out(
			JSON.stringify({
				...(result.details ?? {}),
				product: "honeycomb",
				command,
				ok: result.ok,
				message: safeMessage,
			}),
		);
	} else {
		(result.ok ? out : err)(safeMessage);
	}
	return { exitCode: result.ok ? 0 : 1 };
}

async function lifecycleCommand(
	command: "start" | "stop" | "restart",
	deps: StandardCommandDeps,
): Promise<StandardOperationResult> {
	const standard = deps.standard;
	if (standard === undefined) return { ok: false, message: `${command}: service adapter is unavailable.` };
	if (command === "start") return standard.start();
	if (command === "stop") return standard.stop();
	return standard.restart();
}

async function statusResult(deps: StandardCommandDeps): Promise<ServiceStatus | null> {
	if (deps.standard === undefined || deps.lifecycle === undefined) return null;
	const [serviceInstalled, registered, process, healthy] = await Promise.all([
		deps.standard.isServiceInstalled(),
		deps.standard.isRegistered(),
		deps.lifecycle.status(),
		deps.daemon.ping(),
	]);
	return {
		product: "HONEYCOMB",
		version: HONEYCOMB_VERSION,
		installation: serviceInstalled ? "installed" : "not-installed",
		process: {
			state: process.running ? "running" : "stopped",
			...(process.pid !== undefined ? { pid: process.pid } : {}),
		},
		health: {
			state: healthy ? "healthy" : process.running ? "unhealthy" : "unknown",
			endpoint: "http://127.0.0.1:3850/health",
			result: healthy ? "reachable" : "not reachable",
		},
		registration: registered ? "registered" : "unregistered",
		paths: { config: deps.standard.configPath, logs: deps.standard.logPath },
		details: { serviceManager: process.serviceManager ?? null, port: process.port },
	};
}

async function logsCommand(argv: readonly string[], json: boolean, deps: StandardCommandDeps): Promise<CommandResult> {
	const out = deps.out ?? ((line: string): void => console.log(line));
	const err = deps.err ?? ((line: string): void => console.error(line));
	if (deps.standard === undefined)
		return emit(out, err, json, "logs", { ok: false, message: "logs: product log source is unavailable." });
	const parsed = parseLogTailOptions(argv);
	if (!parsed.ok) return { ...emit(out, err, json, "logs", { ok: false, message: parsed.error }), exitCode: 2 };
	const source = {
		productId: "honeycomb",
		serviceId: "honeycomb",
		root: deps.standard.configPath,
		path: deps.standard.logPath,
	};
	const lines: string[] = [];
	const controller = new AbortController();
	const onSignal = (): void => controller.abort();
	process.once("SIGINT", onSignal);
	try {
		const result = await tailProductLog({
			productId: "honeycomb",
			serviceId: "honeycomb",
			source,
			options: parsed.options,
			fs: { readFile: (path) => readFile(path, "utf8"), realpath, watch: (path, cb) => watch(path, cb) },
			write: (line) => {
				const safe = redactLogSecrets(line);
				if (json) lines.push(safe);
				else out(safe);
			},
			signal: controller.signal,
		});
		if (!result.ok) return emit(out, err, json, "logs", { ok: false, message: result.error });
		if (json)
			out(JSON.stringify({ product: "honeycomb", command: "logs", ok: true, message: "Honeycomb logs read.", lines }));
		return { exitCode: 0 };
	} finally {
		process.removeListener("SIGINT", onSignal);
	}
}

export async function runStandardCommand(
	command: string,
	argv: readonly string[],
	json: boolean,
	deps: StandardCommandDeps,
): Promise<CommandResult> {
	const out = deps.out ?? ((line: string): void => console.log(line));
	const err = deps.err ?? ((line: string): void => console.error(line));
	try {
		const allowed = command === "update" ? new Set(["--check"]) : new Set<string>();
		const invalid = command === "logs" ? undefined : argv.find((token) => !allowed.has(token));
		if (invalid !== undefined)
			return {
				...emit(out, err, json, command, { ok: false, message: `${command}: unknown option '${invalid}'.` }),
				exitCode: 2,
			};
		if (command === "start" || command === "stop" || command === "restart")
			return emit(out, err, json, command, await lifecycleCommand(command, deps));
		if (command === "service-install")
			return emit(
				out,
				err,
				json,
				command,
				deps.standard === undefined
					? { ok: false, message: "service-install: service adapter is unavailable." }
					: await deps.standard.serviceInstall(),
			);
		if (command === "service-uninstall")
			return emit(
				out,
				err,
				json,
				command,
				deps.standard === undefined
					? { ok: false, message: "service-uninstall: service adapter is unavailable." }
					: await deps.standard.serviceUninstall(),
			);
		if (command === "register")
			return emit(
				out,
				err,
				json,
				command,
				deps.standard === undefined
					? { ok: false, message: "register: registry adapter is unavailable." }
					: await deps.standard.register(),
			);
		if (command === "update")
			return emit(
				out,
				err,
				json,
				command,
				deps.standard === undefined
					? { ok: false, message: "update: updater is unavailable." }
					: await deps.standard.update(argv.includes("--check")),
			);
		if (command === "logs") return logsCommand(argv, json, deps);
		if (command === "status") {
			const status = await statusResult(deps);
			if (status === null)
				return emit(out, err, json, command, { ok: false, message: "status: required adapters are unavailable." });
			if (json)
				out(
					JSON.stringify({
						...statusToJson(status),
						product: "honeycomb",
						command,
						ok: true,
						message: "Honeycomb status read.",
					}),
				);
			else out(formatStatus(status));
			return { exitCode: 0 };
		}
		return { exitCode: 2 };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return emit(out, err, json, command, { ok: false, message: `${command}: ${message}` });
	}
}
