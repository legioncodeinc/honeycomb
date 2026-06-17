/**
 * Lazy schema healing engine (PRD-002c).
 *
 * Tables and columns self-heal on write: a write that fails because the table or
 * a column is missing triggers a TARGETED heal and exactly ONE retry; every
 * other failure (permission, connection, timeout, syntax) rethrows/returns
 * unchanged and NEVER issues a create or alter (FR-2 / FR-6 / c-AC-3). This is
 * the anti-mask rule: a credentials problem must never be misread as a schema
 * gap behind a confusing CREATE attempt.
 *
 * The flow (FR-3/FR-4/FR-5):
 *   write attempt → classify the query_error message →
 *     missing-table  → CREATE TABLE IF NOT EXISTS (from the ColumnDef array)
 *                       → column heal → retry the original write ONCE
 *     missing-column → SELECT information_schema.columns → diff vs the array
 *                       → ALTER ADD COLUMN only the genuinely-missing → retry ONCE
 *     other          → return the original failure unchanged
 *   a SECOND failure after heal → do not loop; return it (c-AC-4).
 *
 * `IF NOT EXISTS` on create + add-only-missing on alter make concurrent heals
 * idempotent (FR-9 / c-AC-6). Every identifier passes `sqlIdent` via the
 * `schema.ts` builders (FR-8 / c-AC-7).
 *
 * The engine consumes the Wave-1 `StorageQuery` (`query(sql, scope, opts)` →
 * `QueryResult`): it branches on `result.kind`, never on a thrown shape. It is
 * the table catalog's job (PRD-003) to supply the ColumnDef array per table; the
 * engine is catalog-agnostic.
 */

import type { QueryScope, StorageQuery } from "./client.js";
import { isOk, type QueryResult, type StorageRow } from "./result.js";
import {
	buildAddColumnSql,
	buildCreateTableSql,
	buildIntrospectionSql,
	type ColumnDef,
} from "./schema.js";

/** How a failed write's `query_error` message classifies for heal routing. */
export type FailureClass = "missing-table" | "missing-column" | "other";

/**
 * Classify a `query_error` message (FR-2). Conservative by construction: a
 * permission/auth failure is forced to `other` FIRST, so a message that happens
 * to mention a relation can never be misread as a schema gap (c-AC-3). A
 * `column … does not exist` shape routes to `missing-column` even though it also
 * contains the `relation "x"` substring — the column branch is checked before
 * the table branch for exactly that reason.
 */
export function classifyFailure(message: string | undefined): FailureClass {
	if (!message) return "other";
	// Auth/permission failures are NEVER a schema gap — rethrow, never heal.
	if (/permission denied|must be owner|not authorized|forbidden|unauthorized/i.test(message)) {
		return "other";
	}
	// Missing-column shapes. Checked before the table branch because Postgres'
	// `column "y" of relation "x" does not exist` contains the table phrasing.
	if (
		/column ["']?[A-Za-z_][A-Za-z0-9_]*["']? .*does not exist/i.test(message) ||
		/unknown column/i.test(message) ||
		/no such column/i.test(message) ||
		/has no column/i.test(message)
	) {
		return "missing-column";
	}
	// Missing-table shapes.
	if (/table does not exist|relation ["']?[A-Za-z_][A-Za-z0-9_.]*["']? does not exist|no such table/i.test(message)) {
		return "missing-table";
	}
	return "other";
}

/** The table identity + ColumnDef array a heal pass needs. */
export interface HealTarget {
	/** Bare table identifier; validated through `sqlIdent` by the builders. */
	readonly table: string;
	/** The single source of truth for this table's columns (PRD-003 supplies it). */
	readonly columns: readonly ColumnDef[];
}

/** What a column-heal pass did, for diagnostics and retry decisions. */
export interface ColumnHealResult {
	/** Columns the introspection diff found missing from the live table. */
	readonly missing: string[];
	/** Columns this pass actually ALTERed in (a subset of `missing`). */
	readonly altered: string[];
}

/**
 * Read `information_schema.columns`, diff against the ColumnDef array, and
 * `ALTER TABLE ADD COLUMN` ONLY the genuinely-missing columns (FR-4). One SELECT,
 * then a targeted ALTER per missing column — never blanket, never
 * `IF NOT EXISTS`. An "already exists" ALTER (a concurrent writer won the race)
 * is re-verified with a second introspection and treated as a no-op success, so
 * concurrent heals converge (c-AC-6); any other ALTER failure surfaces.
 */
export async function healColumns(
	client: StorageQuery,
	target: HealTarget,
	scope: QueryScope,
): Promise<ColumnHealResult> {
	const introspectSql = buildIntrospectionSql(target.table, scope.workspace ?? "");
	const present = await readColumnSet(client, introspectSql, scope);

	const missingDefs = target.columns.filter((c) => !present.has(c.name.toLowerCase()));
	const missing = missingDefs.map((c) => c.name);
	if (missingDefs.length === 0) return { missing, altered: [] };

	const altered: string[] = [];
	for (const col of missingDefs) {
		const res = await client.query(buildAddColumnSql(target.table, col), scope);
		if (isOk(res)) {
			altered.push(col.name);
			continue;
		}
		// The ONE tolerated ALTER failure: a concurrent writer added the column
		// between our SELECT and our ALTER. Re-verify; if it is genuinely present
		// now, treat as success. Any other failure (or a still-absent column)
		// propagates as a heal failure so it is not silently swallowed.
		if (res.kind === "query_error" && /already exists/i.test(res.message)) {
			const recheck = await readColumnSet(client, introspectSql, scope);
			if (recheck.has(col.name.toLowerCase())) continue;
		}
		throw new HealFailure(`ALTER ADD COLUMN "${target.table}"."${col.name}" failed`, res);
	}
	return { missing, altered };
}

/** Run the introspection SELECT and collect the present column names (lowercased). */
async function readColumnSet(client: StorageQuery, introspectSql: string, scope: QueryScope): Promise<Set<string>> {
	const res = await client.query(introspectSql, scope);
	if (!isOk(res)) {
		throw new HealFailure("information_schema introspection failed", res);
	}
	const present = new Set<string>();
	for (const row of res.rows as StorageRow[]) {
		const v = row.column_name;
		if (typeof v === "string") present.add(v.toLowerCase());
	}
	return present;
}

/**
 * A heal step (introspection or ALTER) itself failed with a non-recoverable
 * result. Carries the underlying `QueryResult` so a caller can inspect it.
 * Thrown rather than returned because a failed heal is exceptional — the normal
 * paths return a `QueryResult` union.
 */
export class HealFailure extends Error {
	readonly result: QueryResult;
	constructor(message: string, result: QueryResult) {
		super(message);
		this.name = "HealFailure";
		this.result = result;
	}
}

/**
 * Run a write, and on a missing-table/missing-column failure, heal and retry the
 * write EXACTLY ONCE (FR-3/FR-4/FR-5). The `runWrite` thunk is the original
 * statement so the retry re-issues the identical write. Any non-schema failure
 * (or a success) returns immediately and unhealed (FR-6 / c-AC-3). A second
 * failure after a heal returns that failure without a further retry (c-AC-4).
 *
 * This is the single entry point the write primitives (002d) and vector search
 * (002e) call to become heal-aware (FR-8 / d-AC-7): they pass their write thunk
 * and the table's ColumnDef array, and get the heal-then-retry-once behavior for
 * free without re-implementing classification.
 */
export async function withHeal(
	client: StorageQuery,
	target: HealTarget,
	scope: QueryScope,
	runWrite: () => Promise<QueryResult>,
): Promise<QueryResult> {
	const first = await runWrite();
	if (first.kind !== "query_error") return first; // success, connection, timeout — never heal.

	const failure = classifyFailure(first.message);
	if (failure === "other") return first; // permission/syntax/etc — rethrow unchanged.

	if (failure === "missing-table") {
		const created = await client.query(buildCreateTableSql(target.table, target.columns), scope);
		if (!isOk(created)) return created; // could not create — surface it, do not loop.
		await healColumns(client, target, scope); // bring a freshly-created table fully up to schema.
	} else {
		// missing-column
		await healColumns(client, target, scope);
	}

	// Exactly one retry. Whatever this returns — ok, or a second failure — is the
	// final answer; we never enter a second heal/retry cycle (c-AC-4).
	return runWrite();
}
