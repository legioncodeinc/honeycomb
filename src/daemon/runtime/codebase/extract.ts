/**
 * Per-file extraction — PRD-014a Wave 1 (a-AC-1 / a-AC-4 / FR-1..FR-3 / FR-7).
 *
 * `extractFile(sourceFile, content)` routes a file BY EXTENSION to the right
 * language {@link Extractor} and returns a uniform {@link FileExtraction} carrying
 * file/symbol nodes, call/import/heritage placeholder edges, tree-sitter parse
 * errors, and (for TS/JS) the cross-file inputs the 014b resolve pass consumes.
 *
 * ── Parser stack (D-1): web-tree-sitter (WASM), NOT native tree-sitter ───────
 * The framework owns the `web-tree-sitter` `Parser` + per-language `Language`
 * lifecycle: it `Parser.init()`s once, loads each grammar's prebuilt `.wasm` from
 * `tree-sitter-wasms/out/` LAZILY on first use, caches it, and hands an extractor a
 * ready {@link ParseHandle}. The extractors never touch `web-tree-sitter` — they walk
 * the minimal {@link SyntaxCursorNode} surface the framework adapts. WASM was chosen
 * over native bindings because it needs no native compile/postinstall and is
 * deterministic across the CI matrix (see `esbuild.config.mjs` + `ensure-tree-sitter.mjs`).
 *
 * ── The uniform framework (D-2) ─────────────────────────────────────────────
 * Every language emits the SAME shape: a `file` node + `symbol` nodes for each
 * declaration, `imports` edges (file → `external:<specifier>`), `calls` edges
 * (symbol → `external:<callee>`), and heritage edges (`extends`/`implements`/
 * `method_of`). The unresolved targets are `external:` placeholders the 014b resolve
 * pass repoints. TS/JS is the RICHEST — it additionally populates
 * {@link TsCrossFileInputs} (`importBindings` + `rawCalls`) so 014b can resolve calls
 * across files; the other eight emit nodes + edges + parse errors structurally.
 *
 * ── Malformed → skip, never abort (a-AC-4) ──────────────────────────────────
 * An extractor NEVER throws on a malformed file. The framework parses, and if the
 * tree `hasError` it records a {@link ParseError} and returns a FileExtraction whose
 * `parseErrors` is non-empty; the snapshot harness then SKIPS the file from the graph
 * but the BUILD CONTINUES. An unsupported extension routes to `null` (the caller
 * skips it); a grammar that fails to load is reported as a parse error, not a throw.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import {
	type Extractor,
	type FileExtraction,
	externalTarget,
	type GraphEdge,
	type GraphNode,
	type Language,
	type ParseError,
	type ParseHandle,
	type SyntaxCursorNode,
} from "./contracts.js";
import { tsJsExtractor } from "./extractors/ts-js.js";
import { structuralExtractors } from "./extractors/structural.js";

// ════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Extension routing (FR-1 / FR-6 / a-AC-3). `.d.ts` is NOT here: it is
// excluded at DISCOVERY (a-AC-3), so a `.d.ts` should never reach `extractFile`; the
// router also guards it defensively (returns null) so a stray one is skipped, not
// extracted.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Extension → language map (FR-1). The nine languages the PRD names. `.tsx`/`.jsx`
 * route to the TS/JS extractor (the framework picks the `tsx` grammar variant for
 * those). Frozen so the router and the tests read one map.
 */
export const EXTENSION_LANGUAGE = Object.freeze<Record<string, Language>>({
	".ts": "typescript",
	".tsx": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".py": "python",
	".pyi": "python",
	".go": "go",
	".rs": "rust",
	".java": "java",
	".rb": "ruby",
	".c": "c",
	".h": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hh": "cpp",
});

/** The grammar `.wasm` basename for a language (TS uses the `typescript` grammar; `.tsx` is handled per-file). */
const GRAMMAR_WASM = Object.freeze<Record<Language, string>>({
	typescript: "tree-sitter-typescript",
	javascript: "tree-sitter-javascript",
	python: "tree-sitter-python",
	go: "tree-sitter-go",
	rust: "tree-sitter-rust",
	java: "tree-sitter-java",
	ruby: "tree-sitter-ruby",
	c: "tree-sitter-c",
	cpp: "tree-sitter-cpp",
});

/**
 * Resolve a file's language by extension (lowercased), or `null` for an unsupported
 * file or a `.d.ts` declaration (which carries no implementation to extract — FR-6).
 * `.d.ts` / `.d.mts` / `.d.cts` are matched on the compound suffix before the simple
 * `.ts` lookup so a declaration file is never mis-routed to the TS extractor.
 */
export function languageForFile(sourceFile: string): Language | null {
	const lower = sourceFile.toLowerCase();
	if (lower.endsWith(".d.ts") || lower.endsWith(".d.mts") || lower.endsWith(".d.cts")) return null;
	const dot = lower.lastIndexOf(".");
	if (dot < 0) return null;
	const ext = lower.slice(dot);
	return EXTENSION_LANGUAGE[ext] ?? null;
}

/** True when a file routes to a `.tsx`/`.jsx` grammar variant (JSX syntax). */
function isTsxLike(sourceFile: string): boolean {
	const lower = sourceFile.toLowerCase();
	return lower.endsWith(".tsx") || lower.endsWith(".jsx");
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 2 — The extractor registry. One extractor per language. TS and JS share
// `tsJsExtractor` (registered under both keys); the other eight come from the
// structural factory.
// ════════════════════════════════════════════════════════════════════════════

const EXTRACTORS: Readonly<Record<Language, Extractor>> = Object.freeze({
	typescript: tsJsExtractor("typescript"),
	javascript: tsJsExtractor("javascript"),
	...structuralExtractors(),
} as Record<Language, Extractor>);

// ════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Grammar lifecycle (the framework owns web-tree-sitter). LAZY: a grammar
// is loaded on first use and cached. The `web-tree-sitter` module + grammar `.wasm`
// files resolve from node_modules at runtime (they are `external` in the bundle).
// ════════════════════════════════════════════════════════════════════════════

const require = createRequire(import.meta.url);

/** Resolve the `tree-sitter-wasms/out/` directory the grammar `.wasm` files live in. */
function grammarDir(): string {
	return require.resolve("tree-sitter-wasms/package.json").replace(/package\.json$/, "out/");
}

// web-tree-sitter is CJS (`export = Parser`); under esModuleInterop the default import
// is the Parser class. Loaded lazily so a unit test that never extracts pays nothing.
type WtsParser = {
	parse(content: string): { rootNode: WtsNode };
	setLanguage(lang: unknown): void;
};
type WtsModule = {
	init(): Promise<void>;
	Language: { load(path: string): Promise<unknown> };
	new (): WtsParser;
};
interface WtsNode {
	readonly type: string;
	readonly text: string;
	readonly startPosition: { row: number; column: number };
	readonly endPosition: { row: number; column: number };
	readonly hasError: boolean;
	readonly namedChildCount: number;
	namedChild(i: number): WtsNode | null;
	childForFieldName(field: string): WtsNode | null;
}

let parserModulePromise: Promise<WtsModule> | null = null;
async function parserModule(): Promise<WtsModule> {
	if (parserModulePromise === null) {
		parserModulePromise = (async () => {
			const mod = (await import("web-tree-sitter")) as unknown as { default?: WtsModule } & WtsModule;
			const Parser = (mod.default ?? mod) as WtsModule;
			await Parser.init();
			return Parser;
		})();
	}
	return parserModulePromise;
}

/** A cache key for a loaded grammar: the language, plus a `:tsx` suffix for the JSX variant. */
const grammarCache = new Map<string, Promise<unknown>>();

async function loadGrammar(language: Language, tsx: boolean): Promise<unknown> {
	const base = GRAMMAR_WASM[language];
	// The typescript grammar package ships BOTH `tree-sitter-typescript.wasm` and
	// `tree-sitter-tsx.wasm`; a `.tsx`/`.jsx` file uses the tsx variant so JSX parses.
	const wasm = language === "typescript" && tsx ? "tree-sitter-tsx" : base;
	const key = wasm;
	const cached = grammarCache.get(key);
	if (cached) return cached;
	const promise = (async () => {
		const Parser = await parserModule();
		return Parser.Language.load(`${grammarDir()}${wasm}.wasm`);
	})();
	grammarCache.set(key, promise);
	return promise;
}

/** Adapt a `web-tree-sitter` node to the minimal {@link SyntaxCursorNode} the extractors walk. */
function adapt(node: WtsNode): SyntaxCursorNode {
	return {
		type: node.type,
		text: node.text,
		startPosition: { row: node.startPosition.row, column: node.startPosition.column },
		endPosition: { row: node.endPosition.row, column: node.endPosition.column },
		hasError: node.hasError,
		namedChildCount: node.namedChildCount,
		namedChild: (i: number) => {
			const c = node.namedChild(i);
			return c ? adapt(c) : null;
		},
		childForFieldName: (field: string) => {
			const c = node.childForFieldName(field);
			return c ? adapt(c) : null;
		},
	};
}

/**
 * Build a {@link ParseHandle} for a language (the framework's parser seam). Loads the
 * grammar (lazily, cached), binds a parser, and returns a handle whose `parse`
 * produces the adapted root + the tree's `hasError`. Throws ONLY if the grammar
 * genuinely cannot be loaded (a missing `.wasm`); `extractFile` catches that and
 * reports it as a parse error rather than aborting.
 */
async function makeHandle(language: Language, tsx: boolean): Promise<ParseHandle> {
	const Parser = await parserModule();
	const grammar = await loadGrammar(language, tsx);
	const parser = new Parser();
	parser.setLanguage(grammar);
	return {
		language,
		parse(content: string) {
			const tree = parser.parse(content);
			const root = adapt(tree.rootNode);
			return { root, hasError: tree.rootNode.hasError };
		},
	};
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 4 — `extractFile`. The public entry. Routes, parses, extracts, applies the
// malformed-skip policy. ASYNC because grammar load is async; the snapshot harness
// awaits each.
// ════════════════════════════════════════════════════════════════════════════

/** sha256 of a string — the content-address cache key (a-AC-2 / FR-8). Exported so the cache + harness share it. */
export function contentSha256(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Extract one file (a-AC-1). Routes by extension; returns `null` for an unsupported
 * file or a `.d.ts` (the caller skips it). Parses with the language grammar and
 * delegates to the extractor. A malformed file (tree `hasError`, or a grammar that
 * fails to load) returns a FileExtraction with a populated `parseErrors` and is
 * SKIPPED by the harness — the build is never aborted (a-AC-4).
 *
 * `sha` is the precomputed content hash; when omitted it is computed here. Passing it
 * lets the cache/harness avoid double-hashing.
 */
export async function extractFile(
	sourceFile: string,
	content: string,
	sha?: string,
): Promise<FileExtraction | null> {
	const language = languageForFile(sourceFile);
	if (language === null) return null;
	const extractor = EXTRACTORS[language];
	const contentHash = sha ?? contentSha256(content);

	let handle: ParseHandle;
	try {
		handle = await makeHandle(language, isTsxLike(sourceFile));
	} catch (err) {
		// A grammar that cannot be loaded is a parse error for THIS file, never an
		// abort: emit a file node + the error so coverage is visible and the build runs.
		return grammarLoadFailure(sourceFile, language, contentHash, err);
	}

	try {
		return extractor.extract({ sourceFile, content, contentSha256: contentHash, handle });
	} catch (err) {
		// Defense in depth: an extractor MUST NOT throw, but if a grammar edge case slips
		// through we degrade to a reported parse error rather than aborting the build.
		return extractorFailure(sourceFile, language, contentHash, err);
	}
}

/** A FileExtraction representing a grammar that failed to load — a parse error, file skipped. */
function grammarLoadFailure(sourceFile: string, language: Language, sha: string, err: unknown): FileExtraction {
	return failureExtraction(
		sourceFile,
		language,
		sha,
		`tree-sitter grammar for ${language} failed to load: ${errMessage(err)}`,
	);
}

/** A FileExtraction representing an extractor that threw — a parse error, file skipped. */
function extractorFailure(sourceFile: string, language: Language, sha: string, err: unknown): FileExtraction {
	return failureExtraction(sourceFile, language, sha, `extractor for ${language} failed: ${errMessage(err)}`);
}

/** Shared shape for a failure FileExtraction: a lone file node + one parse error, no edges. */
function failureExtraction(sourceFile: string, language: Language, sha: string, message: string): FileExtraction {
	const fileNode: GraphNode = {
		id: sourceFile,
		kind: "file",
		name: baseName(sourceFile),
		sourceFile,
		language,
		observation: { startLine: 1, endLine: 1 },
	};
	const parseError: ParseError = { sourceFile, message };
	const edges: readonly GraphEdge[] = [];
	return { sourceFile, language, nodes: [fileNode], edges, parseErrors: [parseError], contentSha256: sha };
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The basename of a repo-relative path (forward-slash normalized). */
export function baseName(p: string): string {
	const norm = p.replace(/\\/g, "/");
	const i = norm.lastIndexOf("/");
	return i < 0 ? norm : norm.slice(i + 1);
}

// Re-export so producers (the cache, the harness, tests) reach the routing + the
// `external:` helper from one module.
export { externalTarget };
