/**
 * Per-project counts aggregate — PRD-059c (c-AC-1 STATE / c-AC-2 inbox size).
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * The DAEMON-SIDE, FAIL-SOFT reader the dashboard `GET scope/projects` enrichment
 * (`scope-enumeration-api.ts`) calls to attach per-project `memoryCount` +
 * `sessionCount` (+ `lastCapture`) to each enumerated project. It runs ONE guarded
 * grouped aggregate over `memories` and ONE over `sessions` — `SELECT project_id,
 * count(*) … GROUP BY project_id` — under the active org/workspace scope, NOT N
 * per-project COUNTs. Two round-trips total, regardless of how many projects exist.
 *
 * ── BEST-EFFORT, NEVER FATAL (the c-AC-1 resilience rule) ────────────────────
 * Counts are a NICE-TO-HAVE column on the Projects page; the paths + remote a
 * project carries come from LOCAL state (the resolver cache + the registry) and are
 * ALWAYS served. So a flaky DeepLake backend must never 500 the whole `scope/projects`
 * read: each aggregate is independently fail-soft. A non-`ok` {@link QueryResult}
 * (query_error / connection_error / timeout from the closed union) yields an EMPTY
 * map for that table — every project then reports a `0` count and a `null`
 * `lastCapture` for that dimension — and the read still returns 200 with the
 * always-available local state. It NEVER throws.
 *
 * ── INBOX MAPPING (c-AC-2) ───────────────────────────────────────────────────
 * A `memories`/`sessions` row whose `project_id` is the empty string `''` is an
 * UNSORTED capture (D5: a row with no resolved project falls to the workspace
 * `__unsorted__` inbox at read time). This module folds the `''` bucket onto
 * {@link UNSORTED_PROJECT_ID} so the caller can serve c-AC-2's inbox size by reading
 * the count keyed on the reserved inbox id — the `''` and `__unsorted__` buckets are
 * SUMMED (a row already stamped `__unsorted__` and a row left `''` both belong to the
 * inbox).
 *
 * ── SQL-SAFETY ───────────────────────────────────────────────────────────────
 * Both statements are built by the catalog's `buildMemoryCountsByProjectSql` /
 * `buildSessionCountsByProjectSql` (identifiers via `sqlIdent`, no interpolated
 * value), so `audit:sql` stays clean. This module never hand-builds SQL.
 */

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { buildMemoryCountsByProjectSql, buildSessionCountsByProjectSql } from "../../storage/catalog/index.js";
import { UNSORTED_PROJECT_ID } from "../../storage/catalog/index.js";
import { isOk, type StorageRow } from "../../storage/result.js";

/** One project's aggregated capture state (the c-AC-1 STATE columns). */
export interface ProjectCounts {
	/** Distilled-memory rows scoped to this project (`memories`, excl. soft-deleted). */
	readonly memoryCount: number;
	/** Raw-capture session-event rows scoped to this project (`sessions`). */
	readonly sessionCount: number;
	/**
	 * The most-recent capture timestamp across memories + sessions (ISO-8601), or
	 * `null` when the project has no captured rows (or the aggregate failed soft).
	 */
	readonly lastCapture: string | null;
}

/** A zeroed {@link ProjectCounts} — what an unknown project (or a failed aggregate) reports. */
export const ZERO_PROJECT_COUNTS: ProjectCounts = Object.freeze({
	memoryCount: 0,
	sessionCount: 0,
	lastCapture: null,
});

/** The aggregated counts for a workspace, keyed by `project_id` (inbox under {@link UNSORTED_PROJECT_ID}). */
export interface ProjectCountsMap {
	/** Per-project counts; a project absent from the map has no captured rows. */
	readonly byProjectId: ReadonlyMap<string, ProjectCounts>;
	/**
	 * True when BOTH aggregates were read successfully. False when one or both
	 * failed soft (the map still resolves, just with the failed dimension zeroed) —
	 * exposed so a caller/test can assert the fail-soft path without inspecting logs.
	 */
	readonly complete: boolean;
}

/** One `(project_id, count, last_capture)` aggregate row, fail-soft per field. */
interface CountRow {
	readonly projectId: string;
	readonly count: number;
	readonly lastCapture: string | null;
}

/**
 * Fold a raw aggregate {@link StorageRow} into a typed {@link CountRow}, fail-soft
 * per field: a non-string `project_id` reads as `''` (the inbox bucket), a non-finite
 * count reads as `0`, a non-string `last_capture` reads as `null`. The `''` →
 * {@link UNSORTED_PROJECT_ID} fold (c-AC-2) happens in {@link accumulate}, not here, so
 * the `''` and an explicit `__unsorted__` bucket can be summed into one inbox total.
 */
function rowToCount(row: StorageRow): CountRow {
	const projectId = typeof row.project_id === "string" ? row.project_id : "";
	const rawN = row.n;
	const count = typeof rawN === "number" && Number.isFinite(rawN) ? rawN : Number.parseInt(String(rawN ?? ""), 10);
	const last = typeof row.last_capture === "string" && row.last_capture.length > 0 ? row.last_capture : null;
	return { projectId, count: Number.isFinite(count) ? count : 0, lastCapture: last };
}

/** The later of two ISO-8601 timestamps (lexicographic = chronological), null-safe. */
function laterTimestamp(a: string | null, b: string | null): string | null {
	if (a === null) return b;
	if (b === null) return a;
	return a >= b ? a : b;
}

/**
 * Run ONE grouped aggregate and fold its rows into a `project_id → CountRow` map,
 * mapping the empty-string bucket onto {@link UNSORTED_PROJECT_ID} and SUMMING it with
 * any explicit `__unsorted__` bucket (c-AC-2). Returns `null` on a non-`ok` storage
 * result so the caller can record the dimension as failed-soft (→ zeroed) without
 * throwing — a flaky backend never fatals the read.
 */
async function readGroupedCounts(
	storage: StorageQuery,
	scope: QueryScope,
	sql: string,
): Promise<ReadonlyMap<string, CountRow> | null> {
	const result = await storage.query(sql, scope);
	if (!isOk(result)) return null;
	const map = new Map<string, CountRow>();
	for (const row of result.rows) {
		const parsed = rowToCount(row);
		// c-AC-2: the empty `project_id` IS the workspace inbox; fold it onto the reserved id.
		const key = parsed.projectId.length === 0 ? UNSORTED_PROJECT_ID : parsed.projectId;
		const prior = map.get(key);
		if (prior === undefined) {
			map.set(key, { ...parsed, projectId: key });
		} else {
			map.set(key, {
				projectId: key,
				count: prior.count + parsed.count,
				lastCapture: laterTimestamp(prior.lastCapture, parsed.lastCapture),
			});
		}
	}
	return map;
}

/**
 * Read per-project capture counts for the active workspace in TWO round-trips (one
 * grouped aggregate over `memories`, one over `sessions`), merged into a single
 * `project_id → {@link ProjectCounts}` map. FAIL-SOFT and NON-THROWING: if either
 * aggregate fails (a non-`ok` {@link QueryResult}), that dimension is treated as empty
 * (every project reports `0` for it) and `complete` is `false`; the other dimension
 * and the always-available local state are unaffected, so the `scope/projects` read
 * still returns 200.
 *
 * The empty-string `project_id` bucket is folded onto {@link UNSORTED_PROJECT_ID}
 * (c-AC-2) so the caller serves the inbox size by reading the reserved-id key.
 */
export async function readProjectCounts(storage: StorageQuery, scope: QueryScope): Promise<ProjectCountsMap> {
	// Two independent grouped aggregates — issued concurrently, each fail-soft on its own.
	const [memMap, sessMap] = await Promise.all([
		readGroupedCounts(storage, scope, buildMemoryCountsByProjectSql()),
		readGroupedCounts(storage, scope, buildSessionCountsByProjectSql()),
	]);
	const complete = memMap !== null && sessMap !== null;

	// Union the project ids both aggregates know about.
	const ids = new Set<string>();
	for (const id of memMap?.keys() ?? []) ids.add(id);
	for (const id of sessMap?.keys() ?? []) ids.add(id);

	const byProjectId = new Map<string, ProjectCounts>();
	for (const id of ids) {
		const mem = memMap?.get(id);
		const sess = sessMap?.get(id);
		byProjectId.set(id, {
			memoryCount: mem?.count ?? 0,
			sessionCount: sess?.count ?? 0,
			lastCapture: laterTimestamp(mem?.lastCapture ?? null, sess?.lastCapture ?? null),
		});
	}
	return { byProjectId, complete };
}
