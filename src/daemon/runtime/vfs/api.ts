/**
 * The VFS browse API attach seam — PRD-022b (daemon side, storage-correct).
 *
 * `mountVfsApi(daemon, { storage, ... })` attaches the daemon-side `/memory/*`
 * READ handlers onto the already-mounted `/memory` route group (`server.ts` mounts
 * it as a SESSION group — protected + runtime-path negotiated). These handlers are
 * the surface the PRD-015 `DeepLakeFs` client, the hooks pre-tool-use VFS intercept,
 * and the MCP browse trio (`honeycomb_search` / `honeycomb_read` / `honeycomb_index`)
 * all dispatch to. ZERO edits to `server.ts`: the `/memory` group is already
 * scaffolded + protected, so attaching via `daemon.group("/memory")` inherits
 * auth/RBAC + the runtime-path session middleware with no re-wiring.
 *
 * ── What it wires (b-AC-1..6) ────────────────────────────────────────────────
 *   - b-AC-1 cat / read   `GET  /memory/cat?path=<p>`   → read the `memory` row's
 *                          summary content for the path (a `memory`-table row read).
 *   - b-AC-2 grep / Glob  `GET  /memory/grep?q=<q>`     → hybrid search through the
 *                          PRD-007 recall engine's collection layer (BM25/ILIKE
 *                          lexical floor; vector channel skipped when embeddings off
 *                          → `degraded:true`, the silent fallback surfaced).
 *   - b-AC-3 ls           `GET  /memory/ls?prefix=<p>`  → the `memory` entries under
 *                          a path prefix (a prefix listing).
 *   - b-AC-4 find         `GET  /memory/find?pattern=<p>` → the `memory` rows whose
 *                          path matches the pattern (a path-pattern query).
 *   - b-AC-5 classify     `GET  /memory/classify?path=<p>` → the PRD-015 `classifyPath`
 *                          verdict (the SAME pure contract the 015 client uses, so
 *                          daemon-side routing == client-side classification).
 *   - b-AC-6 write-deny   `POST|PUT|PATCH|DELETE /memory/*` → 405 DENIED with guidance
 *                          pointing at the audited `/api/memories` write routes (022a).
 *                          The VFS is a READ surface; mutations go through 022a.
 *
 * ── Why the `memory` table (NOT `memories`) for cat/ls/find ──────────────────
 * The VFS browse surface is the path-addressed projection: `cat`/`ls`/`find` read
 * the `memory` table (`path` / `summary` / `filename` — PRD-003c MEMORY_COLUMNS),
 * the SAME table the PRD-015 client `read.ts` (`buildMemorySummarySql`) and
 * `index-gen.ts` (`buildRecentMemoriesSql`) read. That keeps the daemon-side browse
 * byte-consistent with the thin-client VFS. `grep` is the ONE handler that reuses
 * the recall engine (PRD-007 ranks over the `memories` ENGINE table's `content`),
 * because grep is a hybrid SEARCH, not a path read (FR-3 / the implementation note).
 *
 * ── Storage-correct (CONVENTIONS) ────────────────────────────────────────────
 * Lives under `src/daemon/` so it MAY reach `daemon/storage`; every read runs
 * ONLY through the injected {@link StorageQuery}, building guarded SQL with the
 * pure `sql.ts` helpers (`sqlIdent` / `sLiteral` / `sqlLike`). No handler opens a
 * raw connection, and every interpolated value goes through a guard. `audit:sql`
 * scans `src/daemon`; `audit:openclaw` scans the bundle.
 *
 * ── Deferred assembly (D-2 / 022d) ───────────────────────────────────────────
 * The production daemon assembly (`assembleSeams`, 022d) calls `mountVfsApi` once
 * after `createDaemon(...)`. It is constructed-and-tested here against a fake (but
 * real) `StorageQuery`; nothing auto-invokes it by importing the daemon.
 */

import type { Context } from "hono";
import { sLiteral, sqlIdent, sqlLike } from "../../storage/sql.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import {
	collectCandidates,
	type CollectionDeps,
	type HintSource,
} from "../recall/collection.js";
import { resolveRecallConfig, type RecallConfig } from "../recall/config.js";
import { bestScore, type RecallScope } from "../recall/contracts.js";
import { classifyPath } from "../../../daemon-client/vfs/classify.js";
import {
	resolveScopeFromHeaders,
	resolveScopeOrLocalDefault,
	resolveRequestProject,
	type RequestProjectScope,
} from "../scope.js";
import type { Daemon } from "../server.js";

/** The route group the VFS browse handlers attach to (already mounted in `server.ts`). */
export const VFS_GROUP = "/memory" as const;

/** The `memory` (VFS/summaries) table + the columns the browse reads project. */
const MEMORY_TABLE = "memory";
const PATH_COL = "path";
const SUMMARY_COL = "summary";
const FILENAME_COL = "filename";
const UPDATED_COL = "last_update_date";

/** The engine `memories` table grep hydrates content from (after recall collection). */
const MEMORIES_TABLE = "memories";
const MEMORIES_ID_COL = "id";
const MEMORIES_CONTENT_COL = "content";

/** Hard caps so a single browse can never dump an unbounded table (the index-gen guardrail). */
const LS_LIMIT = 200;
const FIND_LIMIT = 200;
const GREP_LIMIT = 50;

/** Options for {@link mountVfsApi}. */
export interface MountVfsOptions {
	/** The storage client the browse reads run through (never a raw fetch). */
	readonly storage: StorageQuery;
	/**
	 * The resolved recall config grep's hybrid search runs under. Defaults to the
	 * env-resolved recall config (the same knobs the recall engine reads).
	 */
	readonly recallConfig?: RecallConfig;
	/**
	 * The prospective-hints source for grep's recall collection. Defaults to the
	 * recall engine's empty hint source (the real source is a future PRD).
	 */
	readonly hints?: HintSource;
	/**
	 * The daemon's configured default tenancy scope, threaded from the composition root
	 * (PRD-022). In LOCAL mode a browse with no `x-honeycomb-org` header falls back to this
	 * single configured tenant (a loopback thin client need not know the org GUID). ABSENT
	 * → pure header-only resolution (the prior fail-closed behaviour). NEVER consulted
	 * outside local mode.
	 */
	readonly defaultScope?: QueryScope;
}

/**
 * Resolve the per-request tenancy scope from the `x-honeycomb-*` headers (the same
 * tenancy the rest of the daemon reads). Returns `null` when no org is present → the
 * handler 400s (fail-closed; an unscoped browse never falls back to a broad read). This
 * is the pure HEADER step; the local-mode default-scope fallback is layered on at the
 * handler via {@link resolveScopeOrLocalDefault} (PRD-022).
 */
export function resolveScope(c: Context): QueryScope | null {
	return resolveScopeFromHeaders(c);
}

/** The agent partition the browse reads under (the within-workspace identity). Defaults `default`. */
function resolveAgentId(c: Context): string {
	const agent = c.req.header("x-honeycomb-agent");
	return agent !== undefined && agent.length > 0 ? agent : "default";
}

/** String coercion that never returns undefined for a text cell. */
function toStr(value: unknown): string {
	return value === undefined || value === null ? "" : String(value);
}

/** Run a SELECT through the storage seam, returning rows or `[]` on any non-ok result (fail-soft). */
async function selectRows(storage: StorageQuery, sql: string, scope: QueryScope): Promise<StorageRow[]> {
	const result = await storage.query(sql, scope);
	return isOk(result) ? result.rows : [];
}

/** The 400 body a browse handler returns when the request carries no resolvable org (fail-closed). */
const NO_ORG_BODY = { error: "bad_request", reason: "x-honeycomb-org header is required" } as const;

/** The 400 body a browse handler returns when a required query param is missing/blank. */
function missingParam(name: string): { error: string; reason: string } {
	return { error: "bad_request", reason: `the '${name}' query parameter is required` };
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL builders — the SINGLE source of each browse read's storage query (jscpd).
// Identifiers via `sqlIdent`; values via `sLiteral` / `sqlLike` (the 002b floor).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the `cat` read (b-AC-1 / FR-2): the `summary` of the `memory` row at this
 * `path`. `LIMIT 1` because `memory` is update-or-insert by `path` (one current row
 * per path) — the SAME read the PRD-015 client `buildMemorySummarySql` issues.
 */
export function buildCatSql(path: string): string {
	const tbl = sqlIdent(MEMORY_TABLE);
	const pathCol = sqlIdent(PATH_COL);
	const summary = sqlIdent(SUMMARY_COL);
	const filename = sqlIdent(FILENAME_COL);
	return (
		`SELECT ${pathCol}, ${summary}, ${filename} FROM "${tbl}" ` +
		`WHERE ${pathCol} = ${sLiteral(path)} LIMIT 1`
	);
}

/**
 * Build the `ls` prefix listing (b-AC-3 / FR-4): the `memory` entries whose `path`
 * begins with the prefix, projecting `path` + `filename`, newest first, capped. The
 * prefix routes through `sqlLike` (so a `%`/`_` in the prefix is a literal, not a
 * wildcard) and is anchored with a trailing `%` to make it a prefix match.
 */
export function buildLsSql(prefix: string): string {
	const tbl = sqlIdent(MEMORY_TABLE);
	const pathCol = sqlIdent(PATH_COL);
	const filename = sqlIdent(FILENAME_COL);
	const updated = sqlIdent(UPDATED_COL);
	const pattern = `'${sqlLike(prefix)}%'`;
	return (
		`SELECT ${pathCol}, ${filename} FROM "${tbl}" ` +
		`WHERE ${pathCol} ILIKE ${pattern} ` +
		`ORDER BY ${updated} DESC LIMIT ${LS_LIMIT}`
	);
}

/**
 * Build the `find` path-pattern query (b-AC-4 / FR-5): the `memory` rows whose `path`
 * matches the pattern anywhere (an `%…%` ILIKE), projecting `path` + `summary`,
 * newest first, capped. The pattern routes through `sqlLike`. `find` matches on PATH
 * (the directory-style pattern walk) — distinct from `grep`, which searches CONTENT.
 */
export function buildFindSql(pattern: string): string {
	const tbl = sqlIdent(MEMORY_TABLE);
	const pathCol = sqlIdent(PATH_COL);
	const summary = sqlIdent(SUMMARY_COL);
	const updated = sqlIdent(UPDATED_COL);
	const like = `'%${sqlLike(pattern)}%'`;
	return (
		`SELECT ${pathCol}, ${summary} FROM "${tbl}" ` +
		`WHERE ${pathCol} ILIKE ${like} ` +
		`ORDER BY ${updated} DESC LIMIT ${FIND_LIMIT}`
	);
}

/**
 * Build the grep content-hydration SELECT for a set of `memories` IDs the recall
 * collection surfaced (b-AC-2). Values via `sLiteral`, identifiers via `sqlIdent`.
 * The IN-list is bounded by the capped candidate set, so it is short.
 */
export function buildGrepHydrateSql(ids: readonly string[]): string {
	if (ids.length === 0) return "";
	const tbl = sqlIdent(MEMORIES_TABLE);
	const idCol = sqlIdent(MEMORIES_ID_COL);
	const contentCol = sqlIdent(MEMORIES_CONTENT_COL);
	const inList = ids.map((id) => sLiteral(id)).join(", ");
	return `SELECT ${idCol}, ${contentCol} FROM "${tbl}" WHERE ${idCol} IN (${inList})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Result shapes — the browse view-models the VFS clients consume.
// ─────────────────────────────────────────────────────────────────────────────

/** A `cat` result: the resolved path + its content. `found:false` when no row exists. */
export interface CatResult {
	readonly path: string;
	readonly found: boolean;
	readonly content: string;
}

/** One `ls` entry under a prefix. */
export interface LsEntry {
	readonly path: string;
	readonly filename: string;
}

/** One `find` match. */
export interface FindMatch {
	readonly path: string;
	readonly summary: string;
}

/** One `grep` hybrid-search hit (a ranked memory + its hydrated content). */
export interface GrepHit {
	readonly id: string;
	readonly score: number;
	readonly content: string;
}

/**
 * A `grep` result: the ranked hits + `degraded` — the silent-fallback signal. When
 * embeddings are off/unreachable the vector channel is skipped and recall ran
 * lexical-only (BM25/ILIKE); `degraded:true` makes that observable rather than silent.
 */
export interface GrepResult {
	readonly query: string;
	readonly degraded: boolean;
	readonly hits: GrepHit[];
	/**
	 * PRD-049b (D8): true when the session project could NOT be resolved (no cwd) and the grep
	 * fell back to the workspace inbox + workspace-global rows. Surfaced so the browse caller can
	 * render the visible degraded-scoping warning, mirroring the `degraded` (embeddings) signal.
	 * Omitted when the project resolved (a bound or inbox-with-cwd session).
	 */
	readonly projectScopeDegraded?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read fetchers — the single source of each browse read (jscpd discipline).
// ─────────────────────────────────────────────────────────────────────────────

/** Fetch the `cat` content for a path (b-AC-1). Missing row → `{ found:false, content:"" }`. */
export async function fetchCat(storage: StorageQuery, scope: QueryScope, path: string): Promise<CatResult> {
	const rows = await selectRows(storage, buildCatSql(path), scope);
	const first = rows[0];
	if (first === undefined) return { path, found: false, content: "" };
	return { path, found: true, content: toStr(first.summary) };
}

/** Fetch the `ls` entries under a prefix (b-AC-3). */
export async function fetchLs(storage: StorageQuery, scope: QueryScope, prefix: string): Promise<LsEntry[]> {
	const rows = await selectRows(storage, buildLsSql(prefix), scope);
	return rows.map((r) => ({ path: toStr(r.path), filename: toStr(r.filename) }));
}

/** Fetch the `find` matches for a path pattern (b-AC-4). */
export async function fetchFind(storage: StorageQuery, scope: QueryScope, pattern: string): Promise<FindMatch[]> {
	const rows = await selectRows(storage, buildFindSql(pattern), scope);
	return rows.map((r) => ({ path: toStr(r.path), summary: toStr(r.summary) }));
}

/**
 * Run grep's hybrid search through the PRD-007 recall collection layer (b-AC-2 / FR-3).
 *
 * Reuses `collectCandidates` rather than re-deriving search: the FTS/BM25 lexical
 * floor always runs; the vector channel runs ONLY with a usable 768-dim query vector,
 * else it is skipped and `degraded:true` is carried through (the silent BM25/ILIKE
 * fallback when embeddings are off). No `embed` client is injected here, so the browse
 * grep is the embeddings-off lexical path by construction (D-4) — a follow-up wires
 * the embed seam for semantic browse. The surviving IDs are then hydrated to content
 * from the `memories` engine table (the ONLY place content is loaded — a read, never a
 * write). Fail-soft: a storage failure yields an empty hit set, not a 500.
 */
export async function fetchGrep(
	storage: StorageQuery,
	scope: QueryScope,
	agentId: string,
	query: string,
	config: RecallConfig,
	hints: HintSource | undefined,
	project?: RequestProjectScope,
): Promise<GrepResult> {
	const recallScope: RecallScope = {
		org: scope.org,
		workspace: scope.workspace ?? "",
		agentId,
		// The VFS browse never widens beyond the caller's own agent partition; the
		// read-policy clause (007c) is a recall-injection concern, not a browse one.
		readPolicy: "isolated",
		policyGroup: "",
		// PRD-049b (49b-AC-2): the resolved project segment is threaded into the SAME collection
		// layer the live recall uses, so the fast-path grep is project-narrowed identically. No
		// project (no cwd) → the unbound inbox session (D8 / 49b-AC-3): inbox + workspace-global.
		...(project !== undefined ? { projectId: project.projectId, projectBound: project.bound } : {}),
	};
	const collectionDeps: CollectionDeps = {
		storage,
		scope: { org: scope.org, ...(scope.workspace !== undefined ? { workspace: scope.workspace } : {}) },
		config,
		// No embed client → vector channel skipped → degraded lexical-only (D-4 / a-AC-3).
		...(hints !== undefined ? { hints } : {}),
	};

	const pool = await collectCandidates({ query, scope: recallScope }, collectionDeps);
	const ranked = pool.candidates.slice(0, GREP_LIMIT);
	const ids = ranked.map((c) => c.id).filter((id) => id !== "");

	const hydrateSql = buildGrepHydrateSql(ids);
	const contentById = new Map<string, string>();
	if (hydrateSql !== "") {
		const rows = await selectRows(storage, hydrateSql, scope);
		for (const row of rows) {
			const id = toStr(row.id);
			if (id !== "") contentById.set(id, toStr(row.content));
		}
	}

	const hits: GrepHit[] = ranked.map((c) => ({
		id: c.id,
		// The strongest per-channel calibrated score — the same `bestScore` the recall
		// merge ranks on (reused so the grep rank matches the engine's, jscpd-clean).
		score: bestScore(c.scores),
		content: contentById.get(c.id) ?? "",
	}));
	return {
		query,
		degraded: pool.degraded,
		hits,
		// PRD-049b (D8): surface the project-scope-degraded fact when no cwd resolved a project.
		...(project !== undefined && project.degraded ? { projectScopeDegraded: true } : {}),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Write-deny guidance (b-AC-6 / FR-7).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The 405 body a write on a `/memory/*` path is denied with (b-AC-6 / FR-7). The VFS
 * is a READ-ONLY projection; the audited writes go through the 022a `/api/memories`
 * routes. The message is actionable (it names the route), not a bare 405.
 */
export const WRITE_DENIED_BODY = Object.freeze({
	error: "method_not_allowed",
	reason:
		"the /memory VFS is a read-only browse surface; writes are not accepted here. " +
		"Send memory mutations through the audited /api/memories write routes (remember / modify / forget), " +
		"which record provenance in memory_history.",
	writeRoute: "/api/memories",
} as const);

// ─────────────────────────────────────────────────────────────────────────────
// The attach seam.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attach the VFS browse handlers onto the daemon's already-mounted `/memory` route
 * group (the 022b daemon-side seam). Registers the read handlers (cat / grep / ls /
 * find / classify) + the write-deny guard, each reading through `options.storage`
 * with guarded SQL via the shared fetchers. Call ONCE after `createDaemon(...)`.
 *
 * A request with no resolvable tenancy 400s (fail-closed). A missing required query
 * param 400s. A write verb on any `/memory/*` path 405s with the audited-route
 * guidance (b-AC-6). If the `/memory` group is not mounted (unknown daemon shape)
 * the attach is skipped.
 */
export function mountVfsApi(daemon: Daemon, options: MountVfsOptions): void {
	const group = daemon.group(VFS_GROUP);
	if (group === undefined) return;

	const storage = options.storage;
	const recallConfig = options.recallConfig ?? resolveRecallConfig();
	const hints = options.hints;
	// Scope precedence (PRD-022): header → (local-mode) injected default → null/400. The
	// fallback fires ONLY in local mode with a `defaultScope`; team/hybrid stay fail-closed.
	const resolveBrowseScope = (c: Context): QueryScope | null =>
		resolveScopeOrLocalDefault(c, daemon.config.mode, options.defaultScope);

	// b-AC-6: write-deny FIRST so a write verb can never fall through to a read handler.
	// Every mutating method on any `/memory/*` path is denied with the audited-route guidance.
	for (const method of ["post", "put", "patch", "delete"] as const) {
		group[method]("/*", (c) => c.json(WRITE_DENIED_BODY, 405));
	}

	// b-AC-1: cat / read — `GET /memory/cat?path=<p>` → the row's content.
	group.get("/cat", async (c) => {
		const scope = resolveBrowseScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const path = c.req.query("path");
		if (path === undefined || path.length === 0) return c.json(missingParam("path"), 400);
		return c.json(await fetchCat(storage, scope, path));
	});

	// b-AC-2: grep / Glob — `GET /memory/grep?q=<q>` → hybrid search via the recall engine.
	group.get("/grep", async (c) => {
		const scope = resolveBrowseScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const query = c.req.query("q");
		if (query === undefined || query.length === 0) return c.json(missingParam("q"), 400);
		const agentId = resolveAgentId(c);
		// PRD-049b (49b-AC-2): resolve the session project from the `x-honeycomb-cwd` header so
		// the fast-path grep is project-narrowed identically to the live recall. No cwd is the D8 inbox.
		const project = resolveRequestProject(c, scope);
		return c.json(await fetchGrep(storage, scope, agentId, query, recallConfig, hints, project));
	});

	// b-AC-3: ls — `GET /memory/ls?prefix=<p>` → the entries under the prefix.
	group.get("/ls", async (c) => {
		const scope = resolveBrowseScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		// A blank prefix lists from the mount root (every entry, still capped).
		const prefix = c.req.query("prefix") ?? "";
		return c.json({ prefix, entries: await fetchLs(storage, scope, prefix) });
	});

	// b-AC-4: find — `GET /memory/find?pattern=<p>` → the path-pattern matches.
	group.get("/find", async (c) => {
		const scope = resolveBrowseScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const pattern = c.req.query("pattern");
		if (pattern === undefined || pattern.length === 0) return c.json(missingParam("pattern"), 400);
		return c.json({ pattern, matches: await fetchFind(storage, scope, pattern) });
	});

	// b-AC-5: classify — `GET /memory/classify?path=<p>` → the PRD-015 classifyPath verdict.
	// Pure: no storage. Proves daemon-side routing classifies via the SAME contract the client uses.
	group.get("/classify", (c) => {
		const path = c.req.query("path");
		if (path === undefined || path.length === 0) return c.json(missingParam("path"), 400);
		return c.json({ path, pathClass: classifyPath(path) });
	});
}
