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
import { parseSessionsArgs, runSessionsCommand } from "./sessions.js";
import { runDreamVerb } from "./dream.js";
import { runMaintenanceVerb } from "./maintenance.js";
import { runSettingsVerb } from "./settings.js";
import { runStorageVerb } from "./storage-handlers.js";
import { runStatusCommand, type StatusDeps } from "./status.js";
import { type LocalDeps, runConnectorVerb, runDashboardCommand, runHookCommand, runUpdateCommand } from "./local-handlers.js";
import {
	type DaemonLifecycle,
	type DaemonVerbDeps,
	ensureDaemonRunning,
	runDaemonCommand,
} from "./daemon.js";
import { HONEYCOMB_VERSION, PRODUCT_SLUG } from "../shared/constants.js";

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

/** Build the multi-line usage string from the merged verb table (FR-2). */
export function usageText(): string {
	const lines = [`${PRODUCT_SLUG} v${HONEYCOMB_VERSION}`, "", "usage: honeycomb <command> [options]", "", "commands:"];
	for (const spec of VERB_TABLE) {
		lines.push(`  ${spec.verb.padEnd(11)} ${spec.summary}`);
	}
	lines.push("", "global flags: --help  --version  --json  --dry-run");
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
	// `dream` hits the diagnostics "Dream now" trigger (`/api/diagnostics/dream`), not the
	// `/api/<verb>` storage convention — so it has its own thin-client handler (PRD-026 D-3).
	if (inv.verb === "dream") {
		return runDreamVerb(inv.argv, deps);
	}
	// `maintenance` hits the diagnostics compaction trigger (`/api/diagnostics/compact`), not the
	// `/api/<verb>` storage convention — so it has its own thin-client handler (PRD-030 D-2).
	if (inv.verb === "maintenance") {
		return runMaintenanceVerb(inv.argv, deps);
	}
	// `settings` hits the vault `/api/settings` group (list/get/set + the provider→model selector),
	// not the `/api/<verb>` storage convention — so it has its own thin-client handler (PRD-032b).
	if (inv.verb === "settings") {
		return runSettingsVerb(inv.argv, deps);
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
		case "dashboard":
			return runDashboardCommand(deps);
		case "status":
			return runStatusCommand(deps);
		case "daemon":
			return runDaemonCommand(inv.argv, daemonVerbDeps(deps));
		case "hook":
			return runHookCommand(inv.argv, deps);
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
