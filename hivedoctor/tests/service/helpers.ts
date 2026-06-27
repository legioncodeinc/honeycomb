/**
 * Shared test fakes for the OS-service module (PRD-064b).
 *
 * A recording {@link CommandRunner} (asserts the EXACT argv per platform without executing)
 * and an in-memory {@link ServiceFs} (asserts the unit text written / removed without
 * touching disk). Both mirror the runtime's "never throws" contract.
 */

import type { CommandResult, CommandRunner } from "../../src/rungs/command-runner.js";
import type { ServiceFs } from "../../src/service/index.js";
import type { ServiceEnvironment } from "../../src/service/platform.js";

/** One recorded invocation: the command + its argv. */
export interface RecordedCommand {
	readonly command: string;
	readonly args: readonly string[];
}

/** A CommandRunner that records every call and returns a scripted result. */
export interface RecordingRunner extends CommandRunner {
	readonly calls: RecordedCommand[];
}

/**
 * Build a recording runner. By default every call succeeds (`ok:true`). A `respond`
 * override lets a test fail a specific command (e.g. systemd `is-active` -> inactive).
 */
export function createRecordingRunner(
	respond?: (command: string, args: readonly string[]) => CommandResult,
): RecordingRunner {
	const calls: RecordedCommand[] = [];
	return {
		calls,
		run(command: string, args: readonly string[]): Promise<CommandResult> {
			calls.push({ command, args: [...args] });
			const result = respond?.(command, args) ?? { ok: true, code: 0, stdout: "", stderr: "" };
			return Promise.resolve(result);
		},
	};
}

/** One write the in-memory fs captured. */
export interface RecordedWrite {
	readonly path: string;
	readonly content: string;
}

/** An in-memory ServiceFs recording mkdirp/writeFile/removeFile. */
export interface MemoryFs extends ServiceFs {
	readonly files: Map<string, string>;
	readonly mkdirs: string[];
	readonly removed: string[];
	readonly writes: RecordedWrite[];
}

/** Build an in-memory fs. `failWrite` makes writeFile throw (the permission-error path). */
export function createMemoryFs(failWrite = false): MemoryFs {
	const files = new Map<string, string>();
	const mkdirs: string[] = [];
	const removed: string[] = [];
	const writes: RecordedWrite[] = [];
	return {
		files,
		mkdirs,
		removed,
		writes,
		mkdirp(dir: string): void {
			mkdirs.push(dir);
		},
		writeFile(path: string, content: string): void {
			if (failWrite) throw new Error("EACCES: permission denied");
			files.set(path, content);
			writes.push({ path, content });
		},
		removeFile(path: string): void {
			files.delete(path);
			removed.push(path);
		},
	};
}

/** A fixed environment for a given platform (so tests never read the real host). */
export function fixedEnv(overrides: Partial<ServiceEnvironment> & Pick<ServiceEnvironment, "platform">): ServiceEnvironment {
	return {
		platform: overrides.platform,
		home: overrides.home ?? "/home/tester",
		privileged: overrides.privileged ?? false,
		execPath: overrides.execPath ?? "/usr/local/bin/hivedoctor",
		...(overrides.preferSystemScope !== undefined ? { preferSystemScope: overrides.preferSystemScope } : {}),
	};
}
