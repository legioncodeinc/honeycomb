/**
 * Write primitives that give correctness WITHOUT transactions (PRD-002d).
 *
 * DeepLake exposes no transactions at this layer and can coalesce two rapid
 * UPDATEs to the same row within microseconds, silently dropping one. So each
 * table is written with the pattern that survives that quirk:
 *
 *   - appendOnlyInsert       — one row per event, never concatenates (sessions,
 *                              raw events). Read ordered by `creation_date`.  FR-1
 *   - appendVersionBumped    — INSERT version N+1 on every edit (skills, rules,
 *                              claim history). Read `ORDER BY version DESC LIMIT
 *                              1`. Supersede APPENDS a new version, never mutates. FR-2/FR-3
 *   - updateOrInsertByKey    — one row per logical key (memory, goals, kpis).
 *                              The small-team v1 trade-off.                    FR-4
 *   - selectBeforeInsert     — insert iff absent, RE-VERIFY after insert so a
 *                              race is observable (codebase snapshots).        FR-5
 *
 * Hot concurrent-edit tables never use in-place UPDATE (FR-6): they take the
 * version-bumped pattern. Every interpolated value routes through the PRD-002b
 * helpers and escape-bearing bodies use `E'...'` via `eLiteral` (FR-7 / d-AC-6).
 * Every primitive is heal-aware: a missing-table/column failure delegates to the
 * PRD-002c `withHeal` engine and retries once (FR-8 / d-AC-7).
 *
 * These primitives build statements and run them through the Wave-1
 * `StorageQuery`. They do not own the catalog (PRD-003) — the caller passes the
 * table identity + ColumnDef array (a `HealTarget`) and the column values.
 */

import type { QueryScope, StorageQuery } from "./client.js";
import type { HealTarget } from "./heal.js";
import { withHeal } from "./heal.js";
import { isOk, type QueryResult, type StorageRow } from "./result.js";
import { eLiteral, sLiteral, sqlColumnList, sqlIdent, sqlStr } from "./sql.js";

/**
 * A column value to interpolate. A `text` value goes through `eLiteral`
 * (`E'...'`, escape-safe body); a `literal` value through `sLiteral` (`'...'`);
 * a `number` is inlined (non-string scalar, by design); `raw` is a pre-built
 * fragment (e.g. `NULL`, `DEFAULT`, or a vector literal already assembled from
 * helpers) and is trusted as-is. Modeling the value KIND keeps the audit gate
 * satisfied: a primitive never hand-quotes a value.
 */
export type ColumnValue =
	| { readonly kind: "text"; readonly value: string }
	| { readonly kind: "literal"; readonly value: string }
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "raw"; readonly value: string };

/** Convenience constructors so call sites read declaratively. */
export const val = {
	/** Escape-bearing body → `E'...'`. Use for message/skill/rule text. */
	text: (value: string): ColumnValue => ({ kind: "text", value }),
	/** Plain string literal → `'...'`. Use for ids, paths, enums, dates. */
	str: (value: string): ColumnValue => ({ kind: "literal", value }),
	/** Numeric scalar, inlined. */
	num: (value: number): ColumnValue => ({ kind: "number", value }),
	/** Pre-built SQL fragment (NULL/DEFAULT/vector literal). Trusted as-is. */
	raw: (value: string): ColumnValue => ({ kind: "raw", value }),
};

/** Render one `ColumnValue` into its SQL text via the 002b helpers. */
function renderValue(v: ColumnValue): string {
	switch (v.kind) {
		case "text":
			return eLiteral(v.value);
		case "literal":
			return sLiteral(v.value);
		case "number":
			return String(v.value);
		case "raw":
			return v.value;
	}
}

/** An ordered map of column name → value for an INSERT. */
export type RowValues = ReadonlyArray<readonly [string, ColumnValue]>;

/** Build the `(cols) VALUES (vals)` fragment, every identifier through `sqlIdent`. */
function buildColsVals(row: RowValues): { cols: string; vals: string } {
	const cols = row.map(([name]) => sqlIdent(name)).join(", ");
	const vals = row.map(([, v]) => renderValue(v)).join(", ");
	return { cols, vals };
}

/**
 * Append-only INSERT (FR-1 / d-AC-4): one row per event, never concatenating an
 * existing one. Used by `sessions` and raw events. Heal-aware via `withHeal`.
 */
export function appendOnlyInsert(
	client: StorageQuery,
	target: HealTarget,
	scope: QueryScope,
	row: RowValues,
): Promise<QueryResult> {
	const tbl = sqlIdent(target.table);
	const { cols, vals } = buildColsVals(row);
	const sql = `INSERT INTO "${tbl}" (${cols}) VALUES (${vals})`;
	return withHeal(client, target, scope, () => client.query(sql, scope));
}

/**
 * Read the latest row for a key on a version-bumped table (FR-9): the reader
 * convention paired with {@link appendVersionBumped}. `ORDER BY version DESC
 * LIMIT 1` makes the highest version the current row.
 */
export async function readLatestVersion(
	client: StorageQuery,
	target: HealTarget,
	scope: QueryScope,
	keyColumn: string,
	keyValue: string,
	selectColumns = "*",
): Promise<QueryResult> {
	const tbl = sqlIdent(target.table);
	const key = sqlIdent(keyColumn);
	const cols = sqlColumnList(selectColumns);
	const sql =
		`SELECT ${cols} FROM "${tbl}" ` +
		`WHERE ${key} = ${sLiteral(keyValue)} ` +
		"ORDER BY version DESC LIMIT 1";
	return client.query(sql, scope);
}

/**
 * Append-only VERSION-BUMPED write (FR-2/FR-3 / d-AC-1/d-AC-3/d-AC-5).
 *
 * Reads the current MAX(version) for the key, then INSERTs a fresh row at
 * version N+1 carrying the supplied columns. NEVER mutates the prior row, so two
 * rapid edits both persist and the highest version reads as current (d-AC-3).
 * `supersede:true` is the same append but stamps `status='superseded'` semantics
 * by letting the caller pass the status column — the prior version is left
 * intact and a new version marks the transition (d-AC-5).
 *
 * The version column and the key column are configurable so the same primitive
 * serves skills/rules/claim-history. Heal-aware via `withHeal`.
 */
export async function appendVersionBumped(
	client: StorageQuery,
	target: HealTarget,
	scope: QueryScope,
	args: {
		readonly keyColumn: string;
		readonly keyValue: string;
		/** Columns to write on the NEW version row (excluding the version column). */
		readonly row: RowValues;
		/** Version column name; defaults to `version`. */
		readonly versionColumn?: string;
	},
): Promise<{ result: QueryResult; version: number }> {
	const versionColumn = args.versionColumn ?? "version";
	const nextVersion = (await readMaxVersion(client, target, scope, args.keyColumn, args.keyValue, versionColumn)) + 1;

	// Compose the new row: caller columns + the bumped version. The version is a
	// numeric scalar inlined by design.
	const row: RowValues = [...args.row, [versionColumn, val.num(nextVersion)] as const];
	const tbl = sqlIdent(target.table);
	const { cols, vals } = buildColsVals(row);
	const sql = `INSERT INTO "${tbl}" (${cols}) VALUES (${vals})`;
	const result = await withHeal(client, target, scope, () => client.query(sql, scope));
	return { result, version: nextVersion };
}

/** Read the current MAX(version) for a key; 0 when the key has no rows yet. */
async function readMaxVersion(
	client: StorageQuery,
	target: HealTarget,
	scope: QueryScope,
	keyColumn: string,
	keyValue: string,
	versionColumn: string,
): Promise<number> {
	const tbl = sqlIdent(target.table);
	const key = sqlIdent(keyColumn);
	const ver = sqlIdent(versionColumn);
	const sql =
		`SELECT ${ver} FROM "${tbl}" ` +
		`WHERE ${key} = ${sLiteral(keyValue)} ` +
		`ORDER BY ${ver} DESC LIMIT 1`;
	const res = await withHeal(client, target, scope, () => client.query(sql, scope));
	if (!isOk(res) || res.rows.length === 0) return 0;
	const raw = (res.rows[0] as StorageRow)[versionColumn];
	const n = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(n) ? n : 0;
}

/**
 * UPDATE-or-INSERT by key (FR-4): one row per logical key for `memory` / `goals`
 * / `kpis`. SELECTs the key; UPDATEs the existing row's columns if present, else
 * INSERTs. The explicit small-team v1 trade-off — accepts the rare
 * UPDATE-coalescing drop in exchange for a single row per key. Heal-aware.
 */
export async function updateOrInsertByKey(
	client: StorageQuery,
	target: HealTarget,
	scope: QueryScope,
	args: {
		readonly keyColumn: string;
		readonly keyValue: string;
		/** Columns to set/insert (the key column may be included for INSERT). */
		readonly row: RowValues;
	},
): Promise<QueryResult> {
	const tbl = sqlIdent(target.table);
	const key = sqlIdent(args.keyColumn);
	const selectSql = `SELECT ${key} FROM "${tbl}" WHERE ${key} = ${sLiteral(args.keyValue)} LIMIT 1`;
	const existing = await withHeal(client, target, scope, () => client.query(selectSql, scope));
	if (!isOk(existing)) return existing;

	if (existing.rows.length > 0) {
		const setClauses = args.row
			.filter(([name]) => name !== args.keyColumn)
			.map(([name, v]) => `${sqlIdent(name)} = ${renderValue(v)}`)
			.join(", ");
		const updateSql = `UPDATE "${tbl}" SET ${setClauses} WHERE ${key} = ${sLiteral(args.keyValue)}`;
		return withHeal(client, target, scope, () => client.query(updateSql, scope));
	}

	const { cols, vals } = buildColsVals(args.row);
	const insertSql = `INSERT INTO "${tbl}" (${cols}) VALUES (${vals})`;
	return withHeal(client, target, scope, () => client.query(insertSql, scope));
}

/** Outcome of a SELECT-before-INSERT, surfacing a detected race. */
export interface SelectBeforeInsertResult {
	/** The final result of the INSERT (or the pre-existing SELECT when present). */
	readonly result: QueryResult;
	/** True when the identity key was already present before this call inserted. */
	readonly alreadyPresent: boolean;
	/**
	 * True when the post-insert re-verification observed MORE than one row for
	 * the identity key — a race doubled the row. The caller reconciles; the
	 * point of this primitive is to make the race OBSERVABLE, not silent (FR-5).
	 */
	readonly raceDetected: boolean;
}

/**
 * SELECT-before-INSERT (FR-5 / d-AC-2): check the identity key, insert if
 * absent, then RE-VERIFY after insert. Cannot prevent a race (no transactions),
 * so it makes the race observable: the re-verification SELECT counts the rows
 * for the key, and more than one means a concurrent writer doubled it. Used by
 * `codebase` snapshots. Heal-aware.
 */
export async function selectBeforeInsert(
	client: StorageQuery,
	target: HealTarget,
	scope: QueryScope,
	args: {
		readonly keyColumn: string;
		readonly keyValue: string;
		readonly row: RowValues;
	},
): Promise<SelectBeforeInsertResult> {
	const tbl = sqlIdent(target.table);
	const key = sqlIdent(args.keyColumn);
	const probeSql = `SELECT ${key} FROM "${tbl}" WHERE ${key} = ${sLiteral(args.keyValue)} LIMIT 1`;

	const probe = await withHeal(client, target, scope, () => client.query(probeSql, scope));
	if (isOk(probe) && probe.rows.length > 0) {
		return { result: probe, alreadyPresent: true, raceDetected: false };
	}

	const { cols, vals } = buildColsVals(args.row);
	const insertSql = `INSERT INTO "${tbl}" (${cols}) VALUES (${vals})`;
	const inserted = await withHeal(client, target, scope, () => client.query(insertSql, scope));
	if (!isOk(inserted)) return { result: inserted, alreadyPresent: false, raceDetected: false };

	// Re-verify: count the rows for the identity key now. >1 means a race
	// doubled it — observable, not silent.
	const verifySql = `SELECT ${key} FROM "${tbl}" WHERE ${key} = ${sLiteral(args.keyValue)}`;
	const verify = await client.query(verifySql, scope);
	const raceDetected = isOk(verify) && verify.rows.length > 1;
	return { result: inserted, alreadyPresent: false, raceDetected };
}

/**
 * Read an append-only table's rows for a `path`, ordered by `creation_date`
 * (FR-9): the reader convention paired with {@link appendOnlyInsert} for
 * `sessions`. The caller concatenates the ordered rows.
 */
export function readAppendOrdered(
	client: StorageQuery,
	target: HealTarget,
	scope: QueryScope,
	pathValue: string,
	selectColumns = "*",
): Promise<QueryResult> {
	const tbl = sqlIdent(target.table);
	const cols = sqlColumnList(selectColumns);
	const sql =
		`SELECT ${cols} FROM "${tbl}" ` +
		`WHERE path = ${sLiteral(pathValue)} ` +
		"ORDER BY creation_date ASC";
	return client.query(sql, scope);
}

/** Re-export so a caller building a fragment can reach the escape helpers. */
export { eLiteral, sLiteral, sqlColumnList, sqlIdent, sqlStr };
