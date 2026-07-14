/**
 * The unified CLI dispatcher — PRD-020a (FR-1 / FR-2 / FR-4 / a-AC-1).
 *
 * `parseInvocation` parses global flags + resolves the verb (pure, no IO). `dispatch` routes a
 * parsed invocation to its handler by the verb's routing class (`VERB_TABLE`):
 *   - `auth`     verbs (`org`/`workspace`, + `login`/`logout` via `AUTH_SUBCOMMANDS`) forward
 *                their FULL argv to `deps.auth` (the auth dispatcher) — NOT re-parsed (FR-4).
 *   - `storage`  verbs route through the `DaemonClient` seam (FR-3) — `sessions` to its
 *                paired-delete handler, every other storage verb to `runStorageVerb`.
 *   - `local`    verbs run the local FS / connector / dashboard / update handlers.
 * `--help`/`--version` short-circuit; an unknown or empty verb prints usage (exit 0 when empty,
 * FR-1).
 *
 * The dispatcher is a THIN CLIENT: it imports the {@link DaemonClient} seam type + the handlers,
 * never `daemon/storage`. `src/commands` is a NON_DAEMON_ROOT (D-2).
 */

import {
	composeProductManifest,
	confirm,
	disableColor,
	redactLogSecrets,
	renderProductBanner,
	renderVersion,
	renderVersionJson,
	type ProductBrand,
} from "@legioncodeinc/cli-kit";
import { HONEYCOMB_VERSION } from "../shared/constants.js";
import { runAssetVerb } from "./asset.js";
import { runCaptureVerb } from "./capture.js";
import {
	type CommandDeps,
	type CommandDispatcher,
	type CommandInvocation,
	type CommandResult,
	DEFAULT_GLOBAL_FLAGS,
	type GlobalFlags,
	isAuthPassthrough,
	isStorageVerb,
	lookupVerb,
	VERB_TABLE,
} from "./contracts.js";
import { type DaemonLifecycle, type DaemonVerbDeps, ensureDaemonRunning, runDaemonCommand } from "./daemon.js";
import { runHarnessVerb } from "./harness-status.js";
import { type InstallVerbDeps, runInstallCommand } from "./install.js";
import { type LocalDeps, runConnectorVerb, runDashboardCommand, runHookCommand } from "./local-handlers.js";
import { runMaintenanceVerb } from "./maintenance.js";
import { runMemoryVerb } from "./memory.js";
import { runPollinateVerb } from "./pollinate.js";
import { parseSessionsArgs, runSessionsCommand } from "./sessions.js";
import { runSettingsVerb } from "./settings.js";
import { runStatusCommand, type StatusDeps } from "./status.js";
import { runStorageVerb } from "./storage-handlers.js";
import { runTelemetryCommand, type TelemetryVerbDeps } from "./telemetry.js";
import { runStandardCommand, type StandardCommandDeps } from "./standard-interface.js";

/** The recognized global-flag tokens (FR-1). A per-command flag is left for the handler. */
const GLOBAL_FLAG_TOKENS: Readonly<Record<string, keyof GlobalFlags>> = {
	"--help": "help",
	"-h": "help",
	"--version": "version",
	"-V": "version",
	"--json": "json",
	"--dry-run": "dryRun",
	"--no-color": "noColor",
};

/**
 * Parse a raw argv tail into a typed {@link CommandInvocation} (FR-1). The FIRST non-flag word is
 * the verb; recognized global flags BEFORE the verb are consumed; everything from the verb onward
 * (its own flags + subcommands) is the handler's `argv` tail — so a passthrough verb (`org`,
 * `workspace`) forwards its subcommands verbatim (FR-4). Pure: no IO, fully testable.
 */
export function parseInvocation(argv: readonly string[]): CommandInvocation {
	const flags: { -readonly [K in keyof GlobalFlags]: boolean } = { ...DEFAULT_GLOBAL_FLAGS };
	let verb = "";
	const tail: string[] = [];
	for (const tok of argv) {
		// `--dry-run` is a legacy global marker but also a safety-critical per-command option
		// (`update`, `ontology stream apply`). Preserve it in the handler tail when it follows a verb;
		// consuming it silently could turn a requested preview into a real mutation.
		if (tok === "--dry-run") {
			flags.dryRun = true;
			if (verb !== "") tail.push(tok);
			continue;
		}
		const key = GLOBAL_FLAG_TOKENS[tok];
		if (key !== undefined) {
			flags[key] = true;
			continue;
		}
		if (verb === "" && !tok.startsWith("-")) verb = tok;
		else tail.push(tok);
	}
	return { verb, argv: tail, flags };
}

/**
 * The branded ASCII honeycomb mark printed atop `honeycomb` (no args) and `honeycomb --help`
 * (FR-2). Plain ASCII on purpose: it renders identically across all six harnesses, when piped,
 * and in non-TTY logs — no ANSI color or Unicode glyphs that a dumb terminal would mangle.
 * Backslashes are doubled for the JS string literal; the rendered art is a two-row honeycomb.
 */
const HONEYCOMB_ART = [
	"   __    __    __",
	"  /  \\__/  \\__/  \\",
	"  \\__/  \\__/  \\__/",
	"  /  \\__/  \\__/  \\",
	"  \\__/  \\__/  \\__/",
].join("\n");

const HONEYCOMB_BRAND: ProductBrand = {
	executable: "honeycomb",
	name: "HONEYCOMB",
	descriptor: "Shared agent memory for your coding tools",
	art: HONEYCOMB_ART,
};

/**
 * Build the multi-line usage string from the merged verb table (FR-2): the branded banner, the
 * version line, the usage line, then EVERY command grouped under its {@link VERB_GROUPS} section.
 * Grouping (rather than one flat list) makes the full surface scannable and structurally proves
 * no command is hidden — every `VERB_TABLE` row lands in exactly one printed section. The verb
 * column is padded to the widest verb so summaries align.
 */
export function usageText(width = 80): string {
	const baseline = new Set([
		"start",
		"stop",
		"restart",
		"status",
		"logs",
		"install",
		"uninstall",
		"service-install",
		"service-uninstall",
		"update",
		"register",
		"telemetry",
	]);
	const productCommands = VERB_TABLE.filter((spec) => !baseline.has(spec.verb)).map((spec) => ({
		name: spec.verb,
		summary: spec.summary.replace(/[^\x20-\x7E]/g, "-"),
		destructive: false,
		idempotent: false,
		json: false,
	}));
	return renderProductBanner({
		brand: HONEYCOMB_BRAND,
		version: HONEYCOMB_VERSION,
		manifest: composeProductManifest("honeycomb", productCommands),
		width,
	});
}

/** Narrow the opaque `deps.lifecycle` to the {@link DaemonLifecycle} seam (or `undefined`). */
function lifecycleOf(deps: CommandDeps): DaemonLifecycle | undefined {
	return deps.lifecycle as DaemonLifecycle | undefined;
}

/** The deps the `daemon` verb + ensure-running run against (the HTTP seam + the lifecycle seam). */
function daemonVerbDeps(deps: CommandDeps): DaemonVerbDeps {
	const lifecycle = lifecycleOf(deps);
	return {
		daemon: deps.daemon,
		...(lifecycle !== undefined ? { lifecycle } : {}),
		...(deps.out !== undefined ? { out: deps.out } : {}),
	};
}

/**
 * The deps the `install` verb (PRD-050a) runs against: the daemon HTTP+lifecycle seams (for the
 * health-gated ensure-running) plus the onboarding-state `dir` override. The browser opener is left
 * unbound — `runInstallCommand` defaults to the production fixed-argv opener; only a test injects a
 * recorder. `deps.openDashboard` and `deps.probeDashboard` (the C-6 portal reachability probe) are
 * forwarded when present so a bin/test can override them.
 */
function installVerbDeps(deps: CommandDeps): InstallVerbDeps {
	const opener = (deps as { openDashboard?: InstallVerbDeps["openDashboard"] }).openDashboard;
	const probe = (deps as { probeDashboard?: InstallVerbDeps["probeDashboard"] }).probeDashboard;
	// PRD-003a: forward the solo-vs-fleet + auto-login seams so a bin/test can override them; production
	// leaves them unset (the real classifier + device-flow login defaults apply).
	const detectFleet = (deps as { detectFleet?: InstallVerbDeps["detectFleet"] }).detectFleet;
	const loadInstallCredentials = (deps as { loadInstallCredentials?: InstallVerbDeps["loadInstallCredentials"] })
		.loadInstallCredentials;
	const runDeviceLogin = (deps as { runDeviceLogin?: InstallVerbDeps["runDeviceLogin"] }).runDeviceLogin;
	const persistInstalled = (deps as { persistInstalled?: InstallVerbDeps["persistInstalled"] }).persistInstalled;
	const registerWithDoctor = (deps as { registerWithDoctor?: InstallVerbDeps["registerWithDoctor"] })
		.registerWithDoctor;
	// PRD-003a: forward the connector engine so `install` wires harness hooks best-effort at the end
	// (the same engine `honeycomb setup` uses). Production binds the real runner in `src/cli/runtime.ts`;
	// a test injects a fake. When absent the install-time setup step is a silent no-op.
	const connector = (deps as { connector?: InstallVerbDeps["connector"] }).connector;
	return {
		...daemonVerbDeps(deps),
		...(deps.dir !== undefined ? { dir: deps.dir } : {}),
		...(opener !== undefined ? { openDashboard: opener } : {}),
		...(probe !== undefined ? { probeDashboard: probe } : {}),
		...(detectFleet !== undefined ? { detectFleet } : {}),
		...(loadInstallCredentials !== undefined ? { loadInstallCredentials } : {}),
		...(runDeviceLogin !== undefined ? { runDeviceLogin } : {}),
		...(persistInstalled !== undefined ? { persistInstalled } : {}),
		...(registerWithDoctor !== undefined ? { registerWithDoctor } : {}),
		...(connector !== undefined ? { connector } : {}),
	};
}

/**
 * The deps the `telemetry --show` glass-box verb (PRD-050e) runs against: the onboarding-state `dir`
 * override, the `env` (for the opt-out gate readout), and the `out` sink. A local READ only — no daemon
 * seam, no storage. The onboarding loader defaults inside the handler; tests inject it via the verb deps.
 */
function telemetryVerbDeps(deps: CommandDeps): TelemetryVerbDeps {
	const loadOnboarding = (deps as { loadOnboarding?: TelemetryVerbDeps["loadOnboarding"] }).loadOnboarding;
	return {
		...(deps.dir !== undefined ? { dir: deps.dir } : {}),
		...(deps.env !== undefined ? { env: deps.env } : {}),
		...(deps.out !== undefined ? { out: deps.out } : {}),
		...(deps.err !== undefined ? { err: deps.err } : {}),
		...(loadOnboarding !== undefined ? { loadOnboarding } : {}),
	};
}

async function jsonWrappedOperation(
	command: string,
	json: boolean,
	deps: CommandDeps,
	run: (captured: CommandDeps) => Promise<CommandResult> | CommandResult,
): Promise<CommandResult> {
	if (!json) return run(deps);
	const lines: string[] = [];
	const result = await run({
		...deps,
		out: (line: string): void => {
			lines.push(line);
		},
		err: (line: string): void => {
			lines.push(line);
		},
	});
	const out = deps.out ?? ((line: string): void => console.log(line));
	const message = redactLogSecrets(lines.join("\n") || `${command} completed.`);
	out(
		JSON.stringify({
			product: "honeycomb",
			command,
			ok: result.exitCode === 0,
			message,
		}),
	);
	return result;
}

function usageError(command: string, message: string, json: boolean, deps: CommandDeps): CommandResult {
	const out = deps.out ?? ((line: string): void => console.log(line));
	const err = deps.err ?? ((line: string): void => console.error(line));
	const safeMessage = redactLogSecrets(message);
	(json ? out : err)(
		json
			? JSON.stringify({ product: "honeycomb", command, ok: false, message: safeMessage })
			: `${safeMessage}\nRun 'honeycomb --help' for usage.`,
	);
	return { exitCode: 2 };
}

function validateInstallArgv(argv: readonly string[]): string | undefined {
	const safeRef = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index] ?? "";
		if (token === "--ref" || token === "--home") {
			const value = argv[++index];
			if (value === undefined || value.startsWith("--")) return `${token} requires a value.`;
			if (token === "--ref" && !safeRef.test(value))
				return "install: --ref must be a 1-64 character referral code using letters, numbers, dot, dash, or underscore.";
			continue;
		}
		if (token.startsWith("--ref=")) {
			const value = token.slice("--ref=".length);
			if (safeRef.test(value)) continue;
			return "install: --ref must be a 1-64 character referral code using letters, numbers, dot, dash, or underscore.";
		}
		if (token.startsWith("--home=") && token.slice("--home=".length).length > 0) continue;
		return `install: unknown option '${token}'.`;
	}
	return undefined;
}

async function confirmedUninstall(inv: CommandInvocation, deps: LocalDeps): Promise<CommandResult> {
	const argv = inv.argv.filter((token) => token !== "--yes");
	const flags = argv.filter((token) => token.startsWith("--"));
	const targets = argv.filter((token) => !token.startsWith("--"));
	if (flags.length > 0 || targets.length > 1)
		return usageError(
			"uninstall",
			`uninstall: unexpected argument '${flags[0] ?? targets[1] ?? ""}'.`,
			inv.flags.json,
			deps,
		);
	const isFull = argv.find((token) => !token.startsWith("--")) === undefined;
	const explicitlyConfirmed = inv.argv.includes("--yes");
	if (
		isFull &&
		!explicitlyConfirmed &&
		(inv.flags.json ||
			!(await confirm("Remove Honeycomb's service, Doctor registration, and product-owned state?", {
				assumeYes: false,
			})))
	) {
		const out = deps.out ?? ((line: string): void => console.log(line));
		const err = deps.err ?? ((line: string): void => console.error(line));
		(inv.flags.json ? out : err)(
			inv.flags.json
				? JSON.stringify({
						product: "honeycomb",
						command: "uninstall",
						ok: false,
						message: "Uninstall requires explicit confirmation with --yes in non-interactive mode.",
					})
				: "Uninstall cancelled. Re-run with --yes for non-interactive removal.",
		);
		return { exitCode: 2 };
	}
	return jsonWrappedOperation("uninstall", inv.flags.json, deps, (captured) =>
		runConnectorVerb("uninstall", argv, captured as LocalDeps),
	);
}

/**
 * Route a `storage` verb to its handler (sessions has its own paired-delete module). Ensure-running
 * on demand FIRST (b-AC-3): if the daemon is down, auto-start it (idempotent via the 021a PID/lock)
 * so the verb completes rather than failing with ECONNREFUSED. When no lifecycle seam is bound
 * (a plain handler test) the storage verb proceeds unchanged — `ensureDaemonRunning` is a no-op
 * beyond the reachability probe.
 */
async function dispatchStorage(inv: CommandInvocation, deps: CommandDeps): Promise<CommandResult> {
	// b-AC-3: best-effort auto-start. Only attempt when a lifecycle seam is bound; otherwise leave
	// the existing fake-driven handler tests (no lifecycle) completely unchanged.
	if (lifecycleOf(deps) !== undefined) {
		const reachable = await ensureDaemonRunning(daemonVerbDeps(deps));
		if (!reachable) {
			const out = deps.out ?? ((line: string): void => console.log(line));
			out(`error: ${inv.verb} could not reach the daemon on 127.0.0.1:3850 (auto-start failed).`);
			return { exitCode: 1 };
		}
	}
	if (inv.verb === "sessions") {
		return runSessionsCommand(parseSessionsArgs(inv.argv), deps);
	}
	// `pollinate` hits the diagnostics "Pollinate now" trigger (`/api/diagnostics/pollinate`), not the
	// `/api/<verb>` storage convention — so it has its own thin-client handler (PRD-026 D-3).
	if (inv.verb === "pollinate") {
		return runPollinateVerb(inv.argv, deps);
	}
	// `maintenance` hits the diagnostics compaction trigger (`/api/diagnostics/compact`), not the
	// `/api/<verb>` storage convention — so it has its own thin-client handler (PRD-030 D-2).
	if (inv.verb === "maintenance") {
		return runMaintenanceVerb(inv.argv, deps);
	}
	// `capture drain` hits the diagnostics force-drain trigger (`/api/diagnostics/capture-drain`), not
	// the `/api/<verb>` storage convention — so it has its own thin-client handler (PRD-079b b-AC-4).
	if (inv.verb === "capture") {
		return runCaptureVerb(inv.argv, deps);
	}
	// `memory` is the PRD-058d lifecycle surface: conflicts (list/resolve via the 058b endpoint),
	// stale-refs (list), and `inspect <id> --lifecycle`. It has its own thin-client handler because it
	// spans GET reads + the 058b resolve POST, not the generic `/api/<verb>` storage convention.
	if (inv.verb === "memory") {
		return runMemoryVerb(inv.argv, deps, inv.flags.json);
	}
	// `settings` hits the vault `/api/settings` group (list/get/set + the provider→model selector),
	// not the `/api/<verb>` storage convention — so it has its own thin-client handler (PRD-032b).
	if (inv.verb === "settings") {
		return runSettingsVerb(inv.argv, deps);
	}
	// `asset` drives the tier×style lattice: the publish/tombstone side hits the `/api/assets`
	// group via the loopback asset-sync API, and the LOCAL `.honeycomb/registry.json` is read/
	// written directly — its own thin-client handler (PRD-033b), not the `/api/<verb>` convention.
	if (inv.verb === "asset") {
		return runAssetVerb(inv.argv, deps);
	}
	// `recall` renders the daemon's hits; `--json` (the global flag) switches it to the raw JSON body.
	return runStorageVerb(inv.verb, inv.argv, deps, inv.flags.json);
}

/** Route a `local` verb (setup/connect/uninstall/dashboard/status/hook/update). */
function dispatchLocal(inv: CommandInvocation, deps: LocalDeps & StatusDeps): Promise<CommandResult> {
	switch (inv.verb) {
		case "setup":
		case "connect":
			return runConnectorVerb(inv.verb, inv.argv, deps);
		case "uninstall":
			return confirmedUninstall(inv, deps);
		case "install":
			{
				const error = validateInstallArgv(inv.argv);
				if (error !== undefined) return Promise.resolve(usageError("install", error, inv.flags.json, deps));
			}
			return jsonWrappedOperation("install", inv.flags.json, deps, (captured) =>
				runInstallCommand(inv.argv, installVerbDeps(captured)),
			);
		case "telemetry":
			return Promise.resolve(runTelemetryCommand(inv.argv, telemetryVerbDeps(deps), inv.flags.json));
		case "dashboard":
			return runDashboardCommand(deps);
		case "status":
		case "restart":
		case "logs":
		case "service-install":
		case "service-uninstall":
		case "register":
			return runStandardCommand(inv.verb, inv.argv, inv.flags.json, deps as StandardCommandDeps);
		// Apiary-standard bare lifecycle verbs operate only through the installed OS-service boundary.
		// The legacy `daemon start|stop|status` compatibility surface remains separately routed below;
		// canonical lifecycle commands never fall back to its process-level DaemonLifecycle behavior.
		case "start":
		case "stop":
			return runStandardCommand(inv.verb, inv.argv, inv.flags.json, deps as StandardCommandDeps);
		case "daemon":
			return runDaemonCommand(inv.argv, daemonVerbDeps(deps));
		case "hook":
			return runHookCommand(inv.argv, deps);
		// PRD-006c/006d: the coherent harness connect/status/repair surface Hive shells. `--json` (the
		// global flag) switches to the machine-readable body the onboarding step + dashboard card parse.
		case "harness":
			return runHarnessVerb(inv.argv, deps, inv.flags.json);
		case "update": {
			const updateArgv = inv.argv.map((token) => (token === "--dry-run" ? "--check" : token));
			if (inv.flags.dryRun && !updateArgv.includes("--check")) updateArgv.push("--check");
			return runStandardCommand(inv.verb, updateArgv, inv.flags.json, deps as StandardCommandDeps);
		}
		default:
			return Promise.resolve({ exitCode: 1 });
	}
}

/**
 * Route a parsed invocation to its handler and return the exit code (FR-1 / a-AC-1). `--help` /
 * `--version` short-circuit; an empty verb prints usage (exit 0). `org`/`workspace`/`login`/
 * `logout` forward their FULL argv to `deps.auth` (FR-4). Storage verbs route through the daemon
 * seam; local verbs run their FS/connector/dashboard handlers.
 */
export async function dispatch(inv: CommandInvocation, deps: CommandDeps): Promise<CommandResult> {
	const out = deps.out ?? ((line: string): void => console.log(line));
	const err = deps.err ?? ((line: string): void => console.error(line));

	if (inv.flags.version) {
		out(
			inv.flags.json
				? renderVersionJson("honeycomb", HONEYCOMB_VERSION).trimEnd()
				: renderVersion("honeycomb", HONEYCOMB_VERSION).trimEnd(),
		);
		return { exitCode: 0 };
	}
	if (inv.flags.noColor || inv.flags.json) disableColor();
	if (inv.flags.help || inv.verb === "") {
		if (inv.verb === "" && inv.argv.some((token) => token.startsWith("-")) && !inv.flags.help) {
			const message = redactLogSecrets(`unknown option '${inv.argv[0] ?? ""}'.`);
			(inv.flags.json ? out : err)(
				inv.flags.json
					? JSON.stringify({
							product: "honeycomb",
							command: "",
							ok: false,
							message,
						})
					: `${message}\n${usageText()}`,
			);
			return { exitCode: 2 };
		}
		out(
			inv.flags.json
				? JSON.stringify({ product: "honeycomb", command: "help", ok: true, message: "Honeycomb help." })
				: usageText(process.stdout.columns ?? 80),
		);
		return { exitCode: 0 };
	}

	// FR-4 / a-AC-1: org/workspace/login/logout pass through with the FULL arg array.
	if (isAuthPassthrough(inv.verb)) {
		if (deps.auth === undefined) {
			err(`${inv.verb}: the auth dispatcher is not wired in this build (deferred assembly).`);
			return { exitCode: 1 };
		}
		const code = await deps.auth.dispatch([inv.verb, ...inv.argv]);
		return { exitCode: code };
	}

	const spec = lookupVerb(inv.verb);
	if (spec === undefined) {
		const message = redactLogSecrets(`unknown command '${inv.verb}'.`);
		(inv.flags.json ? out : err)(
			inv.flags.json
				? JSON.stringify({
						product: "honeycomb",
						command: inv.verb,
						ok: false,
						message,
					})
				: `${message}\n${usageText(process.stdout.columns ?? 80)}`,
		);
		return { exitCode: 2 };
	}

	if (isStorageVerb(inv.verb)) return dispatchStorage(inv, deps);
	return dispatchLocal(inv, deps as LocalDeps & StatusDeps);
}

/** Build the {@link CommandDispatcher} (FR-1): the pure parser + the routing `dispatch`. */
export function createDispatcher(): CommandDispatcher {
	return {
		parse(argv: readonly string[]): CommandInvocation {
			return parseInvocation(argv);
		},
		dispatch(inv: CommandInvocation, deps: CommandDeps): Promise<CommandResult> {
			return dispatch(inv, deps);
		},
	};
}
