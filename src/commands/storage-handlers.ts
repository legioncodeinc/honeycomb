/**
 * The daemon-routed storage verb handlers — PRD-020a (FR-3 / FR-5 / a-AC-3 / a-AC-6).
 *
 * EVERY verb here is `cls: "storage"` in the verb table: it issues a daemon request
 * through the {@link DaemonClient} seam and NEVER opens DeepLake (a-AC-3). The handlers
 * are deliberately grouped in one module because they share one shape — parse the
 * subcommand, build a {@link DaemonRequest}, dispatch, render — so the duplication floor
 * (jscpd < 7) is respected by routing them through one {@link runStorageVerb} helper
 * rather than copy-pasting a fetch per verb.
 *
 * Verbs covered: `remember`, `recall`, `agent`, `ontology`, `secret`, `skill`, `route`,
 * `sources`, `graph`, `goal`. (`sessions` lives in `sessions.ts` because its paired-delete
 * correctness rule (D-3) warrants its own module; `status`/`dashboard`/local verbs live
 * elsewhere.)
 *
 * The `skill` verb (FR-5 / a-AC-6) reaches skillify scope/pull/unpull/force — e.g.
 * `honeycomb skill scope team --users alice,bob` → `POST /api/skills/scope` — through the
 * SAME daemon seam (the daemon owns the `skills` table; the CLI dispatches intent).
 */

import {
	type CommandDeps,
	type CommandResult,
	type DaemonRequest,
	type OutputSink,
} from "./contracts.js";

/**
 * The daemon ROUTE each storage verb dispatches to (FR-3). The daemon already mounts
 * these groups (`server.ts` ROUTE_GROUPS): `/api/memories`, `/api/skills`, `/api/sources`,
 * `/api/graph`, `/api/goals`, `/api/ontology`, `/api/secrets`, `/api/inference` (route),
 * `/v1` (agent). A handler maps its subcommand onto a method + sub-path under its group.
 */
export const STORAGE_VERB_ROUTES: Readonly<Record<string, string>> = Object.freeze({
	remember: "/api/memories",
	recall: "/api/memories/recall",
	agent: "/v1/agent",
	ontology: "/api/ontology",
	secret: "/api/secrets",
	skill: "/api/skills",
	route: "/api/inference/routes",
	sources: "/api/sources",
	graph: "/api/graph",
	goal: "/api/goals",
});

/** Pull the first non-flag word (the subcommand) off an argv tail. */
function subcommandOf(argv: readonly string[]): string {
	return argv.find((a) => !a.startsWith("--")) ?? "";
}

/** Read a `--flag value` pair off an argv tail (`undefined` when absent). */
function flagValue(argv: readonly string[], flag: string): string | undefined {
	const idx = argv.indexOf(flag);
	if (idx < 0) return undefined;
	const v = argv[idx + 1];
	return v !== undefined && !v.startsWith("--") ? v : undefined;
}

/**
 * Build the `skill` verb's daemon request (FR-5 / a-AC-6). Maps the skillify subcommands onto
 * the `/api/skills` group:
 *   - `skill scope <team|org|private> --users a,b` → `POST /api/skills/scope`
 *   - `skill pull [--force]`                       → `POST /api/skills/pull`
 *   - `skill unpull <name>`                        → `POST /api/skills/unpull`
 *   - `skill force <name>`                         → `POST /api/skills/force`
 * Every value lands in the JSON body — the daemon owns the SQL.
 */
function buildSkillRequest(argv: readonly string[]): DaemonRequest {
	const sub = subcommandOf(argv);
	const rest = argv.filter((a) => !a.startsWith("--"));
	if (sub === "scope") {
		const scope = rest[1] ?? "";
		const users = (flagValue(argv, "--users") ?? "")
			.split(",")
			.map((u) => u.trim())
			.filter((u) => u.length > 0);
		const force = argv.includes("--force");
		return { method: "POST", path: "/api/skills/scope", body: { scope, users, force } };
	}
	if (sub === "pull") {
		return { method: "POST", path: "/api/skills/pull", body: { force: argv.includes("--force") } };
	}
	if (sub === "unpull") {
		return { method: "POST", path: "/api/skills/unpull", body: { name: rest[1] ?? "" } };
	}
	if (sub === "force") {
		return { method: "POST", path: "/api/skills/force", body: { name: rest[1] ?? "" } };
	}
	return { method: "GET", path: "/api/skills" };
}

/** Build the `remember` verb's request — the memory body is the joined non-flag tail. */
function buildRememberRequest(argv: readonly string[]): DaemonRequest {
	const content = argv.filter((a) => !a.startsWith("--")).join(" ");
	return { method: "POST", path: "/api/memories", body: { content } };
}

/** Build the `recall` verb's request — the query is the joined non-flag tail. */
function buildRecallRequest(argv: readonly string[]): DaemonRequest {
	const query = argv.filter((a) => !a.startsWith("--")).join(" ");
	return { method: "POST", path: "/api/memories/recall", body: { query } };
}

/**
 * Build the {@link DaemonRequest} for a storage verb's subcommand (FR-3 / a-AC-3 / a-AC-6).
 * `skill`, `remember`, and `recall` have bespoke shapes; every OTHER storage verb maps its
 * subcommand onto a `<METHOD> <group>[/<sub>]` under its route group with the non-flag tail
 * carried as the JSON body. Exported pure so a test asserts the EXACT route/body each
 * subcommand produces. NEVER builds SQL — the daemon does.
 */
export function buildStorageRequest(verb: string, argv: readonly string[]): DaemonRequest {
	if (verb === "skill") return buildSkillRequest(argv);
	if (verb === "remember") return buildRememberRequest(argv);
	if (verb === "recall") return buildRecallRequest(argv);

	const base = STORAGE_VERB_ROUTES[verb] ?? `/api/${verb}`;
	const sub = subcommandOf(argv);
	const args = argv.filter((a) => !a.startsWith("--")).slice(1);
	// A read-shaped subcommand (`list`/`get`/`show`/`status`/none) is a GET; everything else
	// (create/connect/build/set/...) is a POST carrying the args as the body.
	const isRead = sub === "" || sub === "list" || sub === "get" || sub === "show" || sub === "status";
	if (isRead) {
		return { method: "GET", path: sub === "" || sub === "list" ? base : `${base}/${sub}` };
	}
	return { method: "POST", path: `${base}/${sub}`, body: { args } };
}

/**
 * Run a storage verb (FR-3 / a-AC-3). Parse the verb's subcommand into a {@link DaemonRequest},
 * `deps.daemon.send` it, and render the response. The dispatch goes ONLY through `deps.daemon`
 * — no DeepLake. One body, parameterized by verb, keeps the duplication floor (jscpd < 7).
 */
export async function runStorageVerb(verb: string, argv: readonly string[], deps: CommandDeps): Promise<CommandResult> {
	const out: OutputSink = deps.out ?? ((line: string): void => console.log(line));
	const req = buildStorageRequest(verb, argv);
	const res = await deps.daemon.send(req);
	if (res.status >= 400) {
		out(`error: ${verb} failed (daemon ${res.status}).`);
		return { exitCode: 1 };
	}
	out(`${verb}: ok`);
	return { exitCode: 0 };
}
