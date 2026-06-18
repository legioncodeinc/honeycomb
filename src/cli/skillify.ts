/**
 * `honeycomb skillify pull` CLI — PRD-016c (c-AC-1 / c-AC-5 / c-AC-6).
 *
 *   - `honeycomb skillify pull` — read the latest team skills THROUGH THE DAEMON and write
 *     `~/.claude/skills/<name>--<author>/SKILL.md` for each, symlinking that canonical dir
 *     into every OTHER detected agent root (fan-out). Prints how many skills + symlinks
 *     landed and how many were skipped (local already at/newer than remote — FR-3).
 *
 * ── Boundary: the CLI imports NO DeepLake path (invariant.test.ts) ──────────
 * This is a thin client: it imports neither `src/daemon/storage` nor the daemon core. The
 * pull reaches the `skills` table ONLY through the INJECTED {@link SkillPullClient} seam
 * (the daemon-assembly wiring supplies the real `createDaemonPullClient` over the daemon
 * dispatch; the AC-named test supplies a fake). The agent roots are injected too, so a test
 * points them at temp dirs. The CLI itself touches no storage and no DeepLake — c-AC-6 holds
 * by construction.
 *
 * Note: the bundled `honeycomb` bin is not yet extended to dispatch here; that is the
 * deferred pure-wiring assembly step (mirrors `org.ts` / `route.ts`). This module is
 * constructed-and-tested (the AC-named CLI test drives {@link runSkillifyCommand} with fakes).
 */

import {
	type AgentRootDetector,
	pull,
	type PullOutcome,
	type SkillPullClient,
} from "../daemon-client/skillify/index.js";

/** A line-sink so command output is capturable in tests (no direct stdout). */
export interface SkillifyOutputSink {
	(line: string): void;
}

/**
 * The injectable seams the skillify CLI runs against (c-AC-1 / c-AC-6). The daemon-assembly
 * wiring supplies the real impls; the AC-named test injects fakes (a fake pull client + temp
 * agent roots) so no daemon and no real `~/.claude` are touched.
 */
export interface SkillifyCommandDeps {
	/** The pull seam — reads the latest skills THROUGH THE DAEMON (c-AC-6). */
	readonly client: SkillPullClient;
	/** The detected agent roots for the fan-out (c-AC-5) — injectable for tests. */
	readonly roots: AgentRootDetector;
	/** The output sink (defaults to `console.log`). */
	readonly out?: SkillifyOutputSink;
}

/** Outcome of a skillify command: exit code + the pull result (when a pull ran). */
export interface SkillifyResult {
	readonly exitCode: number;
	/** The pull outcome, or `null` for a usage / unknown sub-command. */
	readonly outcome: PullOutcome | null;
}

/** The parsed `skillify` invocation: the verb (`pull`) + nothing else for now. */
export interface SkillifyInvocation {
	/** The sub-command verb (`pull` | ""). */
	readonly verb: string;
}

/**
 * Parse a raw `skillify` argv tail (everything AFTER the `skillify` word). The first non-flag
 * word is the verb (`pull`).
 */
export function parseSkillifyArgs(argv: readonly string[]): SkillifyInvocation {
	const words = argv.filter((a) => !a.startsWith("--"));
	return { verb: words[0] ?? "" };
}

/**
 * Run a parsed `skillify` command (c-AC-1 / c-AC-5 / c-AC-6). Dispatches to {@link pull} via
 * the injected seams. The pull reaches storage ONLY through the daemon dispatch seam; the CLI
 * touches no DeepLake.
 */
export async function runSkillifyCommand(inv: SkillifyInvocation, deps: SkillifyCommandDeps): Promise<SkillifyResult> {
	const out = deps.out ?? ((line: string): void => console.log(line));

	if (inv.verb === "pull") {
		const outcome = await pull({ client: deps.client, roots: deps.roots });
		out(
			`Pulled ${outcome.skillsWritten} skill${outcome.skillsWritten === 1 ? "" : "s"}, ` +
				`fanned out ${outcome.symlinksCreated} symlink${outcome.symlinksCreated === 1 ? "" : "s"}` +
				(outcome.skillsSkipped > 0 ? `, skipped ${outcome.skillsSkipped} (local up to date)` : "") +
				".",
		);
		return { exitCode: 0, outcome };
	}

	out("usage: honeycomb skillify pull");
	return { exitCode: inv.verb === "" ? 0 : 1, outcome: null };
}

/** Convenience entry: parse + run a `skillify` argv tail in one call (c-AC-1). */
export function skillifyMain(argv: readonly string[], deps: SkillifyCommandDeps): Promise<SkillifyResult> {
	return runSkillifyCommand(parseSkillifyArgs(argv), deps);
}
