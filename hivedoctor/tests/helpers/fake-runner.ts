/**
 * Test-only fake {@link CommandRunner}: records every argv and returns canned results,
 * so a rung test NEVER actually runs npm (binding constraint, PRD-064c). Built-ins only.
 */

import type { CommandResult, CommandRunner } from "../../src/rungs/command-runner.js";

/** One recorded invocation. */
export interface RecordedCall {
	readonly command: string;
	readonly args: readonly string[];
}

/** A fake runner plus the recording of what it was asked to run. */
export interface FakeRunner extends CommandRunner {
	/** Every (command, args) pair the rung asked the runner to run, in order. */
	readonly calls: RecordedCall[];
}

/** Default success result. */
const OK: CommandResult = { ok: true, code: 0, stdout: "", stderr: "" };

/**
 * Build a fake runner. `responder` decides the result per call (so a test can fail a
 * specific argv, or stream a version line); defaults to a clean success.
 */
export function createFakeRunner(
	responder: (command: string, args: readonly string[]) => CommandResult = () => OK,
): FakeRunner {
	const calls: RecordedCall[] = [];
	return {
		calls,
		async run(command: string, args: readonly string[]): Promise<CommandResult> {
			calls.push({ command, args: [...args] });
			return responder(command, args);
		},
	};
}
