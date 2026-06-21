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
 * ──────────────────────────────────────────────────────────────────────────
 * TRANSIENT-FLAP RESILIENCE (fix/heal-introspection-transient-resilience)
 * ──────────────────────────────────────────────────────────────────────────
 * The heal's `information_schema` introspection SELECT is a READ against the
 * same DeepLake backend that flaps stale segments / transient 5xx under load
 * (the documented eventual-consistency posture). A single non-ok introspection
 * read must NOT turn a legitimate write into a hard failure:
 *
 *   1. `readColumnSet` RETRIES the introspection a bounded number of times when
 *      the failure is TRANSIENT (`connection_error` / `timeout`, or a 5xx-shaped
 *      `query_error`) — mirroring the trigger/job-queue `RESOLVE_POLLS` posture.
 *      A NON-transient `query_error` (permission/syntax) still throws IMMEDIATELY
 *      (the anti-mask rule: a credentials/syntax fault never masquerades as a
 *      recoverable gap, and never pays pointless retries). The deterministic fake
 *      settles on the first attempt, so only the live flap pays the retry cost.
 *
 *   2. When the introspection STILL can't complete after retries, `HealFailure`
 *      is tagged `phase: "introspection"`. `withHeal` treats that as "could not
 *      determine the schema, but the write is the source of truth" and proceeds
 *      to its single write retry anyway rather than 500ing — for the missing-TABLE
 *      path the table was just CREATEd with the full ColumnDef so the retry
 *      succeeds; for missing-COLUMN the retry's own result is the honest answer.
 *      A `phase: "alter"` HealFailure (a real column genuinely could not be
 *      ADDed) is a true schema problem, not a flap, and STILL propagates.
 *
 * The engine consumes the Wave-1 `StorageQuery` (`query(sql, scope, opts)` →
 * `QueryResult`): it branches on `result.kind`, never on a thrown shape. It is
 * the table catalog's job (PRD-003) to supply the ColumnDef array per table; the
 * engine is catalog-agnostic.
 */

import type { QueryScope, StorageQuery } from "./client.js";
import { isOk, type QueryResult, type StorageRow } from "./result.js";
import { setTimeout as delay } from "node:timers/promises";
import {
	buildAddColumnSql,
	buildCreateTableSql,
	buildIntrospectionSql,
	buildTableExistsSql,
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
		throw new HealFailure(`ALTER ADD COLUMN "${target.table}"."${col.name}" failed`, res, "alter");
	}
	return { missing, altered };
}

/**
 * Probe whether a table exists via the Postgres catalog WITHOUT touching the
 * table itself (PRD-002c read-path guard). The companion to `withHeal`: where
 * `withHeal` CREATES a missing table on a failed WRITE, this lets a READ decide
 * "the table is absent" cheaply and SILENTLY — `information_schema.tables`
 * returns zero rows for a not-yet-created table, so the backend never logs a
 * `relation "<t>" does not exist` (42P01) the way a bare SELECT against the
 * table would. A read uses this to skip the SELECT entirely; creation stays on
 * the write path so a read never provokes a CREATE.
 *
 * Returns `true`/`false` when the catalog answered, or `null` when the probe
 * itself failed (connection/timeout/query error) — "could not determine".
 * Callers FAIL OPEN on `null` (proceed with the read) so a transient catalog
 * blip never wrongly reports a live table as absent.
 */
export async function tableExists(client: StorageQuery, tableName: string, scope: QueryScope): Promise<boolean | null> {
	const res = await client.query(buildTableExistsSql(tableName, scope.workspace ?? ""), scope);
	if (!isOk(res)) return null;
	return res.rows.length > 0;
}

/**
 * How many times the introspection SELECT is attempted before giving up. The
 * first attempt is not a "retry"; the budget covers the original call plus its
 * bounded re-reads under a transient flap. Mirrors the trigger/job-queue
 * `RESOLVE_POLLS` rationale: the deterministic fake settles on the first attempt,
 * so this is a live-only cost.
 */
const INTROSPECTION_ATTEMPTS = 5;

/** Backoff between introspection retries (ms). Short — the flap is brief. */
const INTROSPECTION_RETRY_DELAY_MS = 50;

/**
 * Is this non-ok introspection result a TRANSIENT backend flap (worth a retry),
 * as opposed to a deterministic rejection (permission/syntax — never retry)?
 *
 * Transient: a dropped/refused socket (`connection_error`), a `timeout`, or a
 * `query_error` whose HTTP status is 5xx (the backend itself faulted mid-request
 * — the stale-segment / transient-5xx flap). A `query_error` with a 4xx status
 * or no status (a genuine statement rejection: permission, syntax, bad relation)
 * is NON-transient and must surface immediately — retrying it only burns balance
 * and masks the real fault (anti-mask rule).
 */
function isTransientResult(res: QueryResult): boolean {
	if (res.kind === "connection_error" || res.kind === "timeout") return true;
	if (res.kind === "query_error") return res.status !== undefined && res.status >= 500 && res.status < 600;
	return false;
}

/**
 * Run the introspection SELECT and collect the present column names (lowercased).
 *
 * On a TRANSIENT non-ok result (see `isTransientResult`) the read is retried up
 * to `INTROSPECTION_ATTEMPTS` total, with a short backoff, so a brief backend
 * flap during heal does not abort the heal. A NON-transient non-ok result
 * (permission/syntax) throws IMMEDIATELY with no retries — preserving the
 * anti-mask rule. If every attempt flaps transiently, the final `HealFailure` is
 * tagged `phase: "introspection"` so `withHeal` can tell "couldn't determine the
 * schema" apart from a genuine ALTER failure and fall back to the write retry.
 */
async function readColumnSet(client: StorageQuery, introspectSql: string, scope: QueryScope): Promise<Set<string>> {
	let last: QueryResult | undefined;
	for (let attempt = 1; attempt <= INTROSPECTION_ATTEMPTS; attempt++) {
		const res = await client.query(introspectSql, scope);
		if (isOk(res)) {
			const present = new Set<string>();
			for (const row of res.rows as StorageRow[]) {
				const v = row.column_name;
				if (typeof v === "string") present.add(v.toLowerCase());
			}
			return present;
		}
		last = res;
		// Deterministic rejection (permission/syntax/4xx): surface now, never retry.
		if (!isTransientResult(res)) {
			throw new HealFailure("information_schema introspection failed", res, "introspection");
		}
		// Transient flap: back off and re-read, unless this was the last attempt.
		if (attempt < INTROSPECTION_ATTEMPTS) await delay(INTROSPECTION_RETRY_DELAY_MS);
	}
	// Exhausted the budget on a persistent transient flap. Tagged "introspection"
	// so `withHeal` falls back to the write retry rather than 500ing.
	throw new HealFailure("information_schema introspection failed", last as QueryResult, "introspection");
}

/**
 * Which heal step produced a `HealFailure`. The discriminator lets `withHeal`
 * tell a transient "couldn't introspect" apart from a genuine "couldn't ALTER":
 *   - `"introspection"` — the `information_schema` SELECT could not complete
 *     (after the bounded transient retries, or a non-transient rejection). When
 *     this is a transient flap, the write itself is the source of truth, so
 *     `withHeal` falls back to its single write retry rather than failing.
 *   - `"alter"` — an `ALTER ADD COLUMN` genuinely failed (the column could not
 *     be added). A real schema problem that always propagates.
 */
export type HealPhase = "introspection" | "alter";

/**
 * A heal step (introspection or ALTER) itself failed with a non-recoverable
 * result. Carries the underlying `QueryResult` so a caller can inspect it, plus
 * a `phase` discriminator so `withHeal` can distinguish an introspection flap
 * (fall back to the write retry) from a genuine ALTER failure (propagate).
 * Thrown rather than returned because a failed heal is exceptional — the normal
 * paths return a `QueryResult` union.
 */
export class HealFailure extends Error {
	readonly result: QueryResult;
	/** Which heal step failed — see `HealPhase`. */
	readonly phase: HealPhase;
	constructor(message: string, result: QueryResult, phase: HealPhase) {
		super(message);
		this.name = "HealFailure";
		this.result = result;
		this.phase = phase;
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

	// missing-table: CREATE first (then column-heal the fresh table). missing-column:
	// column-heal in place. Either way the column heal is run through the tolerant
	// wrapper: an introspection FLAP must NOT abort the write — for missing-table
	// the table was just CREATEd with the full ColumnDef so the retry succeeds; for
	// missing-column the retry's own result is the honest answer. A genuine ALTER
	// failure (phase "alter") still propagates.
	if (failure === "missing-table") {
		const created = await client.query(buildCreateTableSql(target.table, target.columns), scope);
		if (!isOk(created)) return created; // could not create — surface it, do not loop.
	}
	await healColumnsTolerant(client, target, scope);

	// Exactly one retry. Whatever this returns — ok, or a second failure — is the
	// final answer; we never enter a second heal/retry cycle (c-AC-4).
	return runWrite();
}

/**
 * Run `healColumns`, but SWALLOW a `phase: "introspection"` `HealFailure` so a
 * transient `information_schema` flap during heal does not turn a legitimate
 * write into a 500 (fix/heal-introspection-transient-resilience). The write
 * retry in `withHeal` is the source of truth in that case. A `phase: "alter"`
 * failure (a real column could not be added) and any non-`HealFailure` error
 * (e.g. a `sqlIdent` rejection on a bad table name — preserves c-AC-7) STILL
 * propagate untouched.
 */
async function healColumnsTolerant(client: StorageQuery, target: HealTarget, scope: QueryScope): Promise<void> {
	try {
		await healColumns(client, target, scope);
	} catch (err) {
		if (err instanceof HealFailure && err.phase === "introspection") return; // flap → fall back to write retry.
		throw err; // genuine ALTER failure, or a non-heal error (sqlIdent guard): propagate.
	}
}
