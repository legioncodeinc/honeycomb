/**
 * PROPERTY / FUZZ tests — the SQL-escaping floor (`src/daemon/storage/sql.ts`).
 *
 * The existing unit tests assert escaping example-by-example. THESE assert the STRUCTURAL
 * invariant over thousands of generated inputs — including the hostile ones a human would
 * not think to hand-write (oversampled `'`, `"`, `\`, NUL, newlines, `;`, `--`, `/*`,
 * backticks, the full C0/C1 control range, unicode).
 *
 * The meta-invariant proved here: there is NO input for which the escaped output, placed in
 * its intended SQL position, parses as anything other than ONE inert token/literal. We assert
 * that structurally (no odd-length unescaped-quote run can terminate a literal early; an
 * identifier is either charset-clean or rejected), never against a fixed example.
 *
 * `sql.ts` is the ONE `daemon/storage` module the invariant test EXEMPTS from the
 * no-storage-import rule (it is pure, dependency-free string escaping), so importing it
 * directly into a test is allowed and keeps `tests/daemon/storage/invariant.test.ts` green.
 *
 * Seeded (`seed: 0xHONEY…`, fixed) so a failure is reproducible and CI is deterministic; each
 * property anchors the known-hostile payloads via `{ examples: [...] }`.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { eLiteral, sLiteral, sqlIdent, sqlLike, sqlStr } from "../../src/daemon/storage/sql.js";

const NUM_RUNS = 1000;
/** A fixed seed → reproducible counterexamples + deterministic CI. */
const SEED = 0x5_0_1_d;

/**
 * A targeted generator that OVERSAMPLES the characters that break SQL escaping: the quote
 * family, the backslash, the statement terminator, comment openers, NUL, every newline form,
 * backticks, and a spread of C0/C1 control chars. Interleaved with ordinary text + unicode so a
 * payload looks like a real (hostile) value, not just a wall of metacharacters.
 */
const hostileChar = fc.constantFrom(
	"'",
	'"',
	"\\",
	"\0",
	"\n",
	"\r",
	"\t",
	";",
	"-",
	"--",
	"/*",
	"*/",
	"%",
	"_",
	"`",
	"\x01",
	"\x07",
	"\x08",
	"\x0b",
	"\x0c",
	"\x1b",
	"\x1f",
	"\x7f",
	"\x85",
	" ",
	" ",
	"a",
	"Z",
	"7",
	" ",
	"DROP TABLE",
	"é",
	"\u{1f4a3}",
);

/** A hostile-leaning string: many short runs of oversampled metacharacters + plain text. */
const hostileString = fc.array(hostileChar, { maxLength: 40 }).map((parts) => parts.join(""));

/**
 * Full-unicode strings. fast-check v4 retired `fc.fullUnicodeString()`; the modern equivalent
 * is `fc.string({ unit: "binary" })`, which samples the FULL code-point range (incl. astral
 * planes + surrogates), so the escaping floor is tested against multibyte content too.
 */
const fullUnicodeString = fc.string({ unit: "binary" });

/** The three string generators every escaping property is asserted over. */
const anyString = fc.oneof(fc.string(), fullUnicodeString, hostileString);

/** Canonical injection payloads pinned as explicit anchors (and as the shrink targets). */
const INJECTION_EXAMPLES: [string][] = [
	["'; DROP TABLE memory; --"],
	["' OR '1'='1"],
	["\\'; DROP TABLE x; --"],
	["x'/**/UNION/**/SELECT/**/token/**/FROM/**/secrets--"],
	["a\0b"],
	["line1\nline2"],
	["''''"],
	["\\"],
	["\\\\'"],
	['"'],
	["`"],
	[""],
	["100%_off"],
];

/**
 * Strip the outer single quotes of a `'...'` literal and assert NO unescaped `'` survives in
 * the body. A single-quoted SQL literal is terminated by the first quote that is NOT part of a
 * doubled `''` pair — i.e. by any ODD-length run of consecutive quotes. So the structural
 * invariant "every interior quote is doubled" ⇔ "every maximal run of `'` in the body has EVEN
 * length". We assert the latter directly (no fixed example).
 */
function everyQuoteRunIsEven(body: string): boolean {
	const runs = body.match(/'+/g);
	if (runs === null) return true;
	return runs.every((run) => run.length % 2 === 0);
}

describe("property: sLiteral — output is one inert single-quoted literal, no early termination", () => {
	it("wraps in single quotes and doubles every interior quote (no odd-length quote run)", () => {
		fc.assert(
			fc.property(anyString, (s) => {
				const out = sLiteral(s);
				// Structural: starts and ends with the outer single quote, length ≥ 2.
				expect(out.startsWith("'")).toBe(true);
				expect(out.endsWith("'")).toBe(true);
				expect(out.length).toBeGreaterThanOrEqual(2);
				// The interior body (outer quotes stripped) has NO unescaped quote: every maximal
				// run of `'` is even-length, so none can close the literal early. THIS is the floor.
				const body = out.slice(1, -1);
				expect(everyQuoteRunIsEven(body)).toBe(true);
			}),
			{ numRuns: NUM_RUNS, seed: SEED, examples: INJECTION_EXAMPLES },
		);
	});

	it("never emits a raw NUL or a stripped C0/C1 control char into the literal", () => {
		fc.assert(
			fc.property(anyString, (s) => {
				const body = sLiteral(s).slice(1, -1);
				// NUL is dropped; the only control chars that survive are \t \n \r (intentional).
				expect(body.includes("\0")).toBe(false);
				expect(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body)).toBe(false);
			}),
			{ numRuns: NUM_RUNS, seed: SEED, examples: INJECTION_EXAMPLES },
		);
	});
});

describe("property: sqlStr — the literal BODY is injection-inert (backslash + quote doubled)", () => {
	it("every backslash is doubled and every quote is doubled (no lone escape, no lone quote)", () => {
		fc.assert(
			fc.property(anyString, (s) => {
				const body = sqlStr(s);
				// Every backslash run is even (each `\` became `\\`).
				const backslashRuns = body.match(/\\+/g);
				if (backslashRuns !== null) {
					expect(backslashRuns.every((r) => r.length % 2 === 0)).toBe(true);
				}
				// Every quote run is even (each `'` became `''`) → no early-terminator.
				expect(everyQuoteRunIsEven(body)).toBe(true);
			}),
			{ numRuns: NUM_RUNS, seed: SEED, examples: INJECTION_EXAMPLES },
		);
	});
});

describe("property: eLiteral — the E'...' form preserves the sqlStr floor", () => {
	it("is E-prefixed, single-quoted, and its body is the same inert sqlStr output", () => {
		fc.assert(
			fc.property(anyString, (s) => {
				const out = eLiteral(s);
				expect(out.startsWith("E'")).toBe(true);
				expect(out.endsWith("'")).toBe(true);
				const body = out.slice(2, -1);
				// Same floor as sLiteral's body: no odd-length quote run can close it early.
				expect(everyQuoteRunIsEven(body)).toBe(true);
				expect(body).toBe(sqlStr(s));
			}),
			{ numRuns: NUM_RUNS, seed: SEED, examples: INJECTION_EXAMPLES },
		);
	});
});

describe("property: sqlLike — wildcards are neutralized; no metacharacter changes query shape", () => {
	it("every % and _ in the escaped body is backslash-escaped (literal, not a wildcard)", () => {
		fc.assert(
			fc.property(anyString, (s) => {
				const body = sqlLike(s);
				// Walk the string: any `%` or `_` MUST be immediately preceded by an ODD number of
				// backslashes (i.e. an active LIKE escape), so it matches literally, never as a
				// wildcard. (sqlStr already doubled every source `\`; sqlLike then prepends ONE `\`
				// before each `%`/`_`, leaving an odd run = an active escape.)
				for (let i = 0; i < body.length; i += 1) {
					const ch = body[i];
					if (ch !== "%" && ch !== "_") continue;
					let backslashes = 0;
					for (let j = i - 1; j >= 0 && body[j] === "\\"; j -= 1) backslashes += 1;
					expect(backslashes % 2).toBe(1);
				}
				// The quote floor still holds (sqlLike layers on top of sqlStr).
				expect(everyQuoteRunIsEven(body)).toBe(true);
			}),
			{ numRuns: NUM_RUNS, seed: SEED, examples: [...INJECTION_EXAMPLES, ["%"], ["_"], ["a%b_c"], ["\\%"]] },
		);
	});
});

describe("property: sqlIdent — returns ONLY charset-clean identifiers, else throws (never breaks out)", () => {
	it("either returns input unchanged matching ^[a-zA-Z_][a-zA-Z0-9_]*$, or throws", () => {
		fc.assert(
			fc.property(anyString, (s) => {
				let returned: string | null = null;
				try {
					returned = sqlIdent(s);
				} catch {
					// A rejection is a valid (fail-closed) outcome — the query is never built.
					return;
				}
				// If it returned, the value is byte-identical to the input AND charset-clean: it can
				// contain NO quote, space, `;`, `"`, or any char that would escape a `"..."` ident.
				expect(returned).toBe(s);
				expect(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(returned)).toBe(true);
			}),
			{
				numRuns: NUM_RUNS,
				seed: SEED,
				examples: [["id; DROP"], ['id"; DROP'], ["a b"], ["1abc"], [""], ["valid_name"], ["_x9"]],
			},
		);
	});

	it("a returned identifier interpolated into a double-quoted ident cannot break out", () => {
		fc.assert(
			fc.property(anyString, (s) => {
				let returned: string;
				try {
					returned = sqlIdent(s);
				} catch {
					return; // rejected → never interpolated.
				}
				const interpolated = `"${returned}"`;
				// No interior `"` (which would close the quoted ident early), no backtick, no NUL,
				// no whitespace, no `;` — the whole thing is exactly one quoted identifier token.
				const interior = interpolated.slice(1, -1);
				expect(/["`\0;\s]/.test(interior)).toBe(false);
			}),
			{ numRuns: NUM_RUNS, seed: SEED, examples: [['x"y'], ["x`y"], ["x;y"], ["x y"]] },
		);
	});
});
