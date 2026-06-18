/**
 * In-memory append-only `StorageQuery` fake for the PRD-013a source lifecycle
 * tests.
 *
 * It models the ONLY shapes the source lifecycle emits against the artifact tables:
 *   - `INSERT INTO "<tbl>" (cols) VALUES (vals)`  → append a row (rows accumulate;
 *      never coalesced — exactly the append-only contract).
 *   - `SELECT * FROM "<tbl>" WHERE id = '<id>' ORDER BY version DESC LIMIT 1`
 *      → the row with the highest `version` for that id (current-state resolve).
 *   - `SELECT DISTINCT id FROM "<tbl>" WHERE source_id = '<sid>'`
 *      → every distinct id whose rows carry that `source_id`.
 *   - `SELECT chunk_embedding FROM "<tbl>" WHERE content_hash = '<h>' AND
 *      chunk_embedding IS NOT NULL LIMIT 1`
 *      → the stored embedding of the highest-version chunk row carrying that
 *      `content_hash` (the 013b cross-document shared-embedding probe, b-AC-4).
 *
 * It is deliberately strict-shape (not a SQL engine): the lifecycle's reads/writes
 * go through the guarded builders, so the emitted SQL is stable and parseable by a
 * few regexes. Every issued statement is recorded in `statements` so a test can
 * assert NO in-place `UPDATE` was emitted (a-AC-4) — the load-bearing assertion.
 *
 * Tables are treated as already-existing, so the heal path never fires (the heal
 * mechanism is proven in PRD-002's own tests; here we exercise the append-only
 * status-advance + scoped-purge logic).
 */

import type { QueryScope, StorageQuery } from "../../src/daemon/storage/client.js";
import { ok, type QueryResult, type StorageRow } from "../../src/daemon/storage/result.js";

/** A recorded statement, for post-hoc assertions (a-AC-4: no UPDATE emitted). */
export interface RecordedStatement {
	readonly sql: string;
	readonly org: string;
	readonly workspace: string;
}

/** Parse the `(col, col, ...) VALUES (v, v, ...)` of an INSERT into a row object. */
function parseInsert(sql: string): { table: string; row: StorageRow } | null {
	const m = /^INSERT INTO "([^"]+)" \((.*?)\) VALUES \((.*)\)$/s.exec(sql.trim());
	if (m === null) return null;
	const table = m[1];
	const cols = splitTop(m[2]).map((s) => s.trim());
	const vals = splitTop(m[3]).map((s) => s.trim());
	const row: StorageRow = {};
	for (let i = 0; i < cols.length; i++) {
		row[cols[i]] = decodeValue(vals[i] ?? "");
	}
	return { table, row };
}

/** Split a comma list at the TOP level (not inside quotes / parens / brackets). */
function splitTop(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let inStr = false;
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (inStr) {
			cur += ch;
			if (ch === "'") {
				// A doubled '' is an escaped quote inside the literal — stay in-string.
				if (s[i + 1] === "'") {
					cur += "'";
					i++;
				} else {
					inStr = false;
				}
			}
			continue;
		}
		if (ch === "'") {
			inStr = true;
			cur += ch;
			continue;
		}
		if (ch === "(" || ch === "[") depth++;
		else if (ch === ")" || ch === "]") depth--;
		if (ch === "," && depth === 0) {
			out.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	if (cur.trim() !== "") out.push(cur);
	return out;
}

/** Decode a SQL value literal back into a JS value (string / number). */
function decodeValue(raw: string): unknown {
	const v = raw.trim();
	if (v === "NULL") return null;
	if (/^E'/.test(v)) return unquote(v.slice(1));
	if (/^'/.test(v)) return unquote(v);
	if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
	if (/^ARRAY\[/.test(v)) return v; // a vector literal — kept raw (unused in reads).
	return v;
}

/** Strip the surrounding quotes of a `'...'` literal and un-double inner quotes. */
function unquote(v: string): string {
	if (!v.startsWith("'") || !v.endsWith("'")) return v;
	return v.slice(1, -1).replace(/''/g, "'").replace(/\\\\/g, "\\");
}

/** Extract the first `<col> = '<value>'` predicate's value from a WHERE clause. */
function whereValue(sql: string, column: string): string | null {
	const re = new RegExp(`${column}\\s*=\\s*'((?:[^']|'')*)'`);
	const m = re.exec(sql);
	return m === null ? null : m[1].replace(/''/g, "'");
}

/** Extract the table name from a `FROM "<tbl>"`. */
function fromTable(sql: string): string | null {
	const m = /FROM "([^"]+)"/.exec(sql);
	return m === null ? null : m[1];
}

/**
 * An in-memory append-only storage fake. Every INSERT appends; reads resolve the
 * highest version. Construct one per test.
 */
export class FakeArtifactStore implements StorageQuery {
	/** Every statement issued, in order (assert NO `UPDATE` was emitted — a-AC-4). */
	readonly statements: RecordedStatement[] = [];
	/** table → accumulated rows (append-only; never mutated in place). */
	private readonly tables = new Map<string, StorageRow[]>();

	async query(sql: string, scope: QueryScope): Promise<QueryResult> {
		this.statements.push({ sql, org: scope.org, workspace: scope.workspace ?? "" });
		const trimmed = sql.trim();

		if (trimmed.startsWith("INSERT INTO")) {
			const parsed = parseInsert(trimmed);
			if (parsed !== null) {
				const rows = this.tables.get(parsed.table) ?? [];
				rows.push(parsed.row);
				this.tables.set(parsed.table, rows);
			}
			return ok([], 0);
		}

		// The 013b cross-document shared-embedding probe (b-AC-4): the highest-version
		// chunk row carrying this content_hash whose chunk_embedding is non-null.
		if (/SELECT chunk_embedding FROM/.test(trimmed) && /content_hash\s*=/.test(trimmed)) {
			const table = fromTable(trimmed);
			const hash = whereValue(trimmed, "content_hash");
			const rows = (table && this.tables.get(table)) || [];
			const matching = rows.filter(
				(r) => r.content_hash === hash && r.chunk_embedding !== undefined && r.chunk_embedding !== null,
			);
			if (matching.length === 0) return ok([], 0);
			const highest = matching.reduce((best, r) =>
				Number(r.version ?? 0) >= Number(best.version ?? 0) ? r : best,
			);
			return ok([{ chunk_embedding: highest.chunk_embedding }], 0);
		}

		if (/^SELECT DISTINCT id FROM/.test(trimmed)) {
			const table = fromTable(trimmed);
			const sourceId = whereValue(trimmed, "source_id");
			const rows = (table && this.tables.get(table)) || [];
			const ids = new Set<string>();
			for (const r of rows) {
				if (sourceId === null || r.source_id === sourceId) {
					if (typeof r.id === "string") ids.add(r.id);
				}
			}
			return ok([...ids].map((id) => ({ id })), 0);
		}

		if (/ORDER BY (?:")?version(?:")? DESC LIMIT 1/.test(trimmed)) {
			const table = fromTable(trimmed);
			const id = whereValue(trimmed, "id");
			const rows = (table && this.tables.get(table)) || [];
			const matching = rows.filter((r) => r.id === id);
			if (matching.length === 0) return ok([], 0);
			const highest = matching.reduce((best, r) =>
				Number(r.version ?? 0) >= Number(best.version ?? 0) ? r : best,
			);
			return ok([{ ...highest }], 0);
		}

		// Any other SELECT → empty (the lifecycle only emits the shapes above).
		return ok([], 0);
	}

	/** Test introspection: every accumulated row for a table (full history). */
	rowsOf(table: string): readonly StorageRow[] {
		return this.tables.get(table) ?? [];
	}

	/** Test introspection: the current (highest-version) row for an id, or null. */
	currentOf(table: string, id: string): StorageRow | null {
		const rows = (this.tables.get(table) ?? []).filter((r) => r.id === id);
		if (rows.length === 0) return null;
		return rows.reduce((best, r) => (Number(r.version ?? 0) >= Number(best.version ?? 0) ? r : best));
	}

	/** Did this fake ever receive an in-place UPDATE? (a-AC-4 must be false.) */
	emittedUpdate(): boolean {
		return this.statements.some((s) => /^\s*UPDATE\s/i.test(s.sql));
	}
}
