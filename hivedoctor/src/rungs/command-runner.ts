/**
 * Injectable command-runner boundary for the npm-touching rungs (PRD-064c).
 *
 * Rung 2 (reinstall) and rung 3 (uninstall conflicting Hivemind), plus the auto-update
 * installed-version reader, all shell out to `npm`. To keep them hermetic and testable -
 * and to honor the binding rule that a UNIT test NEVER actually runs npm - every external
 * command goes through this {@link CommandRunner} interface. Tests inject a fake that records
 * the argv and returns a canned {@link CommandResult}; the supervisor/composition root wires
 * the real built-in runner ({@link createExecFileRunner}) in production.
 *
 * The real runner uses `node:child_process.execFile` (NOT `exec`): execFile takes an argv
 * array and does NOT spawn a shell, so a package name can never be interpreted as a shell
 * metacharacter. This is the same no-shell discipline the daemon uses for its own child
 * processes.
 *
 * ── Cross-platform npm launch (the load-bearing detail) ──────────────────────────────────
 * `execFile("npm", args)` with NO shell is BROKEN on Windows: `npm` there is `npm.cmd` /
 * `npm.ps1`, not an executable image, so `execFile` cannot launch it (ENOENT spawn error).
 * That silently failed EVERY npm operation on Windows hosts (reinstall, uninstall-hivemind,
 * the `npm ls -g` installed-version read), and it was never caught because the rungs were only
 * ever unit-tested against the injected FAKE - the real npm path never ran on a Windows host.
 *
 * The fix keeps `shell:false` and dodges the `.cmd`/`.ps1` problem entirely: when the command
 * is `npm`, we run npm's OWN JavaScript CLI entry with the current Node binary -
 * `execFile(process.execPath, [npmCliJsPath, ...args])`. `npm-cli.js` is a plain Node script on
 * every OS, so this launches identically on Windows, macOS, and Linux with no shell and no
 * metacharacter risk. {@link resolveNpmCliJs} locates `npm-cli.js` robustly (createRequire first,
 * then known locations relative to `process.execPath`). Only when `npm-cli.js` cannot be found at
 * all do we fall back: on win32 to `npm.cmd` with `shell:true` (safe here - the argv is fixed
 * literals plus a semver-validated version, never an attacker-controlled token), and on every
 * other OS to the direct `execFile("npm", args)` path (which works there).
 *
 * Crash-safety (design principle 1): `run` resolves to a {@link CommandResult} for BOTH success
 * and failure - a non-zero exit, a spawn error (npm not found), or a timeout all become a result
 * with `ok:false`, never a thrown error. The rung decides what a failure means; the runner never
 * crashes the watchdog.
 *
 * Built-ins ONLY: node:child_process, node:module (createRequire), node:path, node:fs, node:process.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";

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
 * Locate npm's JavaScript CLI entry (`npm-cli.js`) so it can be run with the current Node binary
 * - the cross-platform, no-shell way to launch npm. Returns the absolute path, or `null` when it
 * cannot be found (the caller then falls back to a platform-specific launch).
 *
 * Resolution order (most-robust first):
 *   1. `require.resolve("npm/bin/npm-cli.js")` via {@link createRequire}. This succeeds whenever an
 *      `npm` package is resolvable from this module (the common case for a bundled CLI installed
 *      under a Node that ships npm).
 *   2. Known locations relative to `process.execPath` (the running Node binary):
 *        - Windows: npm lives beside node, at `<dir(node)>\node_modules\npm\bin\npm-cli.js`.
 *        - Unix:    npm lives under the node prefix, at
 *                   `<dir(node)>/../lib/node_modules/npm/bin/npm-cli.js`
 *                   (and `<dir(node)>/node_modules/npm/bin/npm-cli.js` for some layouts, e.g. nvm).
 *
 * Defensive: NEVER throws. A failed `require.resolve` or a non-existent candidate just advances to
 * the next strategy; exhausting them returns null.
 *
 * @param execPath - the Node binary path (defaults to `process.execPath`; injectable for tests).
 * @param platform - the OS platform (defaults to `process.platform`; injectable for tests).
 */
export function resolveNpmCliJs(
	execPath: string = process.execPath,
	platform: NodeJS.Platform = process.platform,
): string | null {
	// Strategy 1: resolve npm as a package from this module's resolution root.
	try {
		const require = createRequire(import.meta.url);
		const resolved = require.resolve("npm/bin/npm-cli.js");
		if (existsSync(resolved)) return resolved;
	} catch {
		// npm not resolvable from here (bundled CLI, pruned node_modules) - try the exec-path fallbacks.
	}

	// Strategy 2: known locations relative to the running Node binary.
	const nodeDir = dirname(execPath);
	const candidates =
		platform === "win32"
			? // On Windows, npm ships beside node.exe inside the install dir.
				[join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js")]
			: // On Unix, node is in <prefix>/bin, npm under <prefix>/lib/node_modules; some layouts
				// (nvm) also place node_modules directly beside the bin dir.
				[
					join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
					join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
				];
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			// An unreadable candidate path is simply not it; keep looking.
		}
	}
	return null;
}

/** How {@link createExecFileRunner} will launch a given command: the real file + any prefixed args + shell flag. */
export interface NpmSpawnPlan {
	/** The executable image (or, in the shell fallback, the shell command) to launch. */
	readonly file: string;
	/** Args prepended BEFORE the caller's args (e.g. `[npmCliJsPath]` when launching via node). */
	readonly prefixArgs: readonly string[];
	/** Whether the OS shell is used. Only the documented win32 `npm.cmd` fallback sets this true. */
	readonly shell: boolean;
}

/**
 * Decide how to launch `command`. For every command EXCEPT `npm`, this is the identity launch:
 * the command itself, no prefix, no shell. For `npm`, prefer the no-shell node + `npm-cli.js`
 * launch (cross-platform, metacharacter-proof); only when `npm-cli.js` cannot be located fall
 * back per-OS:
 *   - win32  → `npm.cmd` with `shell:true`. SAFE here because the ONLY values that reach the
 *     shell are HiveDoctor's own fixed literals (`install`/`uninstall`/`ls`/`-g`/`--json`/
 *     fixed package names) plus, for the reinstall verify, a semver-validated version. No
 *     attacker-controlled token is ever passed, so there is no metacharacter-injection vector.
 *   - other  → the direct `execFile("npm", args)` path, which works on Unix where `npm` is a
 *     normal executable shim.
 *
 * @param command - the command the rung asked to run.
 * @param execPath - the Node binary (injectable for tests).
 * @param platform - the OS platform (injectable for tests).
 */
export function planNpmSpawn(
	command: string,
	execPath: string = process.execPath,
	platform: NodeJS.Platform = process.platform,
): NpmSpawnPlan {
	if (command !== "npm") {
		return { file: command, prefixArgs: [], shell: false };
	}
	const npmCliJs = resolveNpmCliJs(execPath, platform);
	if (npmCliJs !== null) {
		// The cross-platform, no-shell launch: run npm's own JS entry with the current Node.
		return { file: execPath, prefixArgs: [npmCliJs], shell: false };
	}
	if (platform === "win32") {
		// Last-resort win32 fallback: `npm.cmd` needs a shell to run. Documented-safe (see above):
		// fixed-literal argv + semver-validated version only, no attacker-controlled token.
		return { file: "npm.cmd", prefixArgs: [], shell: true };
	}
	// Non-win32: the plain `npm` shim is a real executable execFile can launch directly.
	return { file: "npm", prefixArgs: [], shell: false };
}

/**
 * Build the REAL command runner over `node:child_process.execFile`. The npm launch is resolved
 * cross-platform ({@link planNpmSpawn}/{@link resolveNpmCliJs}): on every OS npm runs as
 * `node npm-cli.js <args>` with NO shell, which sidesteps the Windows `npm.cmd`/`npm.ps1`
 * un-launchable-by-execFile problem. Output is buffer-capped, and every failure mode (non-zero
 * exit, ENOENT spawn failure, timeout kill) is mapped to a {@link CommandResult} rather than a
 * thrown error. The supervisor injects this in production; tests inject a fake instead.
 */
export function createExecFileRunner(): CommandRunner {
	return {
		run(command: string, args: readonly string[], options?: CommandRunOptions): Promise<CommandResult> {
			const timeout = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const plan = planNpmSpawn(command);
			const fullArgs = [...plan.prefixArgs, ...args];
			return new Promise<CommandResult>((resolve) => {
				execFile(
					plan.file,
					fullArgs,
					// `shell` is false for the node + npm-cli.js launch and the direct execFile paths; it
					// is true ONLY for the documented win32 `npm.cmd` fallback (fixed-literal argv only).
					{ timeout, maxBuffer: MAX_BUFFER_BYTES, shell: plan.shell, windowsHide: true },
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
