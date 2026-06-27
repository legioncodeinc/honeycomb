/**
 * The single-sourced HiveDoctor command surface (PRD-064f Scope command table).
 *
 * ONE list defines every command name, its menu summary, and the canonical set of
 * known commands. The dispatcher ({@link file://./dispatch.ts}) and the banner menu
 * ({@link file://./banner.ts}) both read this list, so the menu can never drift from
 * what actually dispatches.
 *
 * Binding rulings encoded here (PRD-064 Decisions, OD-4):
 *   - There is NO `clear-credentials` command. Credential purge is DEFERRED, not in v1;
 *     it is only ever RECOMMENDED via escalation, never offered as a command (AC-064f.4).
 *   - `self-update` is the ONLY command that updates HiveDoctor's own package (AC-064f.5).
 *
 * Pure data + a tiny lookup; no I/O. Built-ins only.
 */

/** Every command HiveDoctor's CLI dispatches. The string union is the closed set. */
export type CommandName =
	| "run"
	| "status"
	| "diagnose"
	| "heal"
	| "restart"
	| "reinstall"
	| "uninstall-hivemind"
	| "update"
	| "self-update"
	| "install-service"
	| "uninstall-service"
	| "logs"
	| "help";

/** One row of the command menu (name + one-line summary). */
export interface CommandMenuEntry {
	/** How the command is invoked on the menu (the bare command name). */
	readonly invocation: CommandName;
	/** A one-line summary shown in the menu. */
	readonly summary: string;
}

/**
 * The command menu, in display order. This is the dispatch surface and the menu surface.
 * Deliberately ABSENT: `clear-credentials` (deferred, OD-4 / AC-064f.4).
 */
export const COMMAND_MENU: readonly CommandMenuEntry[] = [
	{ invocation: "run", summary: "Run the supervised watchdog (the OS service entry; not for manual use)." },
	{ invocation: "status", summary: "Daemon health, service state, versions, last heal, opt-out flags." },
	{ invocation: "diagnose", summary: "Classify health and print the recommended fix - takes no action." },
	{ invocation: "heal", summary: "Run the remediation ladder once (gated steps confirm)." },
	{ invocation: "restart", summary: "Restart the primary daemon (rung 1)." },
	{ invocation: "reinstall", summary: "Reinstall the primary daemon (rung 2)." },
	{ invocation: "uninstall-hivemind", summary: "Remove a conflicting @deeplake/hivemind global (rung 3, confirms)." },
	{ invocation: "update", summary: "Update the primary daemon via the blessed gate (--check to preview)." },
	{ invocation: "self-update", summary: "Update HiveDoctor's own package (the ONLY path that does)." },
	{ invocation: "install-service", summary: "Register HiveDoctor as an OS service (064b)." },
	{ invocation: "uninstall-service", summary: "Unregister the HiveDoctor OS service (064b)." },
	{ invocation: "logs", summary: "Tail the local incident log (incidents.ndjson)." },
	{ invocation: "help", summary: "Show this banner and command menu." },
];

/** The set of known command names, derived from the menu so it cannot drift. */
export const KNOWN_COMMANDS: ReadonlySet<string> = new Set(COMMAND_MENU.map((e) => e.invocation));

/**
 * Resolve a raw first-arg token to a {@link CommandName}, or null when unknown.
 * `undefined`/empty (bare invocation) resolves to null so the caller renders the banner.
 */
export function resolveCommand(token: string | undefined): CommandName | null {
	if (token === undefined || token.trim() === "") return null;
	const t = token.trim();
	return KNOWN_COMMANDS.has(t) ? (t as CommandName) : null;
}
