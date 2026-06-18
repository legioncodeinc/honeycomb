/**
 * `honeycomb skill` CLI — PRD-018a (scope) + 018b (unpull).
 *
 *   - `honeycomb skill scope <me|team> [--users alice,bob] [--install project|global]`
 *     — persist the sharing config to `~/.honeycomb/state/skillify/config.json` (a-AC-2).
 *     `team` carries the configured contributor list a later publish stamps. `--install`
 *     sets where pulls land (drives 018c's global-only fan-out). A legacy `org` config is
 *     coerced to `team` on read (a-AC-3 — the store handles it).
 *   - `honeycomb skill unpull <name>--<author>` — reverse a PULL-MANAGED entry (018b): remove
 *     the recorded symlinks + canonical dir + manifest record. A skill the user mined
 *     themselves (never in the manifest) is left untouched.
 *
 * ── Boundary: the CLI imports NO DeepLake path (invariant.test.ts) ──────────
 * A thin client: it touches the LOCAL config + manifest files (filesystem-only seams) and,
 * for a future `scope` that needs the daemon, would dispatch — but scope/unpull are purely
 * local, so this module opens NO DeepLake and reaches no storage. The seams are injected so
 * the AC-named test drives the surface against temp dirs (no real `~`).
 *
 * Note: the bundled `honeycomb` bin is not yet extended to dispatch here; that is the
 * deferred pure-wiring assembly step (mirrors `org.ts` / `skillify.ts`). This module is
 * constructed-and-tested (the AC-named CLI test drives {@link runSkillCommand} with fakes).
 */

import {
	createPullManifestStore,
	createSkillifyConfigStore,
	parseUsersList,
	type SkillifyConfig,
	type SkillifyConfigStore,
	type PullManifestStore,
	type SkillInstall,
	type SkillScope,
	unpullSkill,
} from "../daemon-client/skillify/index.js";

/** A line-sink so command output is capturable in tests (no direct stdout). */
export interface SkillOutputSink {
	(line: string): void;
}

/**
 * The injectable seams the skill CLI runs against (a-AC-2). All default to the real impls
 * (rooted at `~/.honeycomb/state/skillify`); the AC-named test injects fakes (a temp config
 * store + a temp manifest store) so no real `~` is touched.
 */
export interface SkillCommandDeps {
	/** The scope/team/install config store (a-AC-2 / a-AC-3). */
	readonly config?: SkillifyConfigStore;
	/** The pull manifest store (018b unpull). */
	readonly manifest?: PullManifestStore;
	/** The output sink (defaults to `console.log`). */
	readonly out?: SkillOutputSink;
}

/** Outcome of a skill command: exit code + whether on-disk state changed. */
export interface SkillResult {
	readonly exitCode: number;
	/** True iff the config or manifest was written. */
	readonly wrote: boolean;
}

/** The parsed `skill` invocation: the verb, a positional arg, and the parsed flags. */
export interface SkillInvocation {
	/** The sub-command verb (`scope` | `unpull` | ""). */
	readonly verb: string;
	/** The positional argument (the scope value, or the `<name>--<author>` dir). */
	readonly arg?: string;
	/** `--users alice,bob` → the parsed user list (scope). */
	readonly users?: readonly string[];
	/** `--install project|global` → the install target (scope). */
	readonly install?: SkillInstall;
}

/**
 * Parse a raw `skill` argv tail (everything AFTER the `skill` word). The first non-flag word
 * is the verb (`scope` | `unpull`); the second is the positional arg. `--users a,b` and
 * `--install project|global` are parsed as `--flag value` OR `--flag=value`.
 */
export function parseSkillArgs(argv: readonly string[]): SkillInvocation {
	const words: string[] = [];
	let users: readonly string[] | undefined;
	let install: SkillInstall | undefined;

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		if (a === "--users" || a.startsWith("--users=")) {
			const value = a.includes("=") ? a.slice(a.indexOf("=") + 1) : (argv[++i] ?? "");
			users = parseUsersList(value);
		} else if (a === "--install" || a.startsWith("--install=")) {
			const value = a.includes("=") ? a.slice(a.indexOf("=") + 1) : (argv[++i] ?? "");
			install = value === "global" ? "global" : "project";
		} else if (!a.startsWith("--")) {
			words.push(a);
		}
	}

	const inv: SkillInvocation = { verb: words[0] ?? "" };
	return {
		...inv,
		...(words[1] !== undefined ? { arg: words[1] } : {}),
		...(users !== undefined ? { users } : {}),
		...(install !== undefined ? { install } : {}),
	};
}

/** Resolve the deps with their real defaults. */
function withDefaults(deps: SkillCommandDeps): Required<SkillCommandDeps> {
	return {
		config: deps.config ?? createSkillifyConfigStore(),
		manifest: deps.manifest ?? createPullManifestStore(),
		out: deps.out ?? ((line: string): void => console.log(line)),
	};
}

/**
 * `honeycomb skill scope <me|team> [--users …] [--install …]` (a-AC-2). Persists the scope,
 * merging the parsed `--users` into the team list (only meaningful for `team`) and the
 * `--install` target. Re-reads the prior config first so `--install` without `--users`
 * preserves the team list, and vice versa.
 */
function scope(inv: SkillInvocation, deps: Required<SkillCommandDeps>): SkillResult {
	const out = deps.out;
	const raw = inv.arg ?? "";
	if (raw !== "me" && raw !== "team") {
		out("usage: honeycomb skill scope <me|team> [--users alice,bob] [--install project|global]");
		return { exitCode: 1, wrote: false };
	}
	const scopeValue: SkillScope = raw;
	const prior = deps.config.read();
	// `team` adopts the parsed --users (or keeps the prior team); `me` keeps the team list
	// configured (a switch back to me does not erase the roster).
	const team = inv.users !== undefined ? inv.users : prior.team;
	const install: SkillInstall = inv.install ?? prior.install;
	const next: SkillifyConfig = { scope: scopeValue, team, install };
	const written = deps.config.write(next);
	out(
		`Scope set to ${written.scope}` +
			(written.scope === "team" && written.team.length > 0 ? ` (team: ${written.team.join(", ")})` : "") +
			`, install ${written.install}.`,
	);
	return { exitCode: 0, wrote: true };
}

/**
 * `honeycomb skill unpull <name>--<author>` (018b). Reverses a pull-managed manifest entry:
 * removes the recorded symlinks (only links resolving to OUR canonical dir), the canonical
 * dir, and the manifest record. An unmanaged dir (never pulled) prints a clear message + a
 * non-error exit so a script can branch.
 */
function unpull(inv: SkillInvocation, deps: Required<SkillCommandDeps>): SkillResult {
	const out = deps.out;
	const dirName = inv.arg ?? "";
	if (dirName === "") {
		out("usage: honeycomb skill unpull <name>--<author>");
		return { exitCode: 1, wrote: false };
	}
	const outcome = unpullSkill(deps.manifest, dirName);
	if (!outcome.removed) {
		out(`No pull-managed skill '${dirName}' found. (unpull reverses pulled skills only.)`);
		return { exitCode: 0, wrote: false };
	}
	out(`Unpulled ${dirName}: removed the canonical dir and ${outcome.symlinksRemoved} symlink(s).`);
	return { exitCode: 0, wrote: true };
}

/**
 * Run a parsed `skill` command (a-AC-2 / 018b). The seams are injected so the AC-named test
 * drives the whole surface against temp dirs (a temp config + manifest store) without a real
 * home dir. The CLI touches no storage and no DeepLake.
 */
export function runSkillCommand(inv: SkillInvocation, deps: SkillCommandDeps): SkillResult {
	const resolved = withDefaults(deps);
	if (inv.verb === "scope") return scope(inv, resolved);
	if (inv.verb === "unpull") return unpull(inv, resolved);
	resolved.out("usage: honeycomb skill <scope <me|team> | unpull <name>--<author>>");
	return { exitCode: inv.verb === "" ? 0 : 1, wrote: false };
}

/** Convenience entry: parse + run a `skill` argv tail in one call. */
export function skillMain(argv: readonly string[], deps: SkillCommandDeps): SkillResult {
	return runSkillCommand(parseSkillArgs(argv), deps);
}
