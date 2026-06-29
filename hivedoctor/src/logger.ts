/**
 * HiveDoctor's tiny leveled logger (PRD-064a, foundation).
 *
 * Built-ins only, low-verbosity by default. The happy path (a healthy probe) logs
 * at `debug` and is silent at the default level; the hard path (a remediation, an
 * escalation) logs at `info`/`warn`/`error` and is always visible. This is design
 * principle 4 from PRD-064: "silent on the happy path, loud on the hard path".
 *
 * The logger NEVER throws. A logger that can crash the watchdog would defeat the
 * whole "incapable of crashing" premise (design principle 1), so every write is
 * wrapped: if the sink itself fails, the failure is swallowed deliberately (there
 * is nowhere safe to report a logging failure from inside a logger) rather than
 * propagated. This is the one place an empty-catch is correct, and it is documented.
 *
 * It carries NO secret by construction: callers pass a message + a flat fields
 * object; HiveDoctor only ever logs subsystem names, coarse states, counts, and
 * durations, never tokens or URLs with credentials (mirrors the daemon's logging
 * posture in src/daemon/runtime/health.ts).
 */

/** Log levels in ascending severity. `silent` disables all output. */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

/** Numeric rank so a configured threshold can gate lower-severity lines. */
const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
	silent: 100,
};

/** A flat, secret-free structured-fields bag attached to a log line. */
export type LogFields = Readonly<Record<string, unknown>>;

/** The minimal logger surface the rest of HiveDoctor depends on. */
export interface Logger {
	debug(message: string, fields?: LogFields): void;
	info(message: string, fields?: LogFields): void;
	warn(message: string, fields?: LogFields): void;
	error(message: string, fields?: LogFields): void;
}

/** The underlying write sink (injected so tests can capture lines without stdout). */
export interface LogSink {
	write(line: string): void;
}

/** Options for {@link createLogger}. */
export interface LoggerOptions {
	/** Minimum level to emit. Defaults to `info` (debug is suppressed by default). */
	readonly level?: LogLevel;
	/** Where lines go. Defaults to a `process.stderr` sink (stdout is reserved for any future CLI output). */
	readonly sink?: LogSink;
	/** Injected clock for the timestamp (defaults to `Date.now`), so tests are deterministic. */
	readonly now?: () => number;
}

/** The default sink writes to stderr; a failed write is swallowed (see module note). */
const defaultSink: LogSink = {
	write(line: string): void {
		try {
			process.stderr.write(`${line}\n`);
		} catch {
			// Intentionally swallowed: a logger that throws on a broken stderr would crash
			// the watchdog. There is no safer place to report a logging failure from here.
		}
	},
};

/**
 * Serialize one structured line as a single JSON object: `{ ts, level, msg, ...fields }`.
 * JSON keeps the line greppable and machine-parseable for the later telemetry wave (064d),
 * and `JSON.stringify` of a flat fields bag cannot itself throw on the values HiveDoctor
 * passes (strings, numbers, booleans). A circular/unstringifiable value is caught by the
 * sink wrapper rather than crashing the caller.
 */
function format(now: number, level: LogLevel, message: string, fields: LogFields | undefined): string {
	const base: Record<string, unknown> = {
		ts: new Date(now).toISOString(),
		level,
		msg: message,
	};
	if (fields !== undefined) {
		for (const [key, value] of Object.entries(fields)) base[key] = value;
	}
	return JSON.stringify(base);
}

/**
 * Build a leveled logger. Every method is wrapped so a logging failure never
 * propagates into the watch loop. The level threshold is read once at construction
 * (HiveDoctor's level does not change at runtime in Wave 0).
 */
export function createLogger(options: LoggerOptions = {}): Logger {
	const threshold = LEVEL_RANK[options.level ?? "info"];
	const sink = options.sink ?? defaultSink;
	const now = options.now ?? Date.now;

	function emit(level: LogLevel, message: string, fields: LogFields | undefined): void {
		try {
			if (LEVEL_RANK[level] < threshold) return;
			sink.write(format(now(), level, message, fields));
		} catch {
			// A formatting/sink failure must never crash the caller (design principle 1).
			// The line is dropped deliberately; correctness of the watch loop outranks it.
		}
	}

	return {
		debug: (message, fields) => emit("debug", message, fields),
		info: (message, fields) => emit("info", message, fields),
		warn: (message, fields) => emit("warn", message, fields),
		error: (message, fields) => emit("error", message, fields),
	};
}

/** A logger that drops everything (default for tests that do not assert on logs). */
export const silentLogger: Logger = {
	debug(): void {},
	info(): void {},
	warn(): void {},
	error(): void {},
};
