/**
 * PRD-058d — the lifecycle READ endpoints (the operator surface's data source) + the read-side
 * health-scalar `H(m,t)` assembly.
 *
 * Attaches three SCOPED, PAGINATED reads onto the ALREADY-MOUNTED `/api/memories` SESSION group
 * (ZERO `server.ts` edit, inheriting its auth/RBAC + session gate, exactly like
 * {@link import("./conflicts-api.js").mountConflictsApi}):
 *
 *   - `GET /api/memories/conflicts?status=open` — the conflict queue (ids, pair, verdict, status).
 *   - `GET /api/memories/stale-refs`            — memories with `ref_status = 'stale'` + their refs.
 *   - `GET /api/memories/history?type=lifecycle` — the `memory_history` audit filtered to the
 *                                                  lifecycle operations (actor, reason, confidence, ts).
 *
 * It REUSES — and defines NO new write path. The dashboard + CLI resolve a conflict through the
 * already-defined 058b `POST /api/memories/conflicts/:id/resolve` endpoint; this module is reads-only.
 * `GET /api/memories/calibration` ALREADY exists (058e, in `api.ts`); this module does not duplicate it.
 *
 * ── Scope ENFORCED BEFORE any content column (the recall authorization boundary) ─────────────
 * Every handler resolves the request {@link QueryScope} from the headers FIRST (fail-closed 400 with
 * no org). The reads run UNDER the org/workspace storage partition, so a row in another partition is
 * simply never returned — an out-of-scope conflict/memory is indistinguishable from a missing one.
 *
 * ── The read-side `H(m,t)` (058d Technical Considerations) ───────────────────────────────────
 * `H(m,t) = A(m,t) · C(m) · (1 − σ(m,t)) · κ(m,t)`, computed from the already-emitted term fields at
 * read time. It adds NO column, NO job, NO aggregation. A DORMANT term's factor is the IDENTITY (1),
 * so `H` degrades gracefully to the terms that are live ({@link assembleHealth}).
 *
 * ── Eventual consistency ─────────────────────────────────────────────────────────────────────
 * These are pure reads (no write to read back), so they do not poll; the dashboard polls AFTER a
 * resolve (which hits the 058b write endpoint, whose own read-back already polls to convergence).
 *
 * ── SQL safety ───────────────────────────────────────────────────────────────────────────────
 * Every identifier routes through `sqlIdent`, every value through `sLiteral` (via the catalog
 * builders + the local stale-ref/history builders). No hand-quoted SQL (`audit:sql` scans `src/daemon`).
 */

import type { Context, Hono } from "hono";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import type { Daemon } from "../server.js";
import { resolveScopeOrLocalDefault } from "../scope.js";
import {
	buildConflictListSql,
	CONFLICT_STATUSES,
	type ConflictStatus,
} from "../../storage/catalog/memory-conflicts.js";
import {
	type LifecycleHealthInputs,
	type MemoryHealth,
	assembleHealth,
} from "./lifecycle-health.js";

/** The route group the lifecycle reads attach to (already mounted in `server.ts`). */
export const MEMORIES_GROUP = "/api/memories" as const;

/** The default page size for the lifecycle list reads (CLI-/dashboard-facing). */
export const DEFAULT_LIFECYCLE_PAGE = 50;
/** The hard ceiling on a lifecycle list page (mirrors `MAX_LIST_LIMIT`). */
export const MAX_LIFECYCLE_PAGE = 500;

/**
 * The lifecycle `memory_history` OPERATIONS (058b conflict events + 058c stale-ref detection). A
 * `history?type=lifecycle` read filters `memory_history.operation IN (…)` to exactly these, so the
 * audit is queryable by the lifecycle action type (AC-55d.2.3). The set is the single source the
 * filter + the test read.
 */
export const LIFECYCLE_HISTORY_OPERATIONS = Object.freeze([
	"conflict_detect",
	"conflict_resolve",
	"conflict_reverse",
	"stale-ref-detect",
] as const);

/** The 400 body for a request with no resolvable tenancy (fail-closed). */
const NO_ORG_BODY = { error: "bad_request", reason: "x-honeycomb-org header is required" } as const;

/** Clamp a caller-supplied page size into `[1, MAX_LIFECYCLE_PAGE]`, defaulting a missing/bad value. */
export function resolveLifecyclePage(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIFECYCLE_PAGE;
	const n = Math.trunc(limit);
	if (n < 1) return DEFAULT_LIFECYCLE_PAGE;
	return Math.min(n, MAX_LIFECYCLE_PAGE);
}

/** Read a string cell, defaulting to "". */
function str(v: unknown): string {
	return v === undefined || v === null ? "" : String(v);
}

/** Read a numeric cell, defaulting when absent/garbage. */
function num(v: unknown, fallback: number): number {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n : fallback;
}

/** Parse a `?limit=` query param, or `undefined` when absent/non-numeric. */
function parseLimit(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

// ── SQL builders local to this read surface (guarded) ─────────────────────────

/**
 * Build the SCOPED, PAGINATED stale-ref list read (PRD-058d): the live `memories` rows whose
 * `ref_status = 'stale'`, carrying their `stale_refs` payload (058c). The org/workspace partition
 * rides the `storage.query` scope; `is_deleted = 0` drops tombstones; the live version per id is
 * MAX(version). Every identifier routes through `sqlIdent`; the status literal through `sLiteral`;
 * `limit` is a clamped integer interpolated as a bare numeral (the audit-safe LIMIT shape).
 */
export function buildStaleRefListSql(limit: number): string {
	const tbl = sqlIdent("memories");
	const idCol = sqlIdent("id");
	const refStatusCol = sqlIdent("ref_status");
	const staleRefsCol = sqlIdent("stale_refs");
	const verifiedCol = sqlIdent("verified_at");
	const deletedCol = sqlIdent("is_deleted");
	const versionCol = sqlIdent("version");
	const safeLimit = Math.max(1, Math.trunc(limit));
	return (
		`SELECT ${idCol} AS id, ${refStatusCol} AS ref_status, ${staleRefsCol} AS stale_refs, ${verifiedCol} AS verified_at ` +
		`FROM "${tbl}" t ` +
		`WHERE ${versionCol} = ( SELECT MAX(${versionCol}) FROM "${tbl}" i WHERE i.${idCol} = t.${idCol} ) ` +
		`AND ${deletedCol} = 0 AND ${refStatusCol} = ${sLiteral("stale")} ` +
		`ORDER BY ${verifiedCol} DESC LIMIT ${safeLimit}`
	);
}

/**
 * Build the SCOPED, PAGINATED lifecycle-history read (PRD-058d AC-55d.2.3): the `memory_history`
 * rows whose `operation` is one of {@link LIFECYCLE_HISTORY_OPERATIONS}, newest first. Returns the
 * actor (`changed_by`), the operation, the `after_payload` (carrying reason + confidence), the
 * target memory id, and the timestamp. The operation set is interpolated as an `IN (...)` of
 * `sLiteral`-escaped tokens (the operations are a CLOSED internal set, never caller input, but
 * escaped anyway — defense in depth). `limit` is a clamped bare numeral; every identifier `sqlIdent`.
 */
export function buildLifecycleHistorySql(limit: number): string {
	const tbl = sqlIdent("memory_history");
	const idCol = sqlIdent("id");
	const memoryIdCol = sqlIdent("memory_id");
	const changedByCol = sqlIdent("changed_by");
	const operationCol = sqlIdent("operation");
	const afterCol = sqlIdent("after_payload");
	const createdCol = sqlIdent("created_at");
	const inList = LIFECYCLE_HISTORY_OPERATIONS.map((op) => sLiteral(op)).join(", ");
	const safeLimit = Math.max(1, Math.trunc(limit));
	return (
		`SELECT ${idCol} AS id, ${memoryIdCol} AS memory_id, ${changedByCol} AS changed_by, ` +
		`${operationCol} AS operation, ${afterCol} AS after_payload, ${createdCol} AS created_at ` +
		`FROM "${tbl}" ` +
		`WHERE ${operationCol} IN (${inList}) ` +
		`ORDER BY ${createdCol} DESC LIMIT ${safeLimit}`
	);
}

// ── Response shapes ───────────────────────────────────────────────────────────

/** One conflict row in the `GET /api/memories/conflicts` list (the pair + verdict + status). */
export interface ConflictListItem {
	readonly id: string;
	readonly memoryAId: string;
	readonly memoryBId: string;
	readonly verdict: string;
	readonly winnerId: string | null;
	readonly status: string;
	readonly contraScore: number;
}

/** One stale-ref row in the `GET /api/memories/stale-refs` list (the memory id + its unresolved refs). */
export interface StaleRefListItem {
	readonly memoryId: string;
	readonly refStatus: string;
	readonly staleRefs: readonly string[];
	readonly verifiedAt: string | null;
}

/** One lifecycle audit row in the `GET /api/memories/history?type=lifecycle` list. */
export interface LifecycleHistoryItem {
	readonly id: string;
	readonly memoryId: string;
	readonly actor: string;
	readonly operation: string;
	readonly reason: string;
	readonly confidence: number;
	readonly timestamp: string;
}

/** Parse a `stale_refs` cell — a JSON array of strings, defensively (a non-array / non-JSON → []). */
function parseStaleRefs(raw: unknown): string[] {
	if (raw === undefined || raw === null || raw === "") return [];
	try {
		const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((x): x is string => typeof x === "string");
	} catch {
		return [];
	}
}

/** Parse a lifecycle `after_payload` (the `{ operation, reason, confidence }` JSON) defensively. */
function parseAfterPayload(raw: unknown): { reason: string; confidence: number } {
	if (raw === undefined || raw === null || raw === "") return { reason: "", confidence: 0 };
	try {
		const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
		if (typeof parsed !== "object" || parsed === null) return { reason: "", confidence: 0 };
		const obj = parsed as { reason?: unknown; confidence?: unknown };
		return { reason: str(obj.reason), confidence: num(obj.confidence, 0) };
	} catch {
		return { reason: "", confidence: 0 };
	}
}

// ── Read functions (scope-enforced, fail-soft) ────────────────────────────────

/** Read the scoped conflict list at `status` (PRD-058d). Fail-soft: a storage error → `[]`. */
export async function listConflicts(
	storage: StorageQuery,
	scope: QueryScope,
	status: ConflictStatus,
	limit: number,
): Promise<ConflictListItem[]> {
	const result = await storage.query(buildConflictListSql(status, limit), scope);
	if (!isOk(result)) return [];
	return result.rows.map((row: StorageRow) => ({
		id: str(row.id),
		memoryAId: str(row.memory_a_id),
		memoryBId: str(row.memory_b_id),
		verdict: str(row.verdict),
		winnerId: row.winner_id === null || row.winner_id === undefined || row.winner_id === "" ? null : str(row.winner_id),
		status: str(row.status),
		contraScore: num(row.contra_score, 0),
	}));
}

/** Read the scoped stale-ref list (PRD-058d). Fail-soft: a storage error / missing column → `[]`. */
export async function listStaleRefs(storage: StorageQuery, scope: QueryScope, limit: number): Promise<StaleRefListItem[]> {
	const result = await storage.query(buildStaleRefListSql(limit), scope);
	if (!isOk(result)) return [];
	return result.rows.map((row: StorageRow) => ({
		memoryId: str(row.id),
		refStatus: str(row.ref_status) || "unknown",
		staleRefs: parseStaleRefs(row.stale_refs),
		verifiedAt: row.verified_at === null || row.verified_at === undefined || row.verified_at === "" ? null : str(row.verified_at),
	}));
}

/** Read the scoped lifecycle-history list (PRD-058d AC-55d.2.3). Fail-soft: a storage error → `[]`. */
export async function listLifecycleHistory(
	storage: StorageQuery,
	scope: QueryScope,
	limit: number,
): Promise<LifecycleHistoryItem[]> {
	const result = await storage.query(buildLifecycleHistorySql(limit), scope);
	if (!isOk(result)) return [];
	return result.rows.map((row: StorageRow) => {
		const payload = parseAfterPayload(row.after_payload);
		return {
			id: str(row.id),
			memoryId: str(row.memory_id),
			actor: str(row.changed_by) || "pipeline",
			operation: str(row.operation),
			reason: payload.reason,
			confidence: payload.confidence,
			timestamp: str(row.created_at),
		};
	});
}

// ── Re-export the read-side health assembly (the pure `H(m,t)` projection) ────

export { assembleHealth, type LifecycleHealthInputs, type MemoryHealth };

// ── The mount seam ────────────────────────────────────────────────────────────

/** Options for {@link mountLifecycleApi}. Mirrors {@link import("./conflicts-api.js").MountConflictsOptions}. */
export interface MountLifecycleOptions {
	/** The storage client every read runs through (never a raw fetch). */
	readonly storage: StorageQuery;
	/** The daemon's configured default tenancy scope (local-mode fallback). */
	readonly defaultScope?: QueryScope;
}

/** Narrow a `?status=` query value to a {@link ConflictStatus}; default `open` (the queue view). */
function resolveStatus(raw: string | undefined): ConflictStatus {
	if (raw !== undefined && (CONFLICT_STATUSES as readonly string[]).includes(raw)) return raw as ConflictStatus;
	return "open";
}

/**
 * Register the three lifecycle READ routes on the `/api/memories` group router (PRD-058d).
 *
 * ── Route order (ISS-012, the same rule as `/resolve` / `/calibration` / `/prime`) ────────────
 * `conflicts`, `stale-refs`, and `history` are LITERAL segments on the same group that also carries
 * the parametric `GET /:id` — Hono matches routes in registration order, so these MUST be registered
 * BEFORE `/:id` or every one of them 404s as `getMemory("conflicts")` etc. The PRODUCTION PATH is
 * therefore `mountMemoriesApi` calling THIS function right before it registers `GET /:id` (api.ts) —
 * exactly the shape of the /prime route-shadow fix. {@link mountLifecycleApi} remains as the
 * standalone back-compat shim for callers/tests that mount only the lifecycle reads on a fresh
 * daemon (no `/:id` to shadow); when both run, the shim's handlers are never-reached duplicates.
 */
export function registerLifecycleReadRoutes(
	group: Hono,
	storage: StorageQuery,
	resolveScope: (c: Context) => QueryScope | null,
): void {
	// GET /api/memories/conflicts?status=open — the conflict queue (scoped, paginated).
	group.get("/conflicts", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const status = resolveStatus(c.req.query("status"));
		const limit = resolveLifecyclePage(parseLimit(c.req.query("limit")));
		const conflicts = await listConflicts(storage, scope, status, limit);
		return c.json({ conflicts, status });
	});

	// GET /api/memories/stale-refs — memories with ref_status='stale' + their unresolved refs.
	group.get("/stale-refs", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const limit = resolveLifecyclePage(parseLimit(c.req.query("limit")));
		const staleRefs = await listStaleRefs(storage, scope, limit);
		return c.json({ staleRefs });
	});

	// GET /api/memories/history?type=lifecycle — the lifecycle-filtered audit read.
	group.get("/history", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		// Only `type=lifecycle` is served here (the 058d filtered audit); any other type is an empty
		// lifecycle read (the page/CLI asks only for `lifecycle`). The filter is the closed op set.
		const type = c.req.query("type") ?? "lifecycle";
		if (type !== "lifecycle") return c.json({ history: [], type });
		const limit = resolveLifecyclePage(parseLimit(c.req.query("limit")));
		const history = await listLifecycleHistory(storage, scope, limit);
		return c.json({ history, type: "lifecycle" });
	});
}

/**
 * Attach the lifecycle READ endpoints onto the daemon's already-mounted `/api/memories` group
 * (PRD-058d). RETAINED as a backwards-compat safety net (mirroring `mountMemoriesPrimeApi`): the
 * production registration happens INSIDE `mountMemoriesApi` (BEFORE its parametric `GET /:id`, so
 * the literal segments are never shadowed — ISS-012); when a caller/test mounts ONLY this seam on
 * a fresh daemon (no `/:id`), it is the sole registration. Call ONCE after `createDaemon(...)`,
 * beside {@link import("./conflicts-api.js").mountConflictsApi}. No-op if the group is not mounted.
 */
export function mountLifecycleApi(daemon: Daemon, options: MountLifecycleOptions): void {
	const group = daemon.group(MEMORIES_GROUP);
	if (group === undefined) return;
	const resolveScope = (c: Context): QueryScope | null =>
		resolveScopeOrLocalDefault(c, daemon.config.mode, options.defaultScope);
	registerLifecycleReadRoutes(group, options.storage, resolveScope);
}
