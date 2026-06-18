/**
 * `honeycomb sessions` handler — PRD-020a (a-AC-2 / FR-9 / D-3).
 *
 * THE LOAD-BEARING CORRECTNESS RULE (D-3 / a-AC-2): `sessions prune` asks the daemon
 * to delete BOTH the matching `sessions` trace rows AND the paired
 * `/summaries/<user>/<sessionId>.md` `memory` summary rows, so traces and summaries
 * never DESYNC (no orphaned summary, no dangling trace). The CLI dispatches the INTENT
 * (a `DELETE /api/sessions/prune` with the `--before` / `--session-id` filter) through
 * the {@link DaemonClient} seam; the DAEMON performs the paired delete atomically and
 * owns the append-only soft-delete (the DeepLake unreliable-DELETE lesson). The CLI
 * builds NO SQL and never opens DeepLake (a-AC-3).
 *
 * `list` dispatches `GET /api/sessions` grouped by path for the logged-in author; `prune`
 * dispatches the paired delete. Both go ONLY through `deps.daemon`.
 */

import {
	type CommandDeps,
	type CommandResult,
	type DaemonRequest,
	type OutputSink,
} from "./contracts.js";

/**
 * The daemon route the prune intent dispatches to (the daemon performs the paired delete).
 * `server.ts` mounts no `/api/sessions` group, so — like 020b — sessions attach off the mounted
 * `/api/diagnostics` group (full path `/api/diagnostics/sessions/prune`).
 */
export const SESSIONS_PRUNE_ROUTE = "/api/diagnostics/sessions/prune" as const;
/** The daemon route the session list dispatches to (grouped-by-path listing). */
export const SESSIONS_LIST_ROUTE = "/api/diagnostics/sessions" as const;

/** A parsed `sessions` invocation: the subcommand + its filter (FR-9). */
export interface SessionsInvocation {
	/** `list` | `prune` (empty → usage). */
	readonly sub: string;
	/** `--before <date>` — prune sessions captured before this ISO date. */
	readonly before?: string;
	/** `--session-id <id>` — prune exactly one session by id. */
	readonly sessionId?: string;
}

/**
 * Parse a `sessions` argv tail (FR-9). Pure: recognizes `list` / `prune` and the two
 * mutually-useful filters. Fully testable now; the dispatch body is below.
 */
export function parseSessionsArgs(argv: readonly string[]): SessionsInvocation {
	const sub = argv.find((a) => !a.startsWith("--")) ?? "";
	const before = flagValue(argv, "--before");
	const sessionId = flagValue(argv, "--session-id");
	return {
		sub,
		...(before !== undefined ? { before } : {}),
		...(sessionId !== undefined ? { sessionId } : {}),
	};
}

/** Read a `--flag value` pair from an argv tail (`undefined` when absent). */
function flagValue(argv: readonly string[], flag: string): string | undefined {
	const idx = argv.indexOf(flag);
	if (idx < 0) return undefined;
	const val = argv[idx + 1];
	return val !== undefined && !val.startsWith("--") ? val : undefined;
}

/**
 * Build the daemon request a prune intent dispatches (a-AC-2 / FR-9). A `DELETE` to the
 * prune route with the `--before` / `--session-id` filter as query params — the DAEMON
 * resolves the logged-in author, matches the sessions, and tombstones the `sessions` rows
 * AND the paired `memory` summary rows together. Exported pure so a test asserts the exact
 * route + filter the CLI dispatches (no SQL is ever built here).
 */
export function buildPruneRequest(inv: SessionsInvocation): DaemonRequest {
	const query: Record<string, string> = {};
	if (inv.before !== undefined && inv.before.length > 0) query.before = inv.before;
	if (inv.sessionId !== undefined && inv.sessionId.length > 0) query["session-id"] = inv.sessionId;
	return {
		method: "DELETE",
		path: SESSIONS_PRUNE_ROUTE,
		...(Object.keys(query).length > 0 ? { query } : {}),
	};
}

/** Pull the paired tombstone counts out of the daemon's prune response (fail-soft). */
function pruneCounts(body: unknown): { matched: number; sessions: number; summaries: number } {
	const rec = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
	const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	return {
		matched: num(rec.matched),
		sessions: num(rec.sessionsTombstoned),
		summaries: num(rec.summariesTombstoned),
	};
}

/** Run `honeycomb sessions prune` — dispatch the paired-delete intent through the daemon. */
async function prune(inv: SessionsInvocation, deps: CommandDeps, out: OutputSink): Promise<CommandResult> {
	const res = await deps.daemon.send(buildPruneRequest(inv));
	if (res.status >= 400) {
		out(`error: prune failed (daemon ${res.status}).`);
		return { exitCode: 1 };
	}
	const counts = pruneCounts(res.body);
	out(
		`Pruned ${counts.matched} session${counts.matched === 1 ? "" : "s"} ` +
			`(${counts.sessions} trace${counts.sessions === 1 ? "" : "s"} + ` +
			`${counts.summaries} summar${counts.summaries === 1 ? "y" : "ies"} removed, paired).`,
	);
	return { exitCode: 0 };
}

/** Run `honeycomb sessions list` — list sessions grouped by path for the logged-in author. */
async function list(deps: CommandDeps, out: OutputSink): Promise<CommandResult> {
	const res = await deps.daemon.send({ method: "GET", path: SESSIONS_LIST_ROUTE });
	if (res.status >= 400) {
		out(`error: could not list sessions (daemon ${res.status}).`);
		return { exitCode: 1 };
	}
	const body = res.body !== null && typeof res.body === "object" ? (res.body as Record<string, unknown>) : {};
	const rows = Array.isArray(body.sessions) ? body.sessions : [];
	out(`${rows.length} session${rows.length === 1 ? "" : "s"}.`);
	return { exitCode: 0 };
}

/**
 * Run `honeycomb sessions <list|prune>` (a-AC-2 / D-3). `list` → `GET /api/sessions`;
 * `prune` → `DELETE /api/sessions/prune` with the filter, where the DAEMON deletes the
 * `sessions` rows AND the paired `memory` summary rows in one atomic operation so they never
 * desync. Every effect goes through `deps.daemon` — never DeepLake.
 */
export async function runSessionsCommand(inv: SessionsInvocation, deps: CommandDeps): Promise<CommandResult> {
	const out = deps.out ?? ((line: string): void => console.log(line));
	if (inv.sub === "prune") return prune(inv, deps, out);
	if (inv.sub === "list") return list(deps, out);
	out("usage: honeycomb sessions <list | prune [--before <date>] [--session-id <id>]>");
	return { exitCode: inv.sub === "" ? 0 : 1 };
}
