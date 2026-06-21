/**
 * The shared keyed-table engine for `/api/goals` and `/api/kpis` — PRD-022c (c-AC-1 /
 * c-AC-2 / c-AC-6).
 *
 * Goals and KPIs are the SAME shape (PRD-003d `GOAL_KPI_COLUMNS_BASE`): one row per
 * logical `key`, written UPDATE-or-INSERT-by-key (`updateOrInsertByKey`) so re-adding an
 * existing key UPDATES in place rather than inserting a duplicate (c-AC-2). Rather than
 * duplicate the read + upsert handler twice (the jscpd-7 trap), this module owns the ONE
 * keyed engine and `goals/api.ts` + `kpis/api.ts` mount it bound to their table name.
 *
 * ── Wiring-only (D-1) ────────────────────────────────────────────────────────
 * This adds NO business logic and NO schema. The `goals`/`kpis` tables, their columns,
 * and the `updateOrInsertByKey` write primitive all exist (PRD-003d / PRD-002d). This
 * parses + validates + scopes the request at the edge and delegates to the existing
 * write/read path. Every value routes through the 002d `val.*` constructors (→
 * `sLiteral`/`eLiteral`) and every read SELECT builds through `sqlIdent`/`sLiteral`
 * (`audit:sql` scans `src/daemon`).
 *
 * ── Tenancy (c-AC-6) ─────────────────────────────────────────────────────────
 * Every route resolves its `{ org, workspace }` scope from the `x-honeycomb-*` headers
 * (the same tenancy the rest of the daemon reads). A request with no resolvable org 400s
 * fail-closed — never a broad read/write. The resolved scope is stamped onto the storage
 * query (the partition layer isolates org/workspace) AND onto the row's `agent_id`/
 * `visibility` columns are left at their defaults (engine table, D-2). A body that fails
 * Zod validation is rejected with 400 at the edge BEFORE any storage call.
 */

import type { Context, Hono } from "hono";
import { z } from "zod";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { type ColumnValue, type RowValues, updateOrInsertByKey, val } from "../../storage/writes.js";
import type { HealTarget } from "../../storage/heal.js";
import { healTargetFor } from "../../storage/catalog/index.js";
import type { DeploymentMode } from "../config.js";
import { resolveScopeFromHeaders, resolveScopeOrLocalDefault } from "../scope.js";

/**
 * The POST body for a goal / KPI add (c-AC-1 / c-AC-2 / FR-1 / FR-2 / FR-8). `key` is the
 * logical upsert key (required, non-empty). `value` is required; `target`, `status`, and
 * `unit` are optional and default to the column defaults. `.strict()` rejects an unknown
 * field so a malformed/over-shaped body is caught at the edge (c-AC-6). A caller can NOT
 * set `agent_id`/`visibility`/timestamps — those are server-stamped, never body-supplied,
 * so a body can never widen its own scope.
 */
export const KeyedAddBodySchema = z
	.object({
		key: z.string().min(1, "key is required"),
		value: z.string().min(1, "value is required"),
		target: z.string().optional(),
		status: z.string().min(1).optional(),
		unit: z.string().optional(),
	})
	.strict();

/** The validated, inferred add body. */
export type KeyedAddBody = z.infer<typeof KeyedAddBodySchema>;

/** One keyed row as returned by a GET read (the 003d minimal shape). */
export interface KeyedRow {
	readonly key: string;
	readonly value: string;
	readonly target: string;
	readonly status: string;
	readonly unit: string;
	readonly updatedAt: string;
}

/** Options for {@link mountKeyedApi}. */
export interface KeyedApiOptions {
	/** The storage client the read/upsert run through (never a raw fetch). */
	readonly storage: StorageQuery;
	/**
	 * The daemon's deployment mode (`daemon.config.mode`). Gates the local-mode default-scope
	 * fallback (PRD-022). Defaults to `"local"` when absent so a unit harness that omits it
	 * keeps the header-only behaviour ONLY when no `defaultScope` is also injected.
	 */
	readonly mode?: DeploymentMode;
	/**
	 * The daemon's configured default tenancy scope, threaded from the composition root
	 * (PRD-022). In LOCAL mode a request with no `x-honeycomb-org` header falls back to this
	 * single configured tenant. ABSENT → pure header-only resolution. NEVER consulted outside
	 * local mode.
	 */
	readonly defaultScope?: QueryScope;
}

/**
 * Resolve the per-request tenancy scope from the `x-honeycomb-*` headers (mirrors the
 * dashboard/sources/secrets resolvers). Returns `null` when no org is present → the
 * handler 400s (fail-closed; an unscoped request never falls back to a broad read/write).
 * This is the pure HEADER step; the local-mode default-scope fallback is layered on at the
 * keyed handlers + the skills/rules reads via {@link resolveScopeOrLocalDefault} (PRD-022).
 */
export function resolveScope(c: Context): QueryScope | null {
	return resolveScopeFromHeaders(c);
}

/** The 400 body for a request with no resolvable org (fail-closed — never a broad scope). */
const NO_ORG_BODY = { error: "bad_request", reason: "x-honeycomb-org header is required" } as const;

/** Coerce a column value to a string, never undefined/null. */
function toStr(value: unknown): string {
	return value === undefined || value === null ? "" : String(value);
}

/** Read a JSON body defensively; a non-JSON / non-object body → `null` (the handler 400s). */
async function readJsonBody(c: Context): Promise<unknown> {
	try {
		const body: unknown = await c.req.json();
		return body;
	} catch {
		return null;
	}
}

/**
 * Map a storage row to the {@link KeyedRow} view shape. Tolerant of missing columns (a
 * freshly-healed table) — every field coerces to a string default.
 */
function rowToView(r: StorageRow): KeyedRow {
	return {
		key: toStr(r.key),
		value: toStr(r.value),
		target: toStr(r.target),
		status: toStr(r.status),
		unit: toStr(r.unit),
		updatedAt: toStr(r.updated_at),
	};
}

/**
 * Read every keyed row for the scoped tenant, newest-updated first (c-AC-1 read), then
 * COLLAPSE to one logical row per `key` — the latest write (highest `updated_at`) wins.
 * Builds the SELECT through `sqlIdent`; no value is interpolated (the scope partition
 * isolates the tenant). A non-ok result yields `[]` (fail-soft — an empty list, never a
 * throw past the handler boundary).
 *
 * ── Why the per-key collapse (c-AC-2 under DeepLake eventual consistency) ─────
 * `goals`/`kpis` are written `updateOrInsertByKey` (SELECT-by-key → UPDATE if present,
 * else INSERT) to keep ONE physical row per logical key. But DeepLake is eventually
 * consistent SEGMENT-by-segment (project memory: "every live read-back must poll until
 * convergence, never a single immediate read"): a rapid second POST's key-probe SELECT can
 * land on a STALE segment that does not yet show the first INSERT, so it INSERTs a SECOND
 * physical row instead of updating in place. That duplicate is durable — no amount of read
 * polling makes 2 physical rows become 1, because both genuinely exist on disk. The honest
 * fix is therefore in the READ: present the logical view by reducing to the highest-
 * `updated_at` row per key (the same highest-version-per-id reduction the append-only
 * tables use in `auth/api-keys.ts#listKeys` / `ontology/supersede.ts`, here keyed on
 * `updated_at` since `goals`/`kpis` carry no `version` column). A stale read still
 * under-reports rows but never invents one, and the latest-write-wins collapse yields
 * exactly the current value for each key. The `updateOrInsertByKey` duplicate is the
 * documented small-team v1 trade-off (storage/writes.ts FR-4); the read absorbs it.
 */
async function readScopedRows(storage: StorageQuery, table: string, scope: QueryScope): Promise<KeyedRow[]> {
	const tbl = sqlIdent(table);
	const sql =
		`SELECT ${sqlIdent("key")}, ${sqlIdent("value")}, ${sqlIdent("target")}, ` +
		`${sqlIdent("status")}, ${sqlIdent("unit")}, ${sqlIdent("updated_at")} ` +
		`FROM "${tbl}" ORDER BY ${sqlIdent("updated_at")} DESC LIMIT 500`;
	const res = await storage.query(sql, scope);
	if (!isOk(res)) return [];
	return collapseLatestPerKey((res.rows as StorageRow[]).map(rowToView));
}

/**
 * Reduce a flat row list to one logical row per `key`, keeping the row with the highest
 * `updatedAt` (latest write wins). This makes the read robust to the rare duplicate
 * physical row `updateOrInsertByKey` leaves behind when a second POST's key-probe SELECT
 * raced a stale DeepLake segment (see {@link readScopedRows}). Order is preserved as
 * first-seen so a single-row-per-key table reads identically to before.
 */
export function collapseLatestPerKey(rows: readonly KeyedRow[]): KeyedRow[] {
	const currentByKey = new Map<string, KeyedRow>();
	for (const row of rows) {
		const prev = currentByKey.get(row.key);
		// Keep the latest write per key. `updatedAt` is an ISO-8601 string, so a lexical
		// compare is chronological; `>=` lets a later equal-timestamp row win (stable choice).
		if (prev === undefined || row.updatedAt >= prev.updatedAt) {
			currentByKey.set(row.key, row);
		}
	}
	return [...currentByKey.values()];
}

/**
 * Read a single keyed row by `key` for the scoped tenant (the post-write read-back). The
 * key value routes through `sLiteral`. Returns `null` when absent or on a non-ok result.
 */
async function readScopedByKey(
	storage: StorageQuery,
	table: string,
	scope: QueryScope,
	key: string,
): Promise<KeyedRow | null> {
	const tbl = sqlIdent(table);
	const sql =
		`SELECT ${sqlIdent("key")}, ${sqlIdent("value")}, ${sqlIdent("target")}, ` +
		`${sqlIdent("status")}, ${sqlIdent("unit")}, ${sqlIdent("updated_at")} ` +
		`FROM "${tbl}" WHERE ${sqlIdent("key")} = ${sLiteral(key)} LIMIT 1`;
	const res = await storage.query(sql, scope);
	if (!isOk(res) || res.rows.length === 0) return null;
	return rowToView(res.rows[0] as StorageRow);
}

/**
 * Build the {@link RowValues} for an upsert from the validated body + the server-stamped
 * timestamp. `key` is included so an INSERT carries it; `agent_id`/`visibility` are left
 * at their column defaults (engine table, D-2) — a body can never set them. The text
 * fields go through `val.text` (escape-safe); the key/enum-ish fields through `val.str`.
 */
function buildUpsertRow(body: KeyedAddBody, now: string): RowValues {
	const row: ReadonlyArray<readonly [string, ColumnValue]> = [
		["key", val.str(body.key)],
		["value", val.text(body.value)],
		["target", val.text(body.target ?? "")],
		["status", val.str(body.status ?? "open")],
		["unit", val.str(body.unit ?? "")],
		["updated_at", val.str(now)],
	];
	return row;
}

/**
 * Mount the keyed GET + POST handlers onto an already-resolved route group (the shared
 * engine `goals/api.ts` + `kpis/api.ts` call). `table` is the 003d table name (`"goals"`
 * or `"kpis"`); `target` is its catalog {@link HealTarget} (columns single-sourced).
 *
 *   - GET `/`  → the scoped tenant's rows (c-AC-1 read).
 *   - POST `/` → Zod-validate the body, upsert by `key` via `updateOrInsertByKey` (an
 *                existing key UPDATES, never duplicates — c-AC-2), read it back, 201.
 *
 * A request with no resolvable org 400s (c-AC-6 tenancy); a malformed body 400s with the
 * Zod issues (c-AC-6 validation) BEFORE any storage call.
 */
export function mountKeyedGroup(
	group: Hono,
	table: string,
	target: HealTarget,
	options: KeyedApiOptions,
): void {
	const storage = options.storage;
	// Scope precedence (PRD-022): header → (local-mode) injected default → null/400. The
	// fallback fires ONLY in local mode with a `defaultScope`; team/hybrid stay fail-closed.
	const mode: DeploymentMode = options.mode ?? "local";
	const resolveKeyedScope = (c: Context): QueryScope | null =>
		resolveScopeOrLocalDefault(c, mode, options.defaultScope);

	group.get("/", async (c) => {
		const scope = resolveKeyedScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const rows = await readScopedRows(storage, table, scope);
		return c.json({ [table]: rows });
	});

	group.post("/", async (c) => {
		const scope = resolveKeyedScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);

		const raw = await readJsonBody(c);
		const parsed = KeyedAddBodySchema.safeParse(raw);
		if (!parsed.success) {
			return c.json(
				{ error: "bad_request", reason: "invalid body", issues: parsed.error.issues },
				400,
			);
		}

		const now = new Date().toISOString();
		const row = buildUpsertRow(parsed.data, now);
		const res = await updateOrInsertByKey(storage, target, scope, {
			keyColumn: "key",
			keyValue: parsed.data.key,
			row,
		});
		if (!isOk(res)) {
			return c.json({ error: "store_failed", reason: "could not write the row" }, 502);
		}
		const stored = await readScopedByKey(storage, table, scope, parsed.data.key);
		return c.json({ ok: true, [table.slice(0, -1)]: stored ?? rowToView(rowFromBody(parsed.data, now)) }, 201);
	});
}

/** Build a synthetic {@link StorageRow} from the body when the read-back is unavailable (fail-soft echo). */
function rowFromBody(body: KeyedAddBody, now: string): StorageRow {
	return {
		key: body.key,
		value: body.value,
		target: body.target ?? "",
		status: body.status ?? "open",
		unit: body.unit ?? "",
		updated_at: now,
	};
}

/**
 * Resolve a keyed table's catalog {@link HealTarget} (columns single-sourced from
 * `src/daemon/storage/catalog/product.ts`). Throws on an unknown table — a typo surfaces
 * at mount time, not query time.
 */
export function keyedHealTarget(table: string): HealTarget {
	return healTargetFor(table);
}
