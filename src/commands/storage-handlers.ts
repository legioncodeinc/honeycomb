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

import { MEMORY_TYPES, isMemoryType, memoryTypeGuidance } from "../shared/memory-types.js";
import {
	type CommandDeps,
	type CommandResult,
	type DaemonRequest,
	type DaemonResponse,
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

/**
 * Drop a `--flag value` PAIR from an argv tail (both the flag and the word after it),
 * so the value does not leak into a downstream positional join. Returns a new array.
 */
function stripFlagPair(argv: readonly string[], flag: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === flag) {
			// Skip the flag AND its value (when the value is not itself another flag).
			if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) i += 1;
			continue;
		}
		out.push(argv[i] as string);
	}
	return out;
}

/**
 * Build the `remember` verb's request (PRD memory-type taxonomy). The memory body is the
 * joined non-flag tail, with the `--type <value>` pair stripped so the type token never leaks
 * into the remembered content. A `--type` is included in the body ONLY when it is one of the
 * six {@link MEMORY_TYPES} — an unknown value is rejected earlier in {@link runStorageVerb}
 * (before dispatch), so it never reaches here as a valid request. An omitted `--type` sends no
 * `type`, so the daemon applies the column default `fact`.
 */
function buildRememberRequest(argv: readonly string[]): DaemonRequest {
	const content = stripFlagPair(argv, "--type")
		.filter((a) => !a.startsWith("--"))
		.join(" ");
	const type = flagValue(argv, "--type");
	const body: Record<string, string> = { content };
	if (type !== undefined && isMemoryType(type)) body.type = type;
	return { method: "POST", path: "/api/memories", body };
}

/**
 * Validate a `remember --type` value against the CLOSED {@link MEMORY_TYPES} set (the CLI's
 * write-time gate). Returns an error MESSAGE (listing the valid values + their descriptions)
 * when a `--type` is present but unknown, or `null` when absent/valid. Keeping this here lets
 * {@link runStorageVerb} reject a bad type BEFORE any daemon dispatch.
 */
export function rememberTypeError(argv: readonly string[]): string | null {
	const type = flagValue(argv, "--type");
	if (type === undefined || isMemoryType(type)) return null;
	return [
		`error: unknown --type "${type}".`,
		`valid types: ${MEMORY_TYPES.join(", ")}`,
		"",
		memoryTypeGuidance(),
	].join("\n");
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
	// PRD-045f f-AC-3: `skillify` dispatches through the SAME `/api/skills` group shape as `skill`
	// — so `honeycomb skillify pull` ROUTES (`POST /api/skills/pull`) instead of falling through to
	// the generic `/api/skillify`, a group the daemon never mounts (a dead route is not dispatch).
	// 045g owns merging the duplicate `skill`/`skillify` CLI surfaces into one; here we only make
	// the registered `skillify` verb route correctly onto the live skills group.
	if (verb === "skill" || verb === "skillify") return buildSkillRequest(argv);
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

/** One recall hit from the daemon's `/api/memories/recall` response (`{hits, sources, degraded}`). */
interface RecallHit {
	/** The originating source/table (e.g. `memory`, `sessions`) — shown as the hit's origin tag. */
	readonly source?: string;
	/** The memory id — shown so a user can act on a specific hit. */
	readonly id?: string;
	/** The recalled text — truncated for readability in the human render. */
	readonly text?: string;
	/**
	 * The ENGINE's fused RRF relevance score (PRD-027 Wave 1). Rendered per hit; the CLI
	 * NEVER invents a score (D-4 / AC-4). Optional so an older daemon (pre-score) still renders.
	 */
	readonly score?: number;
}

/** The shape the daemon returns for a `recall` (parsed defensively — every field is optional). */
interface RecallResponseBody {
	/** The ordered hits. */
	readonly hits?: readonly RecallHit[];
	/** The distinct sources that contributed (display-only). */
	readonly sources?: readonly string[];
	/** True when the recall fell back to lexical/BM25 (no semantic embeddings) — surfaced to the user. */
	readonly degraded?: boolean;
}

/** The max chars of a hit's `text` shown in the human render before an ellipsis (keeps lines scannable). */
const RECALL_SNIPPET_MAX = 240;

/** Collapse whitespace + truncate a hit's text to a single readable snippet line. */
function snippet(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > RECALL_SNIPPET_MAX ? `${flat.slice(0, RECALL_SNIPPET_MAX)}…` : flat;
}

/**
 * Narrow an unknown daemon body into a {@link RecallResponseBody} (defensive — the body crosses the
 * daemon IO boundary). A non-object or a missing `hits` array yields an empty hit list, so the caller
 * cleanly renders "no memories found" rather than throwing on a malformed payload.
 */
function asRecallBody(body: unknown): RecallResponseBody {
	if (typeof body !== "object" || body === null) return {};
	return body as RecallResponseBody;
}

/**
 * Render a `recall` response (the b-recall fix — PRD-023 dogfood). Previously `recall` printed
 * `recall: ok` and DISCARDED the daemon's `{hits, sources, degraded}` payload, so a user saw no
 * memories. Now:
 *   - `--json` → the raw JSON body verbatim (machine-readable; the existing global flag);
 *   - empty hits → a clean `no memories found for "<query>"`;
 *   - otherwise → one line per hit (`[source] id  (score)` + a truncated snippet of `text`),
 *     rendered in the ENGINE order (the daemon already returns the hits ranked DESC by the
 *     fused RRF relevance — distilled `[memory]` facts above raw `[sessions]` drill-downs — so
 *     this loop iterates them verbatim, NEVER re-sorting and NEVER inventing a score), and a
 *     `(lexical fallback)` marker when `degraded` is true so the user knows recall ran without
 *     semantic embeddings.
 * The OTHER storage verbs keep the unchanged `<verb>: ok` render — only `recall` is special-cased.
 */
function renderRecall(query: string, res: DaemonResponse, json: boolean, out: OutputSink): void {
	if (json) {
		out(JSON.stringify(res.body ?? {}, null, 2));
		return;
	}
	const parsed = asRecallBody(res.body);
	const hits = parsed.hits ?? [];
	if (hits.length === 0) {
		out(`no memories found for "${query}"`);
		return;
	}
	if (parsed.degraded === true) {
		out("(lexical fallback)");
	}
	// Render in the engine's ranked order — no client-side sort. Distilled `[memory]` hits
	// already precede raw `[sessions]` drill-downs because the engine fused + ordered them.
	for (const hit of hits) {
		const origin = hit.source !== undefined && hit.source.length > 0 ? hit.source : "memory";
		const id = hit.id !== undefined && hit.id.length > 0 ? hit.id : "(no id)";
		const score = typeof hit.score === "number" ? `(${hit.score.toFixed(2)})  ` : "";
		const body = typeof hit.text === "string" && hit.text.length > 0 ? snippet(hit.text) : "(no text)";
		out(`[${origin}] ${id}  ${score}${body}`);
	}
}

/**
 * Run a storage verb (FR-3 / a-AC-3). Parse the verb's subcommand into a {@link DaemonRequest},
 * `deps.daemon.send` it, and render the response. The dispatch goes ONLY through `deps.daemon`
 * — no DeepLake. One body, parameterized by verb, keeps the duplication floor (jscpd < 7).
 *
 * `json` is the parsed `--json` global flag (default `false`); only `recall` consumes it today, to
 * print the raw daemon body instead of the human-rendered hit list. Every other verb keeps the
 * unchanged `<verb>: ok` render.
 */
export async function runStorageVerb(
	verb: string,
	argv: readonly string[],
	deps: CommandDeps,
	json = false,
): Promise<CommandResult> {
	const out: OutputSink = deps.out ?? ((line: string): void => console.log(line));
	// PRD memory-type taxonomy: reject an unknown `remember --type` BEFORE any daemon dispatch,
	// naming the valid set + when to use each. A valid/omitted type falls through unchanged.
	if (verb === "remember") {
		const typeError = rememberTypeError(argv);
		if (typeError !== null) {
			out(typeError);
			return { exitCode: 2 };
		}
	}
	const req = buildStorageRequest(verb, argv);
	const res = await deps.daemon.send(req);
	if (res.status >= 400) {
		out(`error: ${verb} failed (daemon ${res.status}).`);
		return { exitCode: 1 };
	}
	if (verb === "recall") {
		// The query is the joined non-flag tail — the SAME derivation buildRecallRequest uses.
		const query = argv.filter((a) => !a.startsWith("--")).join(" ");
		renderRecall(query, res, json, out);
		return { exitCode: 0 };
	}
	out(`${verb}: ok`);
	return { exitCode: 0 };
}
