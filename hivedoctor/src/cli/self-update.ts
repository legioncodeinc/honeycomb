/**
 * `self-update`: THE ONLY path that updates HiveDoctor's own package (PRD-064f AC-064f.5,
 * parent AC-6).
 *
 * "Never surprise-update itself" is sacred (PRD-064 design principle / parent AC-6):
 * HiveDoctor is built NOT to need updating, and no autonomous code path - not the watch
 * loop, not rung 2, not the 064e auto-update engine - ever installs
 * `@legioncodeinc/hivedoctor`. The auto-update engine's package is HARD-WIRED to the
 * PRIMARY daemon (`@legioncodeinc/honeycomb`); it cannot target HiveDoctor. This module is
 * the single, deliberate exception, reachable only by the explicit `hivedoctor self-update`
 * command.
 *
 * It runs `npm i -g @legioncodeinc/hivedoctor@latest` through the SAME injected
 * {@link CommandRunner} the rungs use (no shell, argv array, never throws). Crash-safe: a
 * failed install is a returned message, never a thrown error. Built-ins only.
 */

import type { CommandRunner } from "../rungs/command-runner.js";
import type { Logger } from "../logger.js";
import { HIVEDOCTOR_PACKAGE } from "../version.js";

/** Construction deps for {@link createSelfUpdate}. */
export interface SelfUpdateDeps {
	/** The injected command runner (the only thing that touches npm). */
	readonly runner: CommandRunner;
	/** Logger for the self-update lifecycle. */
	readonly logger: Logger;
	/** The dist-tag / spec to install (default `latest`). */
	readonly tag?: string;
	/** Per-install timeout in ms (default: the runner's own default). */
	readonly installTimeoutMs?: number;
}

/** Stable action verb for logs. */
const ACTION = "self-update";

/**
 * Build the self-update action. Returns a human-readable result line (success or a
 * scrubbed failure detail); NEVER throws. Calling this is the ONLY way
 * `@legioncodeinc/hivedoctor` is ever installed.
 */
export function createSelfUpdate(deps: SelfUpdateDeps): () => Promise<string> {
	const tag = deps.tag ?? "latest";
	return async (): Promise<string> => {
		const spec = `${HIVEDOCTOR_PACKAGE}@${tag}`;
		deps.logger.info(`${ACTION}.start`, { spec });
		const result = await deps.runner.run(
			"npm",
			["install", "-g", spec],
			deps.installTimeoutMs !== undefined ? { timeoutMs: deps.installTimeoutMs } : undefined,
		);
		if (result.ok) {
			deps.logger.info(`${ACTION}.ok`, { spec });
			return `HiveDoctor updated (${spec}). Restart any running HiveDoctor process to pick it up.`;
		}
		deps.logger.error(`${ACTION}.failed`, { code: result.code, detail: result.detail });
		return `HiveDoctor self-update failed: ${result.detail ?? `npm exited ${result.code ?? "non-zero"}`}.`;
	};
}
