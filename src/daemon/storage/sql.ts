/**
 * SQL-safety escaping helpers (PRD-002b — the security floor for the whole
 * data layer).
 *
 * The DeepLake HTTP query endpoint binds NO parameters: every value is escaped
 * and interpolated into the statement by hand before it is sent. There is no
 * parameterized fallback to forget to use, so these helpers ARE the parameter
 * binding. Correctness here is non-negotiable — a single un-escaped value is an
 * injection and a 500.
 *
 * One module, one source of truth (FR-6). Every query builder in 002c (healing),
 * 002d (write patterns), 002e (vector search), and the PRD-003 catalog routes
 * interpolated values through `sqlStr` / `sqlLike` / `sqlIdent`, and bodies that
 * carry escape sequences through the `E'...'` convention (`eLiteral`). The
 * `scripts/audit-sql-safety.mjs` CI gate proves no builder hand-interpolates a
 * value around these helpers (FR-7 / b-AC-7).
 *
 * These functions are pure, synchronous, side-effect-free, and dependency-free
 * beyond the language runtime.
 */

/**
 * Escape a string for use inside a single-quoted SQL literal (FR-1 / b-AC-1).
 *
 * Order matters: backslashes are doubled FIRST (so the backslash we add for a
 * doubled quote is not itself re-escaped), then single quotes are doubled, then
 * NUL and the C0/C1 control characters are dropped. The result is the inner body
 * of the literal — the caller wraps it in quotes (`'${sqlStr(v)}'`) or uses the
 * `E'...'` form via {@link eLiteral} when the body carries escape sequences.
 *
 * Because every quote is doubled and every backslash is doubled, an injection
 * payload like `'; DROP TABLE x; --` collapses to one inert literal: the
 * embedded quote can never close the string early, so no second statement is
 * ever produced (b-AC-5).
 *
 * Handles empty strings, already-quoted input, multibyte/Unicode content, and
 * embedded newlines without producing a malformed literal (FR-8). A literal
 * newline (`\n`, 0x0A) and tab (0x09) and carriage return (0x0D) are PRESERVED —
 * only the non-printable control characters that have no business in a literal
 * are stripped.
 */
export function sqlStr(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/'/g, "''")
		.replace(/\0/g, "")
		// Drop C0 controls except \t (0x09) \n (0x0A) \r (0x0D), plus DEL (0x7f).
		.replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/**
 * Escape a string for use inside a `LIKE` / `ILIKE` pattern (FR-2 / b-AC-3).
 *
 * Escapes the `LIKE` metacharacters (`%` and `_`) so a literal substring search
 * is never reinterpreted as a wildcard match. The escape character is the
 * backslash, which is DeepLake/Postgres's `LIKE` default, so no explicit `ESCAPE`
 * clause is required at the call site.
 *
 * The escaping is COMPLETE and LOCAL: the first pass escapes the backslash itself
 * ALONGSIDE the `%` and `_` it introduces, in one `replace` over the raw input
 * (`/[\\%_]/g` -> `\$&`). Escaping the escape character in the same pass is what
 * makes this a recognized full sanitizer. A backslash in the input becomes `\\`
 * (one literal backslash after `LIKE` un-escapes), and every `%`/`_` gets exactly
 * one escape backslash in front. There is no order dependence on another helper:
 * the wildcard-and-escape layer stands on its own.
 *
 * The remaining passes are the literal layer (the same quote-doubling and control
 * stripping {@link sqlStr} performs, minus the backslash-doubling already done
 * above so the metacharacter escapes are never re-escaped): single quotes are
 * doubled, NUL is dropped, and the C0/C1 control chars are stripped. The output
 * is byte-for-byte identical to layering `%`/`_` escaping on top of `sqlStr`,
 * because both compose the same per-character substitutions over disjoint
 * character classes.
 */
export function sqlLike(value: string): string {
	return value
		.replace(/[\\%_]/g, "\\$&")
		.replace(/'/g, "''")
		.replace(/\0/g, "")
		// Drop C0 controls except \t (0x09) \n (0x0A) \r (0x0D), plus DEL (0x7f).
		.replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/**
 * Validate a table/column identifier against `^[a-zA-Z_][a-zA-Z0-9_]*$`
 * (FR-3 / b-AC-2). Returns the name UNCHANGED on success; throws
 * `Invalid SQL identifier: <json>` on anything else.
 *
 * Strict by design: it THROWS rather than sanitizing, because a silently
 * rewritten identifier would be a worse, harder-to-debug failure than a rejected
 * one. Callers pass only known schema names (table and column identifiers from
 * the ColumnDef catalog), so a rejection is always a programmer error worth
 * surfacing. A crafted name like `id; DROP` throws here and the query is never
 * built (b-AC-6).
 */
export function sqlIdent(name: string): string {
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
		throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`);
	}
	return name;
}

/**
 * Build an `E'...'` escape-string literal from a raw text body (FR-4 / b-AC-4).
 *
 * Text bodies that may contain escape sequences — message content with `\n`,
 * skill bodies, rule text — must use the `E'...'` form so the doubled-backslash
 * escaping from {@link sqlStr} round-trips to the intended bytes. A plain
 * `'...'` literal for a body with backslashes would corrupt it, because the
 * backslash-doubling that protects against injection only un-doubles correctly
 * under `E'...'` semantics.
 *
 * This is the single canonical place the `E'...'` convention lives, so a writer
 * never hand-assembles `` `E'${sqlStr(body)}'` `` (which the audit gate would
 * otherwise have to special-case). The body is always passed through `sqlStr`
 * first, so the same injection floor applies.
 */
export function eLiteral(body: string): string {
	return `E'${sqlStr(body)}'`;
}

/**
 * Build an ordinary single-quoted literal from a value. Thin convenience around
 * `'${sqlStr(v)}'` so call sites read as a builder call rather than raw quote
 * assembly — and so the audit gate sees a helper, not a hand-quoted value.
 * Use {@link eLiteral} instead when the body may carry escape sequences.
 */
export function sLiteral(value: string): string {
	return `'${sqlStr(value)}'`;
}

/**
 * Validate a `SELECT` column list and return it unchanged (FR-3 / FR-5). The
 * single safe way to interpolate a caller-supplied projection: a reader that
 * lets the caller pick columns must NOT hand-interpolate the raw string into
 * `SELECT ${list}` — that is a direct injection sink the `E'...'`/identifier
 * helpers don't cover.
 *
 * Accepts the wildcard `*` (the default projection) or a comma-separated list of
 * bare identifiers, each validated through {@link sqlIdent}. Anything else — a
 * function call, a subquery, a `;`, a `(` — throws `Invalid SQL identifier`, so
 * a crafted projection like `id, (SELECT token FROM secrets)` can never be
 * built. Whitespace around each item is tolerated; the list is re-joined from
 * the validated names so no stray text survives.
 */
export function sqlColumnList(list: string): string {
	const trimmed = list.trim();
	if (trimmed === "*") return "*";
	return trimmed
		.split(",")
		.map((part) => sqlIdent(part.trim()))
		.join(", ");
}
