#!/usr/bin/env node
/**
 * SQL-safety audit gate (PRD-002b FR-7 / b-AC-7).
 *
 * The DeepLake endpoint binds no parameters, so the entire data layer relies on
 * the `sqlStr` / `sqlLike` / `sqlIdent` / `eLiteral` helpers in
 * `src/daemon/storage/sql.ts`. This script is the CI teeth behind that
 * convention (decision D-6, mirroring `audit-openclaw-bundle.mjs`): it scans the
 * storage source for a value or identifier interpolated DIRECTLY into a SQL
 * string template — i.e. a `${...}` inside a string literal that contains SQL
 * keywords — that does NOT go through one of the helpers. Any such bypass exits
 * non-zero so the `ci` script fails before the unsafe builder can ship.
 *
 * It ALSO catches the string-concatenation form of the same bypass (the most
 * classic SQL-injection shape): `"... SQL ..." + rawValue + "..."` (or
 * `rawValue + "... SQL ..."`). A concatenation operand that is a raw expression
 * (NOT a string/template literal, NOT numeric/prebuilt, NOT a safe-bound
 * identifier, NOT wrapped in a helper) joined into a SQL-fingerprinted statement
 * is flagged. Legitimate static-literal line continuations stay PASSING — e.g.
 * `"SELECT ... " + \`WHERE x = '${sqlStr(t)}'\`` — because every concatenated
 * operand there is itself a string/template literal (and any embedded `${...}`
 * is helper-guarded by the interpolation check above).
 *
 * This is a lightweight grep gate, not a full SQL parser: it is deliberately
 * conservative (flag a bypass, never silently pass one) and pairs with the typed
 * builder convention. The helpers' own module is exempt — it DEFINES the
 * escaping, so its `${value}`-shaped regex bodies are not call sites.
 *
 * Usage:
 *   node scripts/audit-sql-safety.mjs                 # scan src/daemon (default)
 *   node scripts/audit-sql-safety.mjs <dir>           # scan a specific dir
 *
 * Default scope is `src/daemon` — the WHOLE daemon, not just `src/daemon/storage`.
 * The storage layer is not the only place that hand-builds SQL: the daemon runtime
 * (`src/daemon/runtime/services/job-queue.ts`) builds its own version-bumped
 * statements. Scanning only `storage/` left that builder ungated, so the default
 * was widened to cover every daemon SQL builder. Pass a narrower dir explicitly
 * only for a focused re-scan; CI always runs the wide default.
 *
 * Exits non-zero on any finding.
 */

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";

const rawArgs = process.argv.slice(2);
const SCAN_DIR = rawArgs.find((a) => !a.startsWith("--")) ?? "src/daemon";
const SCANNABLE_EXT = new Set([".ts", ".mts", ".cts"]);

/**
 * The module that DEFINES the helpers is exempt: its bodies legitimately contain
 * `${...}` inside SQL-shaped strings (e.g. building `E'...'`). Test files and
 * declaration files are out of scope — only production builders are gated.
 */
const EXEMPT_BASENAMES = new Set(["sql.ts"]);

/** A `${...}` interpolation whose expression body we inspect for a helper call. */
const INTERPOLATION = /\$\{([^}]*)\}/g;

/**
 * The set of approved escaping helpers. An interpolation whose expression
 * mentions any of these is considered guarded. `sqlIdent`/`sqlStr`/`sqlLike`
 * escape values and identifiers; `eLiteral`/`sLiteral` build whole literals;
 * bare numbers/`String(n)` of a numeric are inlined intentionally (see below).
 */
const HELPER = /\b(sqlStr|sqlLike|sqlIdent|sqlColumnList|eLiteral|sLiteral)\s*\(/;

/**
 * STATEMENT fingerprint: a line is a SQL builder only when it carries a clause
 * keyword wired to query SYNTAX — `INSERT INTO`, `FROM "tbl"`, `WHERE col =`,
 * `SET col =`, `VALUES (`, `ALTER TABLE … ADD COLUMN`, `ORDER BY`, `CREATE TABLE
 * … USING`. Prose that merely MENTIONS a keyword (an error message like `ALTER
 * ADD COLUMN "x"."y" failed`, a JSDoc line) does not match, because the keyword
 * there is not adjacent to live query syntax. This is what keeps the gate from
 * flagging diagnostic strings and comments as bypasses.
 *
 * The `SELECT` alternatives deliberately include the interpolation-list shape
 * `SELECT ${...}` (a caller-supplied projection list) — without it, a line that
 * interpolates the column list directly after `SELECT` and breaks the line
 * before `FROM` would carry NO matchable keyword and slip the gate entirely.
 * Likewise `FROM "${...}"` is matched explicitly so a `FROM "<table>"` whose
 * table is interpolated is fingerprinted even when the rest of the clause is on
 * a following concatenated line.
 *
 * The keyword group carries a LEADING `\b` only — NOT a trailing one. A trailing
 * `\b` after an alternative whose final char class matched a single operand char
 * (`SELECT *`, `FROM "${t…`, `WHERE id…`) fails whenever that char is followed by
 * another identifier char (the common multi-char table/column case) or by a
 * non-word char like `*`. That false-negative let the single-line `SELECT * FROM
 * "${tbl}" WHERE id = '${raw}'` shape — and any raw value inside it — slip the
 * gate entirely. Keyword specificity comes from the required trailing query
 * syntax in each alternative (whitespace + an operand/identifier char), so the
 * leading `\b` alone is enough to avoid matching mid-word prose.
 */
const STATEMENT_FINGERPRINT =
	/(?:\b(?:INSERT\s+INTO|SELECT\s+[\w*]|FROM\s+["'`]?\$?\{?[\w"]|WHERE\s+[\w$]|VALUES\s*\(|SET\s+[\w$]|ADD\s+COLUMN\s+[\w$]|ORDER\s+BY\s+[\w$]|CREATE\s+TABLE\s+IF|ALTER\s+TABLE\s+["'`]|USING\s+deeplake|information_schema\.columns|::float4|::text\s+ILIKE)|SELECT\s+\$\{)/i;

/**
 * Lines that are comments or diagnostic-message assembly (an Error/throw/super
 * payload) are NOT statement builders — skip them so an error string that quotes
 * SQL keywords for humans is never mistaken for a query. A real builder assigns
 * to / returns a SQL string; it does not `throw new …Error(` it.
 */
const NON_BUILDER_LINE = /^\s*(\/\/|\*|\/\*)|throw\s+new\b|new\s+Error\s*\(|super\s*\(|console\.|\.write\s*\(/;

/**
 * An interpolation body is SAFE without a helper when it is plainly a number or
 * a numeric expression — non-string scalars are formatted inline at the call
 * site by design (PRD-002b open question resolved: no `sqlNum`/`sqlBool`; format
 * numbers inline, strings through helpers). We allow:
 *   - `Number(...)`, `.length`, a digit literal, or a numeric variable named like
 *     a count/limit/version/dim/multiplier/offset;
 *   - an already-built fragment variable suffixed `Sql`/`Clause(s)`/`Lit`/`Filter`/
 *     `Cols`/`Vals`/… (a fragment assembled elsewhere from helpers);
 *   - a SCREAMING_SNAKE_CASE constant (e.g. `KEY_REVOKED`, `KEY_LIVE`) — a
 *     compile-time numeric/string literal const, never a runtime/caller value;
 *   - a `.sql` / `.name` property of a load-validated `ColumnDef` (`col.sql`,
 *     `c.sql`, `col.name`) — schema text validated at load by `validateColumnDefs`
 *     / `sqlIdent`, not a runtime value sink.
 *
 * The fragment-suffix and count-suffix words allow an optional trailing plural
 * `s` (`Clauses`, `Limits`, `Counts`) so the `\b` lands after the real word end
 * rather than failing on the plural — without that, a legitimately pre-escaped
 * `setClauses` fragment was mis-flagged as a raw value.
 */
const NUMERIC_OR_PREBUILT =
	/^[\s(]*(Number\(|[\d.]+$|[A-Z][A-Z0-9_]*$|[A-Za-z_][\w.]*\.(sql|name)\b|[A-Za-z_][\w.]*\.length\b|[A-Za-z_]*([Ll]imit|[Cc]ount|[Vv]ersion|[Dd]im|[Mm]ultiplier|[Oo]ffset|[Nn]extVersion)s?\b|[A-Za-z_][\w.]*(Sql|Clause|Lit|Literal|Filter|Cols|Vals|Where|Body|Ident|Name|Table)s?\b)/;

/**
 * The known-safe SQL-fragment builders. A value bound from one of these (or from
 * one of the raw escaping helpers) is itself pre-escaped, so interpolating it is
 * safe. This is the data-flow seam: `buildColsVals` returns `{ cols, vals }`
 * already routed through `sqlIdent`/the value renderers, so `cols`/`vals` are
 * trusted downstream.
 */
const SAFE_BINDING_RHS =
	/\b(sqlStr|sqlLike|sqlIdent|sqlColumnList|eLiteral|sLiteral|renderValue|buildColsVals|buildScopeConjuncts|serializeFloat4Array)\s*\(/;

/**
 * Collect identifiers in a file that are bound from a known-safe builder, so an
 * interpolation of one of those is recognized as pre-escaped. Handles both plain
 * (`const tbl = sqlIdent(t)`) and destructured (`const { cols, vals } =
 * buildColsVals(row)`) bindings. Lightweight intra-file data-flow — not a full
 * type-checker, but enough to avoid flagging a value that demonstrably came from
 * a helper.
 */
function collectSafeBindings(lines) {
	const safe = new Set();
	for (const line of lines) {
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const rhs = line.slice(eq + 1);
		if (!SAFE_BINDING_RHS.test(rhs)) continue;
		const lhs = line.slice(0, eq);
		const destructure = lhs.match(/\{([^}]*)\}/);
		if (destructure) {
			for (const part of destructure[1].split(",")) {
				const name = part.split(":").pop().trim().replace(/\s+/g, "");
				if (/^[A-Za-z_]\w*$/.test(name)) safe.add(name);
			}
			continue;
		}
		const plain = lhs.match(/(?:const|let|var)\s+([A-Za-z_]\w*)\s*$/);
		if (plain) safe.add(plain[1]);
	}
	return safe;
}

/**
 * Collect class methods / getters whose body returns a value routed through a
 * known-safe builder, so an interpolation of `this.<method>()` is recognized as
 * pre-escaped. The job queue, for example, defines `private tbl(): string {
 * return sqlIdent(this.cfg.tableName); }` and then interpolates `${this.tbl()}`
 * — the returned string IS `sqlIdent`-validated, but the call SITE shows only
 * `this.tbl()`, which the helper regex cannot see through. Without this pass the
 * gate would either false-positive on every such call or force the code to inline
 * the helper at every site. We match two shapes:
 *   - one-line method:  `tbl(): string { return sqlIdent(...); }`
 *   - one-line getter:  `get cols() { return sqlColumnList(...); }`
 * plus a multi-line form where the `methodName(...) {` header is followed within a
 * few lines by a `return <SAFE_BINDING_RHS>` before the method's first `}` at the
 * same indentation. Conservative: only a return whose expression is wholly a safe
 * helper call (no concatenation with a raw operand) marks the method safe.
 */
function collectSafeMethods(lines) {
	const safe = new Set();
	// One-line `name(...) { ... return SAFE(...) ... }` (method or getter).
	const oneLine = /(?:get\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*(?::\s*[\w<>[\].| ]+)?\s*\{[^}]*\breturn\b([^}]*)\}/;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const m = line.match(oneLine);
		if (m && SAFE_BINDING_RHS.test(m[2]) && !/\+/.test(m[2])) {
			safe.add(m[1]);
			continue;
		}
		// Multi-line: a method header line, then a `return SAFE(...)` within a small
		// window. Only the header's name is captured; we require the return to be a
		// pure safe-helper expression (no `+` concatenation with a raw operand).
		const header = line.match(/(?:get\s+)?(?:private\s+|public\s+|protected\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*(?::\s*[\w<>[\].| ]+)?\s*\{\s*$/);
		if (header) {
			for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
				const body = lines[j];
				const ret = body.match(/^\s*return\b(.*);?\s*$/);
				if (ret) {
					if (SAFE_BINDING_RHS.test(ret[1]) && !/\+/.test(ret[1])) safe.add(header[1]);
					break;
				}
				if (/\}/.test(body)) break; // method ended before a return
			}
		}
	}
	return safe;
}

/**
 * Is the interpolation/operand body a call to a same-file safe method? Matches
 * `this.tbl()`, `tbl()`, or `self.tbl()` whose method name is in `safeMethods`.
 */
function isSafeMethodCall(body, safeMethods) {
	const m = body.match(/^(?:this\.|self\.)?([A-Za-z_]\w*)\s*\(\s*\)/);
	return m !== null && safeMethods.has(m[1]);
}

/**
 * Split a source line into its top-level `+`-separated operands, respecting
 * string / template-literal / parenthesis / bracket / brace nesting so a `+`
 * INSIDE a string (`"a + b"`), a template (`${x + 1}`), or a call's arg list
 * (`f(a + b)`) is NOT a split point. Returns the trimmed operand fragments. This
 * is the seam that lets us look at each piece of a `"sql" + value + "sql"`
 * concatenation independently. Conservative on purpose: when nesting is
 * unbalanced we still return whatever operands we accumulated, and the classifier
 * fails closed on anything it cannot prove safe.
 */
function splitTopLevelConcat(line) {
	const operands = [];
	let buf = "";
	let depth = 0; // () [] {}
	let inStr = null; // active quote char: ' " or `
	let escaped = false;
	let tmplDepth = 0; // ${ } nesting inside a template literal
	for (let k = 0; k < line.length; k++) {
		const ch = line[k];
		if (inStr) {
			buf += ch;
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (inStr === "`" && ch === "$" && line[k + 1] === "{") {
				tmplDepth++;
			} else if (inStr === "`" && ch === "}" && tmplDepth > 0) {
				tmplDepth--;
			} else if (ch === inStr && tmplDepth === 0) {
				inStr = null;
			}
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			inStr = ch;
			buf += ch;
			continue;
		}
		if (ch === "(" || ch === "[" || ch === "{") {
			depth++;
			buf += ch;
			continue;
		}
		if (ch === ")" || ch === "]" || ch === "}") {
			depth--;
			buf += ch;
			continue;
		}
		if (ch === "+" && depth === 0 && line[k + 1] !== "+" && line[k - 1] !== "+") {
			operands.push(buf.trim());
			buf = "";
			continue;
		}
		buf += ch;
	}
	if (buf.trim() !== "") operands.push(buf.trim());
	return operands;
}

/** An operand that is wholly a string OR template literal is safe to concatenate;
 * its interior `${...}` (if any) is already gated by the INTERPOLATION pass. */
function isStringOrTemplateLiteral(operand) {
	const s = operand.trim();
	if (s.length < 2) return false;
	const q = s[0];
	if (q !== '"' && q !== "'" && q !== "`") return false;
	// Confirm the literal spans the whole operand (no trailing `.foo` / `[i]`).
	let inStr = q;
	let escaped = false;
	let tmplDepth = 0;
	for (let k = 1; k < s.length; k++) {
		const ch = s[k];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (inStr === "`" && ch === "$" && s[k + 1] === "{") {
			tmplDepth++;
			continue;
		}
		if (inStr === "`" && ch === "}" && tmplDepth > 0) {
			tmplDepth--;
			continue;
		}
		if (ch === inStr && tmplDepth === 0) {
			// Closing quote — safe only if it is the LAST char of the operand.
			return k === s.length - 1;
		}
	}
	return false;
}

/**
 * Classify a single concatenation operand as SAFE or a BYPASS. An operand is
 * SAFE when it is a string/template literal, a number / prebuilt fragment, a
 * helper call, or rooted in a safe-bound identifier. Anything else — a bare
 * `userId`, a `req.body.x`, a `someFn(raw)` — concatenated into SQL is a raw
 * value interpolation and is flagged. Fails closed: an operand it cannot prove
 * safe is treated as a bypass.
 */
function concatOperandIsSafe(operand, safeBindings, safeMethods) {
	const s = operand.trim();
	if (s === "") return true;
	if (isStringOrTemplateLiteral(s)) return true;
	if (HELPER.test(s)) return true;
	if (NUMERIC_OR_PREBUILT.test(s)) return true;
	if (SAFE_BINDING_RHS.test(s)) return true;
	if (isSafeMethodCall(s, safeMethods)) return true;
	const root = s.match(/^[A-Za-z_]\w*/);
	if (root && safeBindings.has(root[0])) return true;
	return false;
}

function inspectFile(path) {
	const source = readFileSync(path, "utf-8");
	const lines = source.split("\n");
	const safeBindings = collectSafeBindings(lines);
	const safeMethods = collectSafeMethods(lines);
	const findings = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (NON_BUILDER_LINE.test(line)) continue;
		if (!STATEMENT_FINGERPRINT.test(line)) continue;
		if (!/["'`]/.test(line)) continue;
		INTERPOLATION.lastIndex = 0;
		let m;
		while ((m = INTERPOLATION.exec(line)) !== null) {
			const body = m[1].trim();
			if (body === "") continue;
			if (HELPER.test(body)) continue;
			if (NUMERIC_OR_PREBUILT.test(body)) continue;
			// A `this.tbl()`-style call to a same-file method that returns a safe
			// helper result is pre-escaped (data-flow through the method body).
			if (isSafeMethodCall(body, safeMethods)) continue;
			// The interpolation's root identifier — `tbl` from `tbl`, `scope` from
			// `scope.org`. Safe when it was bound from a known-safe builder.
			const root = body.match(/^[A-Za-z_]\w*/);
			if (root && safeBindings.has(root[0])) continue;
			findings.push({
				file: path,
				line: i + 1,
				evidence: line.trim(),
				body,
				kind: "interpolation",
			});
		}

		// String-concatenation bypass: `"...sql..." + rawValue + "..."`. Only a line
		// that actually concatenates (`+` present) is a candidate; the operand split
		// then ignores `+` inside strings/templates/calls, so a SQL string with a `+`
		// in its text is not mistaken for a concat. We require at least one operand to
		// be a SQL-string literal so a non-SQL arithmetic line on a fingerprinted row
		// is not swept in, and flag any operand that is a raw value.
		if (line.includes("+")) {
			// Strip a binding/return prefix so the split starts at the expression.
			const expr = line
				.replace(/^\s*(return\s+|(?:const|let|var)\s+[^=]+=\s*|[\w.[\]]+\s*=\s*)/, "")
				.replace(/[;,]\s*$/, "");
			const operands = splitTopLevelConcat(expr);
			if (operands.length >= 2) {
				const hasSqlLiteralOperand = operands.some(
					(op) => isStringOrTemplateLiteral(op) && STATEMENT_FINGERPRINT.test(op),
				);
				if (hasSqlLiteralOperand) {
					for (const op of operands) {
						if (concatOperandIsSafe(op, safeBindings, safeMethods)) continue;
						findings.push({
							file: path,
							line: i + 1,
							evidence: line.trim(),
							body: op,
							kind: "concat",
						});
					}
				}
			}
		}
	}
	return findings;
}

async function* walk(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "bundle") continue;
			yield* walk(p);
		} else if (
			entry.isFile() &&
			SCANNABLE_EXT.has(extname(entry.name).toLowerCase()) &&
			!entry.name.endsWith(".d.ts") &&
			!entry.name.endsWith(".test.ts") &&
			!EXEMPT_BASENAMES.has(basename(entry.name))
		) {
			yield p;
		}
	}
}

const findings = [];
let scanned = 0;
for await (const file of walk(SCAN_DIR)) {
	scanned++;
	findings.push(...inspectFile(file));
}

console.log(`\nSQL-safety audit: scanned ${scanned} file(s) under ${SCAN_DIR}/\n`);

if (findings.length === 0) {
	console.log("OK - every SQL interpolation routes through an escaping helper.\n");
	process.exit(0);
}

for (const f of findings) {
	const how = f.kind === "concat" ? "string-concatenation" : "raw interpolation";
	console.log(`x [BYPASS] ${how} of \`${f.body}\` into a SQL string`);
	console.log(`    ${f.file}:${f.line}`);
	console.log(`    > ${f.evidence}`);
	console.log(`    Fix: wrap the value in sqlStr/sqlLike/sqlIdent (or eLiteral/sLiteral for a body).`);
	console.log();
}

console.log(`Summary: ${findings.length} bypass(es) found.\n`);
process.exit(1);
