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

import { HONEYCOMB_VERSION, PRODUCT_SLUG } from "../shared/constants.js";
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
	VERB_GROUPS,
	VERB_TABLE,
} from "./contracts.js";
import { type DaemonLifecycle, type DaemonVerbDeps, ensureDaemonRunning, runDaemonCommand } from "./daemon.js";
import { runHarnessVerb } from "./harness-status.js";
import { type InstallVerbDeps, runInstallCommand } from "./install.js";
import {
	type LocalDeps,
	runConnectorVerb,
	runDashboardCommand,
	runHookCommand,
	runUpdateCommand,
} from "./local-handlers.js";
import { runMaintenanceVerb } from "./maintenance.js";
import { runMemoryVerb } from "./memory.js";
import { runPollinateVerb } from "./pollinate.js";
import { parseSessionsArgs, runSessionsCommand } from "./sessions.js";
import { runSettingsVerb } from "./settings.js";
import { runStatusCommand, type StatusDeps } from "./status.js";
import { runStorageVerb } from "./storage-handlers.js";
import { runTelemetryCommand, type TelemetryVerbDeps } from "./telemetry.js";

/** The recognized global-flag tokens (FR-1). A per-command flag is left for the handler. */
const GLOBAL_FLAG_TOKENS: Readonly<Record<string, keyof GlobalFlags>> = {
	"--help": "help",
	"-h": "help",
	"--version": "version",
	"-V": "version",
	"--json": "json",
	"--dry-run": "dryRun",
};

/**
 * Parse a raw argv tail into a typed {@link CommandInvocation} (FR-1). The FIRST non-flag word is
 * the verb; recognized global flags BEFORE the verb are consumed; everything from the verb onward
 * (its own flags + subcommands) is the handler's `argv` tail — so a passthrough verb (`org`,
 * `workspace`) forwards its subcommands verbatim (FR-4). Pure: no IO, fully testable.
 */
export function parseInvocation(argv: readonly string[]): CommandInvocation {
	const flags: { -readonly [K in keyof GlobalFlags]: boolean } = { ...DEFAULT_GLOBAL_FLAGS };
	let i = 0;
	for (; i < argv.length; i++) {
		const tok = argv[i];
		if (tok === undefined) break;
		if (!tok.startsWith("-")) break;
		const key = GLOBAL_FLAG_TOKENS[tok];
		if (key === undefined) break; // an unknown leading flag belongs to no verb → stop; verb=""
		flags[key] = true;
	}
	const verb = argv[i] !== undefined && !argv[i]!.startsWith("-") ? argv[i]! : "";
	const tail = verb === "" ? argv.slice(i) : argv.slice(i + 1);
	return { verb, argv: tail, flags };
}

/**
 * The branded ASCII honeycomb mark printed atop `honeycomb` (no args) and `honeycomb --help`
 * (FR-2). Plain ASCII on purpose: it renders identically across all six harnesses, when piped,
 * and in non-TTY logs — no ANSI color or Unicode glyphs that a dumb terminal would mangle.
 * Backslashes are doubled for the JS string literal; the rendered art is a two-row honeycomb.
 */
const HONEYCOMB_BANNER = [
	"   __    __    __",
	"  /  \\__/  \\__/  \\     H O N E Y C O M B",
	"  \\__/  \\__/  \\__/",
	"  /  \\__/  \\__/  \\     shared agent memory for your coding tools",
	"  \\__/  \\__/  \\__/",
].join("\n");

/**
 * Build the multi-line usage string from the merged verb table (FR-2): the branded banner, the
 * version line, the usage line, then EVERY command grouped under its {@link VERB_GROUPS} section.
 * Grouping (rather than one flat list) makes the full surface scannable and structurally proves
 * no command is hidden — every `VERB_TABLE` row lands in exactly one printed section. The verb
 * column is padded to the widest verb so summaries align.
 */
export function usageText(): string {
	const lines: string[] = [
		HONEYCOMB_BANNER,
		"",
		`${PRODUCT_SLUG} v${HONEYCOMB_VERSION}`,
		"",
		"usage: honeycomb <command> [options]",
		"",
	];
	const pad = VERB_TABLE.reduce((w, s) => Math.max(w, s.verb.length), 0) + 2;
	for (const { key, label } of VERB_GROUPS) {
		const rows = VERB_TABLE.filter((s) => s.group === key);
		if (rows.length === 0) continue;
		lines.push(`${label}:`);
		for (const spec of rows) lines.push(`  ${spec.verb.padEnd(pad)}${spec.summary}`);
		lines.push("");
	}
	lines.push("global flags: --help  --version  --json  --dry-run");
	return lines.join("\n");
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
		...(connector !== undefined ? { connector } : {}),
	};
}

/**
 * The deps the `telemetry --show` glass-box verb (PRD-050e) runs against: the onboarding-state `dir`
 * override, the `env` (for the opt-out gate readout), and the `out` sink. A local READ only — no daemon
 * seam, no storage. The onboarding loader defaults inside the handler; tests inject it via the verb deps.
 */
function telemetryVerbDeps(deps: CommandDeps): TelemetryVerbDeps {
	return {
		...(deps.dir !== undefined ? { dir: deps.dir } : {}),
		...(deps.env !== undefined ? { env: deps.env } : {}),
		...(deps.out !== undefined ? { out: deps.out } : {}),
	};
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
		case "uninstall":
			return runConnectorVerb(inv.verb, inv.argv, deps);
		case "install":
			return runInstallCommand(inv.argv, installVerbDeps(deps));
		case "telemetry":
			return Promise.resolve(runTelemetryCommand(inv.argv, telemetryVerbDeps(deps)));
		case "dashboard":
			return runDashboardCommand(deps);
		case "status":
			return runStatusCommand(deps);
		// PRD-003b b-AC-1 / b-AC-5: bare `start` / `stop` front the SAME DaemonLifecycle paths as
		// `daemon start` / `daemon stop` (which stay working as aliases). The daemon subcommand is
		// forced to the bare verb; any extra flags on the tail are preserved.
		case "start":
			return runDaemonCommand(["start", ...inv.argv], daemonVerbDeps(deps));
		case "stop":
			return runDaemonCommand(["stop", ...inv.argv], daemonVerbDeps(deps));
		case "daemon":
			return runDaemonCommand(inv.argv, daemonVerbDeps(deps));
		case "hook":
			return runHookCommand(inv.argv, deps);
		// PRD-006c/006d: the coherent harness connect/status/repair surface Hive shells. `--json` (the
		// global flag) switches to the machine-readable body the onboarding step + dashboard card parse.
		case "harness":
			return runHarnessVerb(inv.argv, deps, inv.flags.json);
		case "update":
			return runUpdateCommand(inv.argv, deps);
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

	if (inv.flags.version) {
		out(`${PRODUCT_SLUG} v${HONEYCOMB_VERSION}`);
		return { exitCode: 0 };
	}
	if (inv.flags.help || inv.verb === "") {
		out(usageText());
		return { exitCode: 0 };
	}

	// FR-4 / a-AC-1: org/workspace/login/logout pass through with the FULL arg array.
	if (isAuthPassthrough(inv.verb)) {
		if (deps.auth === undefined) {
			out(`${inv.verb}: the auth dispatcher is not wired in this build (deferred assembly).`);
			return { exitCode: 1 };
		}
		const code = await deps.auth.dispatch([inv.verb, ...inv.argv]);
		return { exitCode: code };
	}

	const spec = lookupVerb(inv.verb);
	if (spec === undefined) {
		out(`unknown command '${inv.verb}'.`);
		out(usageText());
		return { exitCode: 1 };
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
