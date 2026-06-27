/**
 * Injectable command-runner boundary for the npm-touching rungs (PRD-063c).
 *
 * Rung 2 (reinstall) and rung 3 (uninstall conflicting Hivemind) both shell out to
 * `npm`. To keep the rungs hermetic and testable - and to honor the binding rule that
 * a test NEVER actually runs npm - every external command goes through this
 * {@link CommandRunner} interface. Tests inject a fake that records the argv and
 * returns a canned {@link CommandResult}; the supervisor wires the real built-in
 * runner ({@link createExecFileRunner}) in a later wave.
 *
 * The real runner uses `node:child_process.execFile` (NOT `exec`): execFile takes an
 * argv array and does NOT spawn a shell, so a package name can never be interpreted as
 * a shell metacharacter. This is the same no-shell discipline the daemon uses for its
 * own child processes.
 *
 * Crash-safety (design principle 1): `run` resolves to a {@link CommandResult} for
 * BOTH success and failure - a non-zero exit, a spawn error (npm not on PATH), or a
 * timeout all become a result with `ok:false`, never a thrown error. The rung decides
 * what a failure means; the runner never crashes the watchdog.
 *
 * Built-ins ONLY: node:child_process.
 */

import { execFile } from "node:child_process";

/** The outcome of running one external command. Never throws; failure is a value. */
export interface CommandResult {
	/** True iff the process exited 0 within the timeout and did not fail to spawn. */
	readonly ok: boolean;
	/** The exit code, or null when the process was killed / failed to spawn. */
	readonly code: number | null;
	/** Captured stdout (secret-free for the commands HiveDoctor runs; size-capped). */
	readonly stdout: string;
	/** Captured stderr (size-capped). */
	readonly stderr: string;
	/** A short failure note (spawn error class / timeout), when `ok` is false. */
	readonly detail?: string;
}

/** Options for a single {@link CommandRunner.run} call. */
export interface CommandRunOptions {
	/** Hard timeout in ms; the process is killed and the result is `ok:false` after it. */
	readonly timeoutMs?: number;
}

/** The injectable boundary every npm-touching rung calls. */
export interface CommandRunner {
	/**
	 * Run `command` with `args` (argv, no shell). Resolves to a {@link CommandResult}
	 * for success AND failure - NEVER rejects.
	 */
	run(command: string, args: readonly string[], options?: CommandRunOptions): Promise<CommandResult>;
}

/** The default per-command timeout (npm global installs can be slow): 2 minutes. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Cap captured output so a chatty npm can never balloon memory in the watchdog. */
const MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Build the REAL command runner over `node:child_process.execFile`. No shell is
 * spawned (argv array), output is buffer-capped, and every failure mode (non-zero
 * exit, ENOENT spawn failure, timeout kill) is mapped to a {@link CommandResult}
 * rather than a thrown error. The supervisor injects this in production; tests inject
 * a fake instead.
 */
export function createExecFileRunner(): CommandRunner {
	return {
		run(command: string, args: readonly string[], options?: CommandRunOptions): Promise<CommandResult> {
			const timeout = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			return new Promise<CommandResult>((resolve) => {
				execFile(
					command,
					[...args],
					// `shell:false` is the default; stated here to make the no-shell guarantee explicit.
					{ timeout, maxBuffer: MAX_BUFFER_BYTES, shell: false, windowsHide: true },
					(error, stdout, stderr) => {
						// execFile defaults to utf8 encoding, so stdout/stderr arrive as strings.
						const out = stdout;
						const err = stderr;
						if (error === null) {
							resolve({ ok: true, code: 0, stdout: out, stderr: err });
							return;
						}
						// execFile attaches `.code` (numeric exit), or `.killed`/signal on a timeout, or
						// a spawn-error code string (e.g. ENOENT) when the binary is missing.
						const errWithMeta = error as NodeJS.ErrnoException & { code?: number | string };
						const numericCode = typeof errWithMeta.code === "number" ? errWithMeta.code : null;
						const detail =
							typeof errWithMeta.code === "string"
								? errWithMeta.code
								: error instanceof Error
									? error.message
									: "command-failed";
						resolve({ ok: false, code: numericCode, stdout: out, stderr: err, detail });
					},
				);
			});
		},
	};
}
