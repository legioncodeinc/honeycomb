/**
 * PRD-058c — the conservative code-reference EXTRACTOR (the `refs(m)` step of the `σ(m,t)` term).
 *
 * Pulls candidate code references out of a memory's content so the stale-ref diagnostic
 * (`stale-ref-diagnostic.ts`) can resolve each against the codebase-graph snapshot. This module
 * does ONE thing: turn free text into a deduplicated, ordered list of {@link CodeReference}
 * candidates. It does NOT resolve, classify, or score — that is the diagnostic's job.
 *
 * ── Why conservative, and why over-matching is SAFE (the asymmetry) ──────────────────────────
 *   The matcher errs toward MATCHING (a token that LOOKS like code). That is safe BY
 *   CONSTRUCTION because of how the diagnostic scores the output:
 *     - a candidate the graph does NOT know (outside the indexed set) → `unknown` (NEUTRAL,
 *       contributes nothing to `σ`), never `stale`.
 *     - only a candidate that LOOKS like indexed code AND is absent from the snapshot → `stale`.
 *   So the failure mode of an aggressive matcher is "more `unknown`", never "more false `stale`".
 *   The one thing we MUST NOT do is let prose that merely MENTIONS a common English word match
 *   an indexed symbol — that would manufacture false staleness. The matcher therefore requires a
 *   structural signal (a path separator, a `#`, a dotted/`::` qualifier, an extension, a flag
 *   prefix, or a non-trivial camel/snake shape) before it emits a bare-identifier candidate.
 *
 * ── The four reference shapes (PRD-058c Technical Considerations) ─────────────────────────────
 *   1. PATH-LIKE       a repo-relative source path, e.g. `src/daemon/storage/heal.ts`. The
 *                      strongest signal: a slash plus a known source extension (or a `src/`-rooted
 *                      path). The `kind` is `path`.
 *   2. FILE#SYMBOL     a path (or bare module) plus a `#symbol` selector, e.g.
 *                      `src/foo/bar.ts#doThing`. Split into `{ file, symbol }`; `kind` is `file-symbol`.
 *   3. QUALIFIED       a dotted or `::`-qualified symbol name, e.g. `Svc.run` or `mod::fn`. `kind`
 *                      is `qualified`. The LAST segment is the symbol; the prefix is the container.
 *   4. FLAG            an env/flag identifier, e.g. `HONEYCOMB_PIPELINE_ENABLED` or
 *                      `memory.lifecycle.halfLifeDaysByClass`. SCREAMING_SNAKE or a dotted lower
 *                      config path. `kind` is `flag`.
 *
 * Pure + total: no I/O, no clock, no throw. A blank or reference-free memory yields `[]`.
 */

/** The structural shape a {@link CodeReference} was recognized as (drives how the diagnostic resolves it). */
export type ReferenceKind = "path" | "file-symbol" | "qualified" | "flag";

/** One extracted candidate reference. `raw` is the exact matched token (recorded verbatim in `stale_refs`). */
export interface CodeReference {
	/** The exact token as it appeared in the memory text (what `stale_refs` records). */
	readonly raw: string;
	/** Which structural shape recognized it. */
	readonly kind: ReferenceKind;
	/** The path portion (kinds `path` / `file-symbol`); `undefined` for a bare symbol/flag. */
	readonly file?: string;
	/** The symbol portion (kinds `file-symbol` / `qualified`); `undefined` for a bare path/flag. */
	readonly symbol?: string;
}

/** Source-file extensions the matcher treats as a strong "this is indexed code" signal (the nine graph languages). */
const SOURCE_EXTENSIONS = Object.freeze([
	"ts",
	"tsx",
	"mts",
	"cts",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"py",
	"go",
	"rs",
	"java",
	"rb",
	"c",
	"h",
	"cc",
	"cpp",
	"cxx",
	"hpp",
]);

/** A regex alternation of the source extensions (for the path/extension test). */
const EXT_ALTERNATION = SOURCE_EXTENSIONS.join("|");

/**
 * A path-like token: a `/`-separated path ending in a known source extension, optionally with a
 * `#symbol` selector. Anchored on a path character class so a bare sentence cannot match. The
 * leading boundary is a non-path char (or string start). Backslashes are NOT path separators here
 * (the graph stores forward-slash repo-relative paths).
 */
const PATH_RE = new RegExp(
	String.raw`(?:^|[\s"'` + "`" + String.raw`(\[<])([A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+\.(?:${EXT_ALTERNATION}))(#[A-Za-z_$][A-Za-z0-9_$]*)?`,
	"g",
);

/**
 * A bare `module#symbol` (no extension, no slash needed) — e.g. `heal#withHeal`. The `#` is the
 * load-bearing structural signal. The left side is a single path/module token, the right a symbol.
 */
const MODULE_SYMBOL_RE = /(?:^|[\s"'`(\[<])([A-Za-z0-9_.\-/]+)#([A-Za-z_$][A-Za-z0-9_$]*)\b/g;

/**
 * A SCREAMING_SNAKE flag/env identifier (≥ 2 segments so a lone ALLCAPS word like `TODO` or `NOTE`
 * is NOT a flag). e.g. `HONEYCOMB_PIPELINE_ENABLED`, `HIVEMIND_SEMANTIC_SEARCH`.
 */
const SCREAMING_FLAG_RE = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;

/**
 * A dotted lower-case config path (≥ 3 segments so a two-word `a.b` sentence fragment does not
 * match — config keys are deep, e.g. `memory.lifecycle.halfLifeDaysByClass`). The segments are
 * identifier-shaped, so `e.g.` / `i.e.` (which have empty/again-dotted trailers) cannot match.
 */
const DOTTED_CONFIG_RE = /\b([a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*){2,})\b/g;

/**
 * A `::`-qualified symbol — e.g. `mod::fn`, `std::vector`. Two identifier segments joined by `::`.
 * The `::` is the structural signal (Rust/C++ path), so a bare word never matches.
 */
const COLON_QUALIFIED_RE = /\b([A-Za-z_$][A-Za-z0-9_$]*(?:::[A-Za-z_$][A-Za-z0-9_$]*)+)\b/g;

/**
 * A dotted MEMBER reference with at least one upper-case (class-like) container segment — e.g.
 * `Svc.run`, `EmbedClient.embed`. Requires an upper-cased head so a lower.lower sentence fragment
 * (already excluded by {@link DOTTED_CONFIG_RE}'s 3-segment rule) is not double-matched; this
 * catches the common 2-segment `Class.method` case the config rule deliberately skips.
 */
const MEMBER_QUALIFIED_RE = /\b([A-Z][A-Za-z0-9_$]*\.[a-z_$][A-Za-z0-9_$]*)\b/g;

/** Strip the leading boundary character a capture group may have swallowed (the regexes use a non-capturing prefix, so none here — kept for symmetry/clarity). */
function cleanToken(token: string): string {
	return token.trim();
}

/** Append a candidate, de-duplicating on the `raw` token (first occurrence wins; order preserved). */
function pushUnique(out: CodeReference[], seen: Set<string>, ref: CodeReference): void {
	if (ref.raw === "" || seen.has(ref.raw)) return;
	seen.add(ref.raw);
	out.push(ref);
}

/** The last segment of a dotted/`::`-qualified name is the symbol; the prefix is the container path. */
function splitQualified(token: string): { file?: string; symbol: string } {
	const sep = token.includes("::") ? "::" : ".";
	const idx = token.lastIndexOf(sep);
	if (idx < 0) return { symbol: token };
	return { file: token.slice(0, idx), symbol: token.slice(idx + sep.length) };
}

/**
 * Extract the conservative candidate references from a memory's content (PRD-058c). Runs each
 * shape matcher in PRECEDENCE order (path / file#symbol strongest, then flags, then qualified
 * symbols) and de-duplicates on the raw token so a path that also matched a weaker rule is kept
 * once under its strongest classification. RULES:
 *  - Over-matching is safe (the diagnostic scores an out-of-graph candidate as `unknown`).
 *  - A bare common English word NEVER matches: every emitted candidate carries a structural
 *    signal (a `/` + extension, a `#`, a `::`, a ≥3-segment dotted path, a `Class.member` shape,
 *    or a ≥2-segment SCREAMING_SNAKE flag).
 *  - Pure + total: empty/whitespace input → `[]`; never throws.
 */
export function extractReferences(content: string): CodeReference[] {
	const out: CodeReference[] = [];
	const seen = new Set<string>();
	if (typeof content !== "string" || content.trim() === "") return out;

	// 1. Path-like (optionally with #symbol). Strongest signal: a slash + source extension.
	for (const m of content.matchAll(PATH_RE)) {
		const path = cleanToken(m[1] ?? "");
		const sym = m[2] === undefined ? undefined : m[2].slice(1); // drop the leading '#'
		if (sym !== undefined && sym !== "") {
			pushUnique(out, seen, { raw: `${path}#${sym}`, kind: "file-symbol", file: path, symbol: sym });
		} else {
			pushUnique(out, seen, { raw: path, kind: "path", file: path });
		}
	}

	// 2. Bare module#symbol (no extension needed — the `#` is the signal).
	for (const m of content.matchAll(MODULE_SYMBOL_RE)) {
		const file = cleanToken(m[1] ?? "");
		const symbol = cleanToken(m[2] ?? "");
		if (file !== "" && symbol !== "") {
			pushUnique(out, seen, { raw: `${file}#${symbol}`, kind: "file-symbol", file, symbol });
		}
	}

	// 3. SCREAMING_SNAKE flags / env identifiers (≥ 2 segments).
	for (const m of content.matchAll(SCREAMING_FLAG_RE)) {
		const flag = cleanToken(m[1] ?? "");
		pushUnique(out, seen, { raw: flag, kind: "flag", symbol: flag });
	}

	// 4. Dotted lower config paths (≥ 3 segments).
	for (const m of content.matchAll(DOTTED_CONFIG_RE)) {
		const flag = cleanToken(m[1] ?? "");
		pushUnique(out, seen, { raw: flag, kind: "flag", symbol: flag });
	}

	// 5. `::`-qualified symbols.
	for (const m of content.matchAll(COLON_QUALIFIED_RE)) {
		const token = cleanToken(m[1] ?? "");
		const { file, symbol } = splitQualified(token);
		pushUnique(out, seen, { raw: token, kind: "qualified", file, symbol });
	}

	// 6. `Class.member` qualified members (the 2-segment case the config rule skips).
	for (const m of content.matchAll(MEMBER_QUALIFIED_RE)) {
		const token = cleanToken(m[1] ?? "");
		const { file, symbol } = splitQualified(token);
		pushUnique(out, seen, { raw: token, kind: "qualified", file, symbol });
	}

	return out;
}
