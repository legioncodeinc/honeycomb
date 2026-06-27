/**
 * Tiny ANSI styling helpers for the CLI (PRD-064f, branded UX).
 *
 * Built-ins only - no `chalk`, no `picocolors`, no runtime dep (binding constraint:
 * zero runtime deps in the can't-crash package). A handful of SGR escape codes wrapped
 * in functions that honor the `NO_COLOR` standard and a non-TTY stream (so piped output
 * and CI logs stay clean). Color is decoration; the CLI is fully legible without it.
 *
 * The enabled/disabled decision is resolved once at module construction via
 * {@link createColors}, which takes the env + an `isTty` flag so it is hermetic in tests.
 */

/** The styling surface the CLI uses. Each is identity when color is disabled. */
export interface Colors {
	readonly enabled: boolean;
	bold(s: string): string;
	dim(s: string): string;
	/** Honeycomb amber (the brand accent). */
	amber(s: string): string;
	cyan(s: string): string;
	green(s: string): string;
	yellow(s: string): string;
	red(s: string): string;
}

/** Options for {@link createColors}. */
export interface ColorsOptions {
	/** The env the NO_COLOR / FORCE_COLOR gate reads (defaults to `process.env`). */
	readonly env?: NodeJS.ProcessEnv;
	/** Whether the target stream is a TTY (defaults to `process.stdout.isTTY`). */
	readonly isTty?: boolean;
}

/** Wrap `s` in an SGR code + reset. */
function sgr(code: string, s: string): string {
	return `[${code}m${s}[0m`;
}

/**
 * Decide whether ANSI color should be emitted. `NO_COLOR` (any non-empty value) forces
 * off per the no-color.org standard; `FORCE_COLOR` (non-empty, not "0") forces on; else
 * color is on only for a TTY. Resolved once so the whole CLI is consistent.
 */
export function colorEnabled(env: NodeJS.ProcessEnv, isTty: boolean): boolean {
	const noColor = env["NO_COLOR"];
	if (noColor !== undefined && noColor !== "") return false;
	const force = env["FORCE_COLOR"];
	if (force !== undefined && force !== "" && force !== "0") return true;
	return isTty;
}

/** Build the styling surface. When color is disabled, every helper is the identity. */
export function createColors(options: ColorsOptions = {}): Colors {
	const env = options.env ?? process.env;
	const isTty = options.isTty ?? Boolean(process.stdout.isTTY);
	const on = colorEnabled(env, isTty);

	const wrap =
		(code: string) =>
		(s: string): string =>
			on ? sgr(code, s) : s;

	return {
		enabled: on,
		bold: wrap("1"),
		dim: wrap("2"),
		amber: wrap("38;5;214"),
		cyan: wrap("36"),
		green: wrap("32"),
		yellow: wrap("33"),
		red: wrap("31"),
	};
}
