/**
 * PRD-002b SQL Safety Escaping — proves b-AC-1..7.
 *
 * The escaping helpers are the security floor for the whole data layer (no
 * parameterized binding on the DeepLake endpoint). Each AC has a named test.
 * b-AC-7 drives the real `scripts/audit-sql-safety.mjs` gate against a clean
 * tree (exit 0) and a planted bypass (exit non-zero) to prove it has teeth.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	clampSessionTurns,
	eLiteral,
	MAX_SESSION_TURNS,
	sLiteral,
	sqlColumnList,
	sqlIdent,
	sqlLike,
	sqlStr,
} from "../../../src/daemon/storage/sql.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const AUDIT_SCRIPT = join(REPO_ROOT, "scripts", "audit-sql-safety.mjs");

describe("PRD-002b SQL safety escaping", () => {
	it("b-AC-1 sqlStr doubles quotes/backslashes and drops NUL/control chars", () => {
		expect(sqlStr("it's")).toBe("it''s");
		expect(sqlStr("a\\b")).toBe("a\\\\b");
		// NUL dropped; a backslash before a quote is doubled, then quote doubled.
		expect(sqlStr("x\0y")).toBe("xy");
		expect(sqlStr("a\x01b\x07c\x1fd\x7fe")).toBe("abcde");
		// Printable whitespace is preserved (newline/tab/CR are not stripped).
		expect(sqlStr("a\nb\tc\rd")).toBe("a\nb\tc\rd");
	});

	it("b-AC-2 sqlIdent accepts only the safe charset and throws otherwise", () => {
		expect(sqlIdent("memory")).toBe("memory");
		expect(sqlIdent("_v2_col")).toBe("_v2_col");
		expect(() => sqlIdent("1col")).toThrow(/Invalid SQL identifier/);
		expect(() => sqlIdent("col-name")).toThrow(/Invalid SQL identifier/);
		expect(() => sqlIdent("col name")).toThrow(/Invalid SQL identifier/);
		expect(() => sqlIdent('a"b')).toThrow(/Invalid SQL identifier/);
	});

	it("b-AC-3 sqlLike escapes % and _ wildcards as literals", () => {
		expect(sqlLike("100%")).toBe("100\\%");
		expect(sqlLike("a_b")).toBe("a\\_b");
		expect(sqlLike("50%_off")).toBe("50\\%\\_off");
		// A quote inside a LIKE term is still escaped by the same literal layer.
		expect(sqlLike("o'_%")).toBe("o''\\_\\%");
	});

	it("b-AC-3 sqlLike escapes backslashes in the input (regression: incomplete-sanitization)", () => {
		// A lone backslash is the escape char itself. It MUST be doubled so LIKE reads
		// it as one literal backslash and does not consume a following metacharacter as
		// escaped. One backslash in -> "\\\\" (two backslashes) in the SQL text.
		expect(sqlLike("\\")).toBe("\\\\");
		// "\%" in the input is a literal backslash THEN a literal percent. The backslash
		// is doubled and the percent gets its own escape backslash, so neither the input
		// backslash nor the wildcard is ever live: "\\\\\\%" = \\ + \% in the SQL text.
		expect(sqlLike("\\%")).toBe("\\\\\\%");
		// Same for a literal backslash then underscore.
		expect(sqlLike("\\_")).toBe("\\\\\\_");
		// "100\%": digits pass through, the input backslash is doubled, the percent is
		// escaped. Every wildcard ends up with EXACTLY one escape backslash; the input
		// backslash is doubled. No metacharacter reaches LIKE live.
		expect(sqlLike("100\\%")).toBe("100\\\\\\%");
		// Backslash adjacent to a quote: the backslash is doubled by the first pass and
		// the quote is doubled by the literal-layer pass, independently. No statement
		// breakout is possible (the quote can never close the literal early), and the
		// backslash cannot escape the closing quote because it is itself doubled.
		expect(sqlLike("\\'")).toBe("\\\\''");
		expect(sqlLike("'\\")).toBe("''\\\\");
	});

	it("b-AC-4 E'...' body round-trips \\n and other escapes to intended bytes", () => {
		const body = "line1\nline2\ttab\\slash";
		// sqlStr doubles the backslash; E'...' un-doubles it at parse time, so the
		// stored bytes equal the original. We assert the literal SHAPE here (the
		// fake transport has no parser): backslash doubled, wrapped in E'...'.
		expect(eLiteral(body)).toBe("E'line1\nline2\ttab\\\\slash'");
		// The single backslash in the source became a doubled backslash in the
		// literal — that is the round-trip-safe form under E'...'.
		expect(eLiteral("a\\b")).toBe("E'a\\\\b'");
	});

	it("b-AC-5 an injection payload via sqlStr is one inert literal, no 2nd statement", () => {
		const payload = "'; DROP TABLE x; --";
		const escaped = sqlStr(payload);
		// Every embedded quote is doubled, so it can never close the string early.
		expect(escaped).toBe("''; DROP TABLE x; --");
		const literal = sLiteral(payload);
		expect(literal).toBe("'''; DROP TABLE x; --'");
		// The literal opens and closes with exactly one outer quote pair; the only
		// other quotes are the doubled inner ones — no bare quote splits it.
		expect(literal.startsWith("'")).toBe(true);
		expect(literal.endsWith("'")).toBe(true);
		// No occurrence of a single (odd) quote that would terminate the literal
		// and start a second statement: replacing all doubled quotes leaves just
		// the two outer delimiters.
		const withoutDoubled = literal.replace(/''/g, "");
		expect((withoutDoubled.match(/'/g) ?? []).length).toBe(2);
	});

	it("b-AC-6 a crafted column name via sqlIdent throws; query is never built", () => {
		expect(() => sqlIdent("id; DROP")).toThrow(/Invalid SQL identifier/);
		// Simulate a builder: it must throw at sqlIdent before string assembly.
		const build = (col: string): string => `SELECT ${sqlIdent(col)} FROM "t"`;
		expect(() => build("id; DROP TABLE t; --")).toThrow(/Invalid SQL identifier/);
	});

	it("b-AC-2 sqlColumnList accepts '*' or validated identifiers and throws otherwise", () => {
		// The wildcard and bare identifier lists are the only safe projections.
		expect(sqlColumnList("*")).toBe("*");
		expect(sqlColumnList("  * ")).toBe("*");
		expect(sqlColumnList("id")).toBe("id");
		expect(sqlColumnList("id, summary")).toBe("id, summary");
		expect(sqlColumnList(" id ,summary_embedding ")).toBe("id, summary_embedding");
		// A crafted projection cannot smuggle a subquery, function, or 2nd column
		// that exfiltrates another table — every item is validated as an identifier.
		expect(() => sqlColumnList("id, (SELECT token FROM secrets)")).toThrow(/Invalid SQL identifier/);
		expect(() => sqlColumnList("*, token")).toThrow(/Invalid SQL identifier/);
		expect(() => sqlColumnList("id; DROP TABLE t; --")).toThrow(/Invalid SQL identifier/);
		expect(() => sqlColumnList("count(*)")).toThrow(/Invalid SQL identifier/);
	});

	/** Run the audit gate over a one-file temp dir; return its exit code (0 on pass). */
	function runGateOn(fileName: string, contents: string): number {
		const dir = mkdtempSync(join(tmpdir(), "sql-audit-"));
		try {
			writeFileSync(join(dir, fileName), contents);
			try {
				execFileSync(process.execPath, [AUDIT_SCRIPT, dir], { cwd: REPO_ROOT, encoding: "utf-8" });
				return 0;
			} catch (e) {
				return (e as { status?: number }).status ?? -1;
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it("b-AC-7 the audit gate passes the clean production tree (incl. legit concat sites)", () => {
		// The real storage dir routes every value through helpers AND contains the
		// two legitimate static-literal + helper-guarded-template concatenations
		// (schema.ts buildIntrospectionSql, vector.ts buildVectorSearchSql). The gate
		// must exit 0 over the whole tree — those line continuations are NOT bypasses.
		const clean = execFileSync(process.execPath, [AUDIT_SCRIPT], {
			cwd: REPO_ROOT,
			encoding: "utf-8",
		});
		expect(clean).toMatch(/every SQL interpolation routes through an escaping helper/);
	});

	it("b-AC-7 the audit gate flags a template-literal `${...}` interpolation bypass", () => {
		// `${v}` dropped straight into a SQL string with no helper — the original
		// false-negative class. Must exit non-zero.
		const exitCode = runGateOn(
			"bypass-template.ts",
			"export const q = (v: string) => `SELECT * FROM \"t\" WHERE id = '${v}'`;\n",
		);
		expect(exitCode).not.toBe(0);
	});

	it("b-AC-7 the audit gate flags a string-concatenation bypass", () => {
		// `"... '" + userId + "'"` — the most classic SQL-injection shape and the
		// hole that REOPENED b-AC-7. The raw `userId` operand is concatenated into a
		// SQL-fingerprinted literal with no helper. Must exit non-zero.
		const exitCode = runGateOn(
			"bypass-concat.ts",
			"export function bad(client: any, userId: string) {\n" +
				'  const sql = "SELECT * FROM t WHERE id = \'" + userId + "\'";\n' +
				'  return client.query(sql, { org: "o" });\n' +
				"}\n",
		);
		expect(exitCode).not.toBe(0);
	});

	it("b-AC-7 the audit gate flags a raw SELECT-list projection bypass (regression)", () => {
		// The blind spot: a caller-supplied projection interpolated straight after
		// SELECT, with the FROM clause on the NEXT concatenated line, carried no
		// keyword the old fingerprint could match and slipped the gate entirely.
		// The strengthened fingerprint (SELECT ${...}) must now flag it.
		const exitCode = runGateOn(
			"bypass-projection.ts",
			"export function bad(client: any, cols: string, tbl: string) {\n" +
				"  const t = sqlIdent(tbl);\n" +
				"  const sql =\n" +
				'    `SELECT ${cols} FROM "${t}" ` +\n' +
				'    "ORDER BY version DESC LIMIT 1";\n' +
				'  return client.query(sql, { org: "o" });\n' +
				"}\n",
		);
		expect(exitCode).not.toBe(0);
	});

	it("b-AC-7 the audit gate does NOT flag a helper-guarded SELECT-list projection", () => {
		// The fixed shape: the projection routed through sqlColumnList is recognized
		// as guarded, so the same SELECT ${...} line stays PASSING.
		const exitCode = runGateOn(
			"safe-projection.ts",
			'import { sqlColumnList, sqlIdent } from "./sql.js";\n' +
				"export function good(client: any, selectColumns: string, tbl: string) {\n" +
				"  const t = sqlIdent(tbl);\n" +
				"  const cols = sqlColumnList(selectColumns);\n" +
				'  const sql = `SELECT ${cols} FROM "${t}" ORDER BY version DESC LIMIT 1`;\n' +
				'  return client.query(sql, { org: "o" });\n' +
				"}\n",
		);
		expect(exitCode).toBe(0);
	});

	it("PERF clampSessionTurns bounds the session-read LIMIT into [1, MAX_SESSION_TURNS]", () => {
		expect(clampSessionTurns()).toBe(MAX_SESSION_TURNS); // missing → default cap
		expect(clampSessionTurns(Number.NaN)).toBe(MAX_SESSION_TURNS); // non-finite → cap
		expect(clampSessionTurns(50)).toBe(50); // in range → unchanged
		expect(clampSessionTurns(MAX_SESSION_TURNS + 1)).toBe(MAX_SESSION_TURNS); // over → cap
		expect(clampSessionTurns(0)).toBe(1); // under → floor
		expect(clampSessionTurns(-100)).toBe(1); // negative → floor
		expect(clampSessionTurns(12.9)).toBe(12); // truncated toward zero
	});

	it("b-AC-7 the audit gate does NOT flag a literal-only / helper-guarded concat", () => {
		// The legitimate shape that must stay PASSING: a static SQL string literal
		// concatenated to a helper-guarded template-literal fragment across lines.
		// No raw value is concatenated, so the gate exits 0.
		const exitCode = runGateOn(
			"safe-concat.ts",
			'import { sqlStr } from "./sql.js";\n' +
				"export function ok(t: string): string {\n" +
				'  return "SELECT column_name FROM information_schema.columns " +\n' +
				"    `WHERE table_name = '${sqlStr(t)}'`;\n" +
				"}\n",
		);
		expect(exitCode).toBe(0);
	});
});
