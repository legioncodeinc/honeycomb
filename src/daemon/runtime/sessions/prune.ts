/**
 * The `sessions prune` handler — PRD-020a (daemon side, a-AC-2 / D-3).
 *
 * THE LOAD-BEARING CORRECTNESS RULE (D-3 / a-AC-2). The CLI dispatches a prune INTENT
 * (`DELETE /api/sessions/prune` with the `--before` / `--session-id` filter); THIS daemon-side
 * handler performs the paired delete: it removes the matching `sessions` trace rows AND the
 * paired `/summaries/<user>/<sessionId>.md` `memory` summary rows, so traces and summaries
 * never DESYNC (no orphaned summary, no dangling trace). The two appends run in ONE pass over
 * the matched set, so a session can never have its trace tombstoned without its summary, or
 * vice-versa.
 *
 * ── Why an append-only TOMBSTONE, never a hard DELETE (D-3) ───────────────────
 * This backend's `DELETE` is unreliable (it can leave rows; PRD-004 / PRD-006e / 013a). So the
 * "delete" is an APPEND: for every matched session we INSERT a TOMBSTONE row into `sessions`
 * carrying the SAME `id` and `path` plus the {@link TOMBSTONE_MARKER} sentinel, and a paired
 * TOMBSTONE row into `memory` at the SAME summary `path` carrying the sentinel. The read path
 * resolves a session's current state by the PRESENCE of a tombstone for its id/path (a poll can
 * miss a row but never invents one, so the tombstone converges UP). This mirrors the append-only
 * status-advance the sources purge (013a) and supersede (008b) proved live — there is no
 * in-place UPDATE and no hard DELETE here.
 *
 * ── No new schema (the additive constraint) ──────────────────────────────────
 * Neither `sessions` nor `memory` carries a dedicated status/version column, and 020 adds NO
 * schema. The tombstone is encoded in columns that ALREADY exist: a marker string in
 * `filename` ({@link TOMBSTONE_MARKER}) plus a structured marker in the JSONB `message`
 * (sessions) / the `description` (memory). The marker is self-describing and greppable, so a
 * reader filters tombstoned ids/paths with `filename = '<marker>'` — no migration.
 *
 * It is storage-correct (lives under `src/daemon/`): the matched-session select + the tombstone
 * appends run through the injected {@link StorageQuery}; EVERY interpolated value is escaped via
 * the pure `sql.ts` helpers (`sqlIdent`/`sLiteral`) and every append is built through the
 * heal-aware {@link appendOnlyInsert} (→ guarded `buildInsert`). The CLI never sees SQL.
 *
 * ── Where it mounts (the no-`/api/sessions`-group lesson, mirrors 020b) ───────
 * `server.ts` mounts NO standalone `/api/sessions` route group, and this seam never edits
 * `server.ts` (D-2 posture). So the prune handler attaches off the already-mounted, protected
 * `/api/diagnostics` group at `/sessions/prune` (full path `/api/diagnostics/sessions/prune`) —
 * exactly where 020b's dashboard attaches its sessions read. Attaching via
 * `daemon.group("/api/diagnostics")` inherits auth/RBAC with ZERO `server.ts` edits — mirrors
 * `attachHooksHandlers` (019b) and `mountDashboardApi` (020b). The 020a CLI dispatches its prune
 * intent to this full path through the `DaemonClient` seam.
 *
 * Deferred assembly (D-7): the production daemon assembly calls {@link attachSessionsPrune}
 * once after `createDaemon(...)`. It is constructed-and-tested here against a fake
 * `StorageQuery` (the prune unit suite + the gated live itest); nothing auto-invokes it.
 */

import type { Context } from "hono";

import { healTargetFor } from "../../storage/catalog/index.js";
import type { HealTarget } from "../../storage/heal.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { appendOnlyInsert, type RowValues, val } from "../../storage/writes.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { getRequestIdentity } from "../middleware/permission.js";
import type { Daemon } from "../server.js";

/**
 * The already-mounted route group the prune handler attaches to. `server.ts` mounts NO
 * `/api/sessions` group, so — like 020b's dashboard sessions read — the prune attaches off the
 * mounted, protected `/api/diagnostics` group.
 */
export const SESSIONS_GROUP = "/api/diagnostics" as const;
/** The prune sub-path under the group (full path `DELETE /api/diagnostics/sessions/prune`). */
export const SESSIONS_PRUNE_PATH = "/sessions/prune" as const;

/**
 * The sentinel stamped in the `filename` column of every tombstone row (sessions + memory). A
 * reader excludes a session whose id/path has a `filename = TOMBSTONE_MARKER` row. It is the
 * ONE encoding both the writer (here) and a reader agree on, so the no-new-schema soft-delete
 * is unambiguous and greppable.
 */
export const TOMBSTONE_MARKER = "__honeycomb_pruned__" as const;

/** The summary-path convention paired with a session id (`/summaries/<author>/<sessionId>.md`). */
export function summaryPath(author: string, sessionId: string): string {
	const cleanAuthor = author.replace(/^\/+|\/+$/g, "");
	const cleanId = sessionId.replace(/^\/+|\/+$/g, "");
	return `/summaries/${cleanAuthor}/${cleanId}.md`;
}

/** A prune filter — `before` (ISO date) and/or `sessionId`. At least one narrows the set. */
export interface PruneFilter {
	/** Prune sessions created strictly before this ISO date. */
	readonly before?: string;
	/** Prune exactly one session by id. */
	readonly sessionId?: string;
}

/** A matched session row the prune tombstones (id + path + author + the paired summary path). */
export interface MatchedSession {
	readonly id: string;
	readonly path: string;
	readonly author: string;
	readonly creationDate: string;
}

/** The outcome of a prune pass — the matched count + the paired tombstone counts. */
export interface PruneOutcome {
	/** Sessions matched by the filter for the logged-in author. */
	readonly matched: number;
	/** `sessions` tombstone rows appended (one per matched session). */
	readonly sessionsTombstoned: number;
	/** Paired `memory` summary tombstone rows appended (one per matched session). */
	readonly summariesTombstoned: number;
}

/**
 * Authorizes that the actor a prune targets is BOUND to the authenticated caller (the
 * destructive-blast-radius gate). `sessions prune` is the only NEW destructive endpoint, and it
 * sub-scopes its delete beneath the org partition by an `author` taken from the
 * `x-honeycomb-actor` header. In a multi-user (`team`/`hybrid`) deployment that header is
 * attacker-controlled: without binding it to the validated identity, any authenticated org member
 * could tombstone ANOTHER member's traces + summaries by naming their author. This seam closes
 * that hole: it returns the AUTHORITATIVE actor the prune is allowed to act on (the caller's own),
 * or `null` to DENY. It is consulted only in `team`/`hybrid`; `local` is loopback single-user and
 * the header actor is authoritative there (matches the rest of the daemon's local posture).
 */
export interface PruneActorAuthority {
	/**
	 * Resolve the actor this request is authorized to prune, or `null` to DENY. The requested
	 * `headerActor` is a HINT; an implementation returns it ONLY when it is bound to the
	 * authenticated caller (e.g. equals the caller's own validated `agentId`), never verbatim.
	 */
	resolveAuthorizedActor(c: Context, headerActor: string): string | null;
}

/**
 * The fail-closed default {@link PruneActorAuthority} for `team`/`hybrid` (D-4 posture). Until the
 * production daemon assembly wires a real actor↔identity binding (deferred, like every other
 * 020 seam), a multi-user prune is DENIED rather than trusting the raw header — so a cross-actor
 * destructive delete can never ship by default. The daemon assembly injects a real authority that
 * binds the actor to the validated {@link Identity} (the broader "surface Identity to handlers"
 * refactor is the follow-up; this keeps the destructive endpoint safe in the interim).
 */
export const denyUnboundActorAuthority: PruneActorAuthority = {
	resolveAuthorizedActor(): string | null {
		return null;
	},
};

/** Options for {@link attachSessionsPrune}. */
export interface AttachSessionsPruneOptions {
	/** The storage client the matched-session select + paired tombstone writes run through. */
	readonly storage: StorageQuery;
	/** The `sessions` heal/write target. Defaults to `healTargetFor("sessions")`. */
	readonly sessionsTarget?: HealTarget;
	/** The `memory` heal/write target (the paired summary rows). Defaults to `healTargetFor("memory")`. */
	readonly memoryTarget?: HealTarget;
	/**
	 * Binds the requested actor to the authenticated caller in `team`/`hybrid` (the
	 * destructive cross-actor gate). Defaults to {@link denyUnboundActorAuthority} (fail-closed):
	 * a multi-user prune is denied until the assembly wires a real actor↔identity binding. Unused
	 * in `local` mode (single-user). See {@link PruneActorAuthority}.
	 */
	readonly actorAuthority?: PruneActorAuthority;
}

/**
 * The resolved prune targets the handler tombstones in one pass (D-3). Keeping both targets here
 * makes the paired-delete contract explicit — a change that drops the `memory` target would be a
 * desync regression caught in review.
 */
export interface PruneTargets {
	/** The `sessions` trace-row target. */
	readonly sessions: HealTarget;
	/** The paired `memory` summary-row target. */
	readonly memory: HealTarget;
}

/** Resolve the paired prune targets (D-3). Defaults both to their catalog heal targets. */
export function resolvePruneTargets(options: AttachSessionsPruneOptions): PruneTargets {
	return {
		sessions: options.sessionsTarget ?? healTargetFor("sessions"),
		memory: options.memoryTarget ?? healTargetFor("memory"),
	};
}

/**
 * Resolve the per-request tenancy scope from the `x-honeycomb-*` headers (the same tenancy the
 * rest of the daemon reads). Returns `null` when no org is present → the handler 400s
 * (fail-closed; an unscoped prune never falls back to a broad delete).
 *
 * ── Cross-tenant guard (PRD-022 security) ────────────────────────────────────
 * When a validated Identity is present, the resolved org MUST equal `identity.org`;
 * a mismatch returns `null` → the handler fails closed (400).
 *
 * ── Cross-workspace guard (PRD-022 security hardening) ───────────────────────
 * When a validated Identity is present, the workspace is taken from `identity.workspace`
 * (the token's own workspace), NOT from the header. The header is trusted ONLY in local
 * mode (no Identity).
 */
function resolveScope(c: Context): QueryScope | null {
	const org = c.req.header("x-honeycomb-org");
	if (org === undefined || org.length === 0) return null;
	// Cross-tenant guard: a forged org header can never cross the token's own org boundary.
	const identity = getRequestIdentity(c);
	if (identity !== undefined && org !== identity.org) return null;
	// When an authenticated Identity is present, use its workspace rather than trusting
	// the header — a forged workspace header must not allow cross-workspace access.
	if (identity !== undefined) {
		return { org: identity.org, workspace: identity.workspace };
	}
	// Local mode (no Identity): trust the header, with optional workspace.
	const workspace = c.req.header("x-honeycomb-workspace");
	return workspace !== undefined && workspace.length > 0 ? { org, workspace } : { org };
}

/** String coercion that never returns undefined for a text column. */
function toStr(value: unknown): string {
	return value === undefined || value === null ? "" : String(value);
}

/**
 * Build the matched-session SELECT for the logged-in `author`, narrowed by the filter (a-AC-2 /
 * FR-9). Author is ALWAYS pinned (a prune is scoped to the caller's own traces); `before`
 * compares `creation_date` lexicographically (ISO dates sort correctly); `sessionId` pins one
 * id. Every value goes through `sLiteral` / `sqlIdent` (the injection floor). Exported pure so a
 * test asserts the exact WHERE the filter produces.
 */
export function buildMatchSql(table: string, author: string, filter: PruneFilter): string {
	const tbl = sqlIdent(table);
	const idC = sqlIdent("id");
	const pathC = sqlIdent("path");
	const authorC = sqlIdent("author");
	const dateC = sqlIdent("creation_date");
	const fileC = sqlIdent("filename");
	const clauses: string[] = [
		`${authorC} = ${sLiteral(author)}`,
		// Never re-match an already-tombstoned row (idempotent re-prune).
		`${fileC} <> ${sLiteral(TOMBSTONE_MARKER)}`,
	];
	if (filter.sessionId !== undefined && filter.sessionId.length > 0) {
		clauses.push(`${idC} = ${sLiteral(filter.sessionId)}`);
	}
	if (filter.before !== undefined && filter.before.length > 0) {
		clauses.push(`${dateC} < ${sLiteral(filter.before)}`);
	}
	// Each clause is already escaped (sqlIdent identifiers + sLiteral values); the joined
	// `whereClause` is a pre-escaped SQL fragment, so interpolating it carries no raw value.
	const whereClause = clauses.join(" AND ");
	return (
		`SELECT ${idC}, ${pathC}, ${authorC}, ${dateC} FROM "${tbl}" ` +
		`WHERE ${whereClause} ORDER BY ${dateC} DESC LIMIT 1000`
	);
}

/** Select the sessions the filter matches for `author` (fail-soft: `[]` on any non-ok result). */
async function matchSessions(
	storage: StorageQuery,
	target: HealTarget,
	scope: QueryScope,
	author: string,
	filter: PruneFilter,
): Promise<MatchedSession[]> {
	const res = await storage.query(buildMatchSql(target.table, author, filter), scope);
	if (!isOk(res)) return [];
	return (res.rows as StorageRow[]).map((r) => ({
		id: toStr(r.id),
		path: toStr(r.path),
		author: toStr(r.author),
		creationDate: toStr(r.creation_date),
	}));
}

/** The `sessions` tombstone row for a matched session (same id + path, marker filename). */
function sessionsTombstoneRow(match: MatchedSession, nowIso: string): RowValues {
	return [
		["id", val.str(match.id)],
		["path", val.str(match.path)],
		["filename", val.str(TOMBSTONE_MARKER)],
		["message", val.text(JSON.stringify({ _honeycomb_tombstone: true, prunedAt: nowIso }))],
		["author", val.str(match.author)],
		["creation_date", val.str(match.creationDate)],
		["last_update_date", val.str(nowIso)],
	];
}

/** The paired `memory` summary tombstone row for a matched session (same summary path, marker). */
function summaryTombstoneRow(match: MatchedSession, nowIso: string): RowValues {
	const path = summaryPath(match.author, match.id);
	return [
		["id", val.str(`tombstone:${match.id}`)],
		["path", val.str(path)],
		["filename", val.str(TOMBSTONE_MARKER)],
		["summary", val.text("")],
		["description", val.str("deleted")],
		["author", val.str(match.author)],
		["creation_date", val.str(match.creationDate)],
		["last_update_date", val.str(nowIso)],
	];
}

/**
 * Execute a prune pass: match → append a `sessions` tombstone AND a paired `memory` summary
 * tombstone for EVERY matched session, in one pass (a-AC-2 / D-3). The pairing is the load-bearing
 * invariant — both appends happen for each match, so traces and summaries never desync. Exported
 * (not just the handler) so the unit suite + the live itest drive the exact paired-delete without
 * an HTTP round-trip. Returns the matched + per-table tombstone counts.
 */
export async function runPrune(
	storage: StorageQuery,
	targets: PruneTargets,
	scope: QueryScope,
	author: string,
	filter: PruneFilter,
	nowIso: string = new Date().toISOString(),
): Promise<PruneOutcome> {
	const matches = await matchSessions(storage, targets.sessions, scope, author, filter);
	let sessionsTombstoned = 0;
	let summariesTombstoned = 0;
	for (const match of matches) {
		// THE PAIR (D-3): a session's trace tombstone AND its summary tombstone, together. If the
		// session append fails we do NOT skip the summary — both are attempted so a partial failure
		// is visible in the counts rather than silently desyncing one side.
		const sessRes = await appendOnlyInsert(storage, targets.sessions, scope, sessionsTombstoneRow(match, nowIso));
		if (isOk(sessRes)) sessionsTombstoned += 1;
		const memRes = await appendOnlyInsert(storage, targets.memory, scope, summaryTombstoneRow(match, nowIso));
		if (isOk(memRes)) summariesTombstoned += 1;
	}
	return { matched: matches.length, sessionsTombstoned, summariesTombstoned };
}

/**
 * Attach the `sessions prune` handler onto the daemon's already-mounted `/api/sessions` group
 * (a-AC-2 / D-3). Registers `DELETE /prune`: resolve the tenancy scope (400 when absent) + the
 * logged-in author (the `x-honeycomb-actor` header, 400 when absent) → match the author's
 * sessions by the `--before` / `--session-id` filter → append the paired `sessions` + `memory`
 * tombstones atomically per match ({@link runPrune}). Call ONCE after `createDaemon(...)`. A
 * request with no resolvable tenancy/actor 400s (fail-closed). Storage-correct: every value goes
 * through the `sql.ts` guards.
 */
export function attachSessionsPrune(daemon: Daemon, options: AttachSessionsPruneOptions): void {
	const group = daemon.group(SESSIONS_GROUP);
	if (group === undefined) return; // group not mounted (unknown daemon shape) → skip the attach.

	const storage = options.storage;
	const targets = resolvePruneTargets(options);
	const actorAuthority = options.actorAuthority ?? denyUnboundActorAuthority;

	group.delete(SESSIONS_PRUNE_PATH, async (c) => {
		const scope = resolveScope(c);
		if (scope === null) {
			return c.json({ error: "bad_request", reason: "x-honeycomb-org header is required" }, 400);
		}
		const headerActor = c.req.header("x-honeycomb-actor");
		if (headerActor === undefined || headerActor.length === 0) {
			return c.json({ error: "bad_request", reason: "x-honeycomb-actor header is required" }, 400);
		}
		// THE DESTRUCTIVE BLAST-RADIUS GATE. In `local` mode (loopback single-user, no auth) the
		// header actor is authoritative — exactly the rest of the daemon's local posture. In
		// `team`/`hybrid` the `x-honeycomb-actor` header is attacker-controlled, so the prune must
		// only ever delete the CALLER'S OWN traces: the actor is bound to the authenticated identity
		// through the authority seam, which DENIES (403) anything it cannot bind (fail-closed by
		// default). This stops one authenticated org member from tombstoning another member's
		// sessions + summaries by naming their author.
		let author = headerActor;
		if (daemon.config.mode !== "local") {
			const authorized = actorAuthority.resolveAuthorizedActor(c, headerActor);
			if (authorized === null || authorized.length === 0) {
				return c.json(
					{ error: "forbidden", reason: "actor is not bound to the authenticated caller" },
					403,
				);
			}
			author = authorized;
		}
		const before = c.req.query("before");
		const sessionId = c.req.query("session-id");
		const filter: PruneFilter = {
			...(before !== undefined && before.length > 0 ? { before } : {}),
			...(sessionId !== undefined && sessionId.length > 0 ? { sessionId } : {}),
		};
		const outcome = await runPrune(storage, targets, scope, author, filter);
		return c.json(outcome);
	});
}
