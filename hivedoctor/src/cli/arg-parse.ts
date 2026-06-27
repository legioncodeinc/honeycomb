/**
 * Minimal hand-rolled argv parsing (PRD-064f technical consideration: "no heavy CLI
 * framework - keep arg parsing minimal (built-ins) to honor the can't-crash principle").
 *
 * No `yargs`, no `commander`, no `minimist` - those are runtime deps and are banned from
 * the zero-dep watchdog package. This parser does exactly what the HiveDoctor command
 * surface needs and nothing more:
 *   - the FIRST positional token is the command (e.g. `status`);
 *   - `--flag` becomes a boolean true;
 *   - `--key=value` becomes a string value;
 *   - everything else is collected as a positional.
 *
 * Pure: takes an argv slice (already stripped of `node` + script path by the caller) and
 * returns a flat parsed shape. No I/O, never throws.
 */

/** The parsed argv: the leading command token plus flags + positionals. */
export interface ParsedArgs {
	/** The first positional token (the command), or undefined for a bare invocation. */
	readonly command: string | undefined;
	/** `--flag` booleans and `--key=value` strings, keyed by the flag name (no leading `--`). */
	readonly flags: Readonly<Record<string, string | boolean>>;
	/** Positional tokens after the command, in order. */
	readonly positionals: readonly string[];
}

/**
 * Parse an argv slice. The caller passes `process.argv.slice(2)` (or a test array). The
 * first non-flag token is the command; remaining non-flag tokens are positionals.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
	const flags: Record<string, string | boolean> = {};
	const positionals: string[] = [];

	for (const token of argv) {
		if (token.startsWith("--")) {
			const body = token.slice(2);
			const eq = body.indexOf("=");
			if (eq === -1) {
				// `--flag` -> boolean true.
				if (body.length > 0) flags[body] = true;
			} else {
				// `--key=value` -> string value (value may be empty).
				const key = body.slice(0, eq);
				const value = body.slice(eq + 1);
				if (key.length > 0) flags[key] = value;
			}
		} else {
			positionals.push(token);
		}
	}

	const command = positionals.length > 0 ? positionals[0] : undefined;
	return {
		command,
		flags,
		positionals: positionals.slice(1),
	};
}

/** True iff a boolean flag is present and truthy (e.g. `--check`, `--yes`, `--json`). */
export function hasFlag(parsed: ParsedArgs, name: string): boolean {
	return parsed.flags[name] === true || (typeof parsed.flags[name] === "string" && parsed.flags[name] !== "");
}
