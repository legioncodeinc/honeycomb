/**
 * Shared in-memory harness for the keyed-table API suites (goals + kpis) — PRD-022c.
 *
 * Provides ONE `StorageQuery` fake that honours the `updateOrInsertByKey` semantics the
 * goals/kpis upsert relies on (SELECT-by-key LIMIT 1 → UPDATE the row's columns if present,
 * else INSERT) plus the scoped read SELECTs the GET handlers issue. Defined once here so the
 * goals + kpis suites do not each re-implement the SQL fake (jscpd discipline). The fake is
 * intentionally minimal: it pattern-matches the exact statement shapes the keyed engine
 * emits, never a general SQL engine.
 */

import { Hono } from "hono";

import type { QueryResult, StorageRow } from "../../../../src/daemon/storage/result.js";
import { ok, queryError } from "../../../../src/daemon/storage/result.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";

/** An in-memory keyed table that mimics the update-or-insert-by-key write path. */
export class KeyedTableFake implements StorageQuery {
	readonly rows: StorageRow[] = [];

	constructor(private readonly table: string) {}

	query(sql: string, _scope: QueryScope): Promise<QueryResult> {
		const start = sql.trim().toUpperCase();
		if (start.startsWith("SELECT")) return Promise.resolve(this.handleSelect(sql));
		if (start.startsWith("UPDATE")) return Promise.resolve(this.handleUpdate(sql));
		if (start.startsWith("INSERT")) return Promise.resolve(this.handleInsert(sql));
		return Promise.resolve(queryError(`KeyedTableFake: unhandled statement: ${sql.slice(0, 40)}`));
	}

	/** SELECT — either the upsert key-probe (`WHERE key = '...'`) or the scoped list read. */
	private handleSelect(sql: string): QueryResult {
		const keyMatch = sql.match(/WHERE\s+"?key"?\s*=\s*'((?:[^']|'')*)'/i);
		if (keyMatch) {
			const key = unquote(keyMatch[1] ?? "");
			const found = this.rows.filter((r) => r.key === key);
			return ok(found.map((r) => ({ ...r })), 1);
		}
		// The list read: every row, newest first by updated_at (the fake keeps insertion order).
		const sorted = [...this.rows].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
		return ok(sorted.map((r) => ({ ...r })), 1);
	}

	/** UPDATE — apply the `SET col = val` pairs to the row matching `WHERE key = '...'`. */
	private handleUpdate(sql: string): QueryResult {
		const keyMatch = sql.match(/WHERE\s+"?key"?\s*=\s*'((?:[^']|'')*)'/i);
		const key = keyMatch ? unquote(keyMatch[1] ?? "") : "";
		const row = this.rows.find((r) => r.key === key);
		if (row === undefined) return ok([], 1);
		const setPart = sql.slice(sql.toUpperCase().indexOf("SET") + 3, sql.toUpperCase().indexOf("WHERE"));
		for (const [col, raw] of parseAssignments(setPart)) {
			row[col] = raw;
		}
		return ok([], 1);
	}

	/** INSERT — parse the `(cols) VALUES (vals)` shape into a new row. */
	private handleInsert(sql: string): QueryResult {
		const m = sql.match(/\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)/i);
		if (!m) return queryError("KeyedTableFake: bad INSERT shape");
		const cols = splitTop(m[1] ?? "").map((c) => stripIdent(c.trim()));
		const vals = splitTop(m[2] ?? "").map((v) => decodeLiteral(v.trim()));
		const row: StorageRow = {};
		cols.forEach((c, i) => {
			row[c] = vals[i];
		});
		this.rows.push(row);
		return ok([], 1);
	}
}

/** Parse a `SET a = 'x', b = E'y'` clause into [column, decodedValue] pairs. */
function parseAssignments(setClause: string): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	for (const piece of splitTop(setClause)) {
		const eq = piece.indexOf("=");
		if (eq === -1) continue;
		const col = stripIdent(piece.slice(0, eq).trim());
		const val = decodeLiteral(piece.slice(eq + 1).trim());
		out.push([col, val]);
	}
	return out;
}

/** Split a comma list at the TOP level only (commas inside `'...'` literals are ignored). */
function splitTop(input: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let inStr = false;
	let cur = "";
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (inStr) {
			cur += ch;
			if (ch === "'") {
				// A doubled '' is an escaped quote, not a terminator.
				if (input[i + 1] === "'") {
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
		if (ch === "(") depth++;
		if (ch === ")") depth--;
		if (ch === "," && depth === 0) {
			parts.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	if (cur.trim().length > 0) parts.push(cur);
	return parts;
}

/** Strip surrounding double quotes from an identifier. */
function stripIdent(ident: string): string {
	return ident.replace(/^"(.*)"$/, "$1");
}

/** Decode a SQL literal fragment (`'x'`, `E'x'`, a bare number) to its JS value (as a string). */
function decodeLiteral(frag: string): string {
	let f = frag.trim();
	if (f.startsWith("E'") || f.startsWith("e'")) f = f.slice(1);
	if (f.startsWith("'") && f.endsWith("'")) {
		return unquote(f.slice(1, -1));
	}
	return f;
}

/** Un-double escaped single quotes inside a literal body. */
function unquote(body: string): string {
	return body.replace(/''/g, "'").replace(/\\'/g, "'");
}

/** A minimal `Daemon`-shaped object exposing `group()` + the storage fake the suites need. */
export interface KeyedDaemonHarness {
	readonly daemon: {
		readonly app: Hono;
		group(path: string): Hono | undefined;
		readonly storage: StorageQuery;
		readonly config: { mode: string; port: number };
	};
	readonly table: KeyedTableFake;
}

/**
 * Build a keyed-daemon harness: a single Hono router for `groupPath`, an in-memory
 * {@link KeyedTableFake} for `table`, and a `Daemon`-shaped object whose `group()` returns
 * the router (and `undefined` for any other path, exercising the no-op skip).
 */
export function makeKeyedDaemon(table: string, groupPath: string): KeyedDaemonHarness {
	// Mirror `server.ts`: a `basePath(groupPath)` router bound to the ROOT app, so a handler
	// attached AFTER this call still registers on the root at the full path (a plain
	// `app.route(base, sub)` COPIES routes at call time and would miss the later attach).
	const app = new Hono();
	const router = app.basePath(groupPath);
	const fake = new KeyedTableFake(table);
	const daemon = {
		app,
		group(path: string): Hono | undefined {
			return path === groupPath ? router : undefined;
		},
		storage: fake,
		config: { mode: "local", port: 0 },
	};
	return { daemon, table: fake };
}
