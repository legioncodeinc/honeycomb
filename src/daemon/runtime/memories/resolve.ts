/**
 * The resolve adapter for PRD-046e — the PULL half of the prime push/pull design.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * `resolveRef(ref, depth, source, scope, deps)` is the single read the
 * `GET /api/memories/resolve` handler calls. It issues a DETERMINISTIC lookup
 * by id/path — NOT a search or recall — so the agent can cheaply zoom into a
 * primed key without re-running retrieval.
 *
 * ── Two depths, two tables ────────────────────────────────────────────────────
 *   depth 1 — Tier-2 row: the stored summary (`memory.summary` for an episodic ref,
 *             `memories.content` for a durable ref). Single guarded SELECT by path/id.
 *   depth 2 — Tier-3 rows: the raw `sessions` turns for the session that produced the
 *             episodic ref. The episodic ref is the summary path the summary worker writes,
 *             `/summaries/<userName>/<sessionId>.md` (summaries/worker.ts `summaryPath`).
 *             Capture (capture/capture-handler.ts) stores each raw event at `sessions.path` =
 *             the harness TRANSCRIPT path and stamps `sessions.id` = `sess-<sessionId>-<ts>-<rand>`
 *             (`makeRowId`), so the raw turns do NOT live at the summary path. depth-2 therefore
 *             extracts the `<sessionId>` from the summary ref and matches the raw rows by that
 *             `id` prefix (`WHERE id LIKE 'sess-<sessionId>-%'`), NOT by `path` — that is the
 *             deterministic Tier-2 → Tier-3 join. For a durable ref at depth 2 the summary
 *             content is returned (durable facts have no direct session ancestry the prime
 *             exposes). Bounded by {@link MAX_RESOLVE_TURNS} so a zoom never dumps an unbounded
 *             transcript into context.
 *
 * ── SQL safety ───────────────────────────────────────────────────────────────
 * Every identifier routes through `sqlIdent`; every value through `sLiteral` (and every
 * LIKE pattern through `sqlLike`).
 * No value is hand-quoted (`audit:sql` scans `src/daemon`). The org/workspace
 * partition rides the per-request {@link QueryScope}; this module opens NO
 * DeepLake connection — it reads only through the injected {@link StorageQuery}.
 *
 * ── Fail-soft ────────────────────────────────────────────────────────────────
 * A missing row (eventual consistency on a fresh partition, a deleted summary)
 * returns `{ found: false }` — never a throw, never a 500. The caller renders
 * "not found" to the agent honestly.
 *
 * ── NOT search ───────────────────────────────────────────────────────────────
 * This module never calls `recallMemories` or any recall engine. The resolve path
 * is a guarded SELECT by id/path — a join by primary key, not a ranking call.
 * Tests assert no search SQL is issued (e-AC-1).
 * ════════════════════════════════════════════════════════════════════════════
 */

import { isOk } from "../../storage/result.js";
import { sLiteral, sqlIdent, sqlLike } from "../../storage/sql.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { KeySource } from "../summaries/prime-keys.js";

/** The maximum number of raw session turns a depth-2 resolve may return (the transcript cap). */
export const MAX_RESOLVE_TURNS = 100;
/** The default number of raw session turns returned when the caller supplies no limit. */
export const DEFAULT_RESOLVE_TURNS = 50;

/**
 * The `id`-column prefix capture stamps on every raw `sessions` row. Capture writes one row
 * per event with `id = \`sess-<sessionId>-<ts>-<rand>\`` (see
 * `src/daemon/runtime/capture/capture-handler.ts` `makeRowId`). The harness session id is the
 * ONLY column value that carries the session identity — there is no dedicated `session_id`
 * column (capture-handler.ts stores the raw session id only inside the JSONB envelope and this
 * `id` prefix) — so a depth-2 resolve joins a summary back to its raw turns by this id prefix.
 */
export const SESSION_ROW_ID_PREFIX = "sess-";

/** Construction deps for the resolve adapter. */
export interface ResolveRefDeps {
	/** The DeepLake storage client. Reads ONLY through this — never a raw fetch. */
	readonly storage: StorageQuery;
}

// ── depth-1 row shapes ───────────────────────────────────────────────────────

/** A Tier-2 summary row (from `memory.summary`). */
export interface EpisodicSummaryRow {
	readonly path: string;
	readonly summary: string;
	readonly key: string;
	readonly lastUpdateDate: string;
}

/** A Tier-2 durable fact row (from `memories.content`). */
export interface DurableFactRow {
	readonly id: string;
	readonly content: string;
	readonly key: string;
	readonly updatedAt: string;
}

// ── depth-2 row shapes ───────────────────────────────────────────────────────

/** One raw session turn from `sessions.message`. */
export interface SessionTurnRow {
	readonly path: string;
	readonly message: string;
}

// ── resolve result ───────────────────────────────────────────────────────────

/** The resolve result: found → the Tier-2 or Tier-3 data; not-found → honest empty. */
export type ResolveResult =
	| { readonly found: false }
	| { readonly found: true; readonly depth: 1; readonly source: "episodic"; readonly row: EpisodicSummaryRow }
	| { readonly found: true; readonly depth: 1; readonly source: "durable"; readonly row: DurableFactRow }
	| { readonly found: true; readonly depth: 2; readonly source: "episodic"; readonly turns: readonly SessionTurnRow[] }
	| { readonly found: true; readonly depth: 2; readonly source: "durable"; readonly row: DurableFactRow };

// ── SQL builders — deterministic lookups, NOT search ─────────────────────────

/**
 * Build the depth-1 episodic lookup SQL: SELECT the summary row for a `memory` path.
 * Single guarded SELECT by path — no ILIKE, no vector search, no LIMIT > 1.
 */
export function buildEpisodicDepth1Sql(ref: string): string {
	const tbl = sqlIdent("memory");
	const pathCol = sqlIdent("path");
	const summaryCol = sqlIdent("summary");
	const keyCol = sqlIdent("key");
	const dateCol = sqlIdent("last_update_date");
	return (
		`SELECT ${pathCol}, ${summaryCol}::text AS summary, ${keyCol}, ${dateCol} AS last_update_date ` +
		`FROM "${tbl}" ` +
		`WHERE ${pathCol} = ${sLiteral(ref)} ` +
		`LIMIT 1`
	);
}

/**
 * Build the depth-1 durable lookup SQL: SELECT the HIGHEST-version non-deleted row for a
 * `memories` id. Mirrors the `buildGetSql` shape in `reads.ts` — single guarded SELECT by id.
 */
export function buildDurableDepth1Sql(ref: string): string {
	const tbl = sqlIdent("memories");
	const idCol = sqlIdent("id");
	const contentCol = sqlIdent("content");
	const keyCol = sqlIdent("key");
	const dateCol = sqlIdent("updated_at");
	const versionCol = sqlIdent("version");
	const deletedCol = sqlIdent("is_deleted");
	return (
		`SELECT ${idCol}, ${contentCol}::text AS content, ${keyCol}, ${dateCol} AS updated_at ` +
		`FROM "${tbl}" ` +
		`WHERE ${idCol} = ${sLiteral(ref)} AND ${deletedCol} = 0 ` +
		`ORDER BY ${versionCol} DESC LIMIT 1`
	);
}

/**
 * Extract the harness session id from an episodic ref. The summary worker writes the Tier-2
 * summary row at `/summaries/<userName>/<sessionId>.md` (see
 * `src/daemon/runtime/summaries/worker.ts` `summaryPath`), so the session id is the final path
 * segment with the `.md` suffix stripped. Both path segments are single, slash-free segments
 * (the writer sanitizes them), so the trailing segment is exactly `<sessionId>.md`.
 *
 * The raw `sessions` turns are NOT stored at this summary path: capture stamps `sessions.path`
 * with the harness transcript path and only the `sessions.id` prefix (`sess-<sessionId>-…`)
 * carries the session id. So depth-2 resolve derives the session id here and matches the raw
 * rows by that id prefix, NOT by the summary path. Deriving this is table-schema knowledge,
 * NOT a search.
 */
export function extractSessionId(episodicRef: string): string {
	const lastSlash = episodicRef.lastIndexOf("/");
	const tail = lastSlash === -1 ? episodicRef : episodicRef.slice(lastSlash + 1);
	return tail.endsWith(".md") ? tail.slice(0, -".md".length) : tail;
}

/**
 * Build the depth-2 sessions lookup SQL: SELECT the raw turns for a session id, bounded by
 * `turnLimit` and ordered by `creation_date` ascending so the caller sees turns in
 * chronological order (mirroring the summary worker's own `createSessionEventFetcher`).
 * Capture stamps every raw row's `id` with the `sess-<sessionId>-<ts>-<rand>` shape, so this
 * matches the session's rows by that id PREFIX (a guarded `LIKE`, escaped via `sqlLike`; the
 * trailing `%` is the wildcard), NOT by the summary path. Single guarded SELECT by id prefix —
 * NOT a search (no ILIKE, no `<#>`, no UNION).
 */
export function buildSessionDepth2Sql(sessionId: string, turnLimit: number): string {
	const tbl = sqlIdent("sessions");
	const idCol = sqlIdent("id");
	const pathCol = sqlIdent("path");
	const messageCol = sqlIdent("message");
	const dateCol = sqlIdent("creation_date");
	const safeTurnLimit = Math.max(1, Math.min(Math.trunc(turnLimit), MAX_RESOLVE_TURNS));
	// The literal id prefix `sess-<sessionId>-`, LIKE-escaped; the trailing `%` is the wildcard.
	const idPrefix = `${SESSION_ROW_ID_PREFIX}${sessionId}-`;
	const pattern = `'${sqlLike(idPrefix)}%'`;
	return (
		`SELECT ${pathCol}, ${messageCol}::text AS message ` +
		`FROM "${tbl}" ` +
		`WHERE ${idCol} LIKE ${pattern} ` +
		`ORDER BY ${dateCol} ASC ` +
		`LIMIT ${safeTurnLimit}`
	);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function str(v: unknown): string {
	return v === undefined || v === null ? "" : String(v);
}

// ── public entry point ───────────────────────────────────────────────────────

/**
 * Resolve a prime `ref` down to its Tier-2 or Tier-3 data.
 *
 * @param ref    The opaque id/path from the prime (e.g. `/summaries/…` or `mem_d9`).
 * @param depth  1 = Tier-2 summary/content; 2 = Tier-3 raw session turns.
 * @param source Which table the ref is from (`episodic` = `memory`, `durable` = `memories`).
 * @param scope  The org/workspace partition the reads run under (tenancy).
 * @param deps   The storage seam.
 * @param turnLimit  Cap on depth-2 turns (defaults to {@link DEFAULT_RESOLVE_TURNS}).
 *
 * Returns `{ found: false }` when the row is missing — never throws for expected failure
 * modes (missing table on fresh partition, deleted row, eventual-consistency gap).
 */
export async function resolveRef(
	ref: string,
	depth: 1 | 2,
	source: KeySource,
	scope: QueryScope,
	deps: ResolveRefDeps,
	turnLimit = DEFAULT_RESOLVE_TURNS,
): Promise<ResolveResult> {
	if (ref.trim() === "") return { found: false };

	if (source === "episodic") {
		// ── depth 1: read the `memory` summary row by path ────────────────────
		const r1 = await deps.storage.query(buildEpisodicDepth1Sql(ref), scope);
		if (!isOk(r1) || r1.rows.length === 0 || r1.rows[0] === undefined) return { found: false };
		const row1 = r1.rows[0];
		const summaryText = str(row1.summary);
		if (summaryText === "") return { found: false };

		const tier2Row: EpisodicSummaryRow = {
			path: str(row1.path),
			summary: summaryText,
			key: str(row1.key),
			lastUpdateDate: str(row1.last_update_date),
		};

		if (depth === 1) {
			return { found: true, depth: 1, source: "episodic", row: tier2Row };
		}

		// ── depth 2: read the raw `sessions` turns for this session ──────────
		// Capture stamps `sessions.path` with the harness transcript path and the session id
		// appears only in the `sessions.id` prefix (`sess-<sessionId>-…`), so the join back from a
		// `/summaries/<user>/<sessionId>.md` summary is by session id, NOT by path.
		const sessionId = extractSessionId(ref);
		const safeTurns = Math.max(1, Math.min(Math.trunc(turnLimit), MAX_RESOLVE_TURNS));
		const r2 = await deps.storage.query(buildSessionDepth2Sql(sessionId, safeTurns), scope);
		const turns: SessionTurnRow[] = [];
		if (isOk(r2)) {
			for (const row of r2.rows) {
				const msg = str(row.message);
				if (msg !== "") turns.push({ path: str(row.path), message: msg });
			}
		}
		// A depth-2 resolve on a session with no turns is still a found result (the summary exists).
		return { found: true, depth: 2, source: "episodic", turns };
	}

	// source === "durable"
	// ── depth 1: read the `memories` fact row by id ───────────────────────────
	const rd = await deps.storage.query(buildDurableDepth1Sql(ref), scope);
	if (!isOk(rd) || rd.rows.length === 0 || rd.rows[0] === undefined) return { found: false };
	const rowd = rd.rows[0];
	const contentText = str(rowd.content);
	if (contentText === "") return { found: false };

	const durableRow: DurableFactRow = {
		id: str(rowd.id),
		content: contentText,
		key: str(rowd.key),
		updatedAt: str(rowd.updated_at),
	};

	// depth 2 for durable: return the Tier-2 content (durable facts have no direct session
	// ancestry the prime exposes — the prime ref is a `memories.id`, not a session path).
	return { found: true, depth: depth === 2 ? 2 : 1, source: "durable", row: durableRow };
}
