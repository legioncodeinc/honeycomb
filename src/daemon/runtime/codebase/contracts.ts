/**
 * Codebase-graph contracts — PRD-014 Wave 1 (the typed shapes every extractor +
 * the cache + the snapshot harness + the three Wave-2 sub-PRDs all code against).
 *
 * These are THE most load-bearing Wave-1 artifact. 014b (resolution + snapshot),
 * 014c (push/pull), and 014d (query surface) each consume the SAME
 * {@link FileExtraction} / {@link GraphNode} / {@link GraphEdge} / {@link Snapshot}
 * shapes through the SAME {@link Extractor} seam — so the contract must be right and
 * stable before any of them lands.
 *
 * ── The thesis these contracts encode ───────────────────────────────────────
 *   1. AST-ONLY. Every node/edge comes from a tree-sitter parse of the file on
 *      disk — never an LSP, a type checker, or an LLM. A symbol we cannot see in
 *      the syntax tree does not exist in the graph.
 *   2. DETERMINISM by field discipline (D-6). Every field is tagged STABLE or
 *      VOLATILE. STABLE fields are hashed into `snapshot_sha256` (014b); VOLATILE
 *      fields (the `observation` block, and `Node.observation`) are EXCLUDED. So
 *      identical source content on two worktrees → identical hash → one stored row.
 *      Any NEW field MUST be classified, and a volatile one MUST live under an
 *      `observation` key or dedup silently breaks.
 *   3. HIGH-CONFIDENCE edges only (014b). A per-file extraction emits placeholder
 *      edges whose unresolved targets are `external:<specifier>`; the Wave-2 resolve
 *      pass repoints only the ones it can prove, and DROPS the ambiguous rest.
 *
 * ── The NetworkX node-link mirror ───────────────────────────────────────────
 * {@link Snapshot} mirrors NetworkX's node-link JSON (`networkx.node_link_data`):
 * a directed multigraph serialized as `{ directed, multigraph, graph, nodes, links }`
 * where each link carries `source` / `target` id references. Any NetworkX-aware tool
 * can load the snapshot directly. The per-edge field is `source`/`target` in the
 * SERIALIZED link (the node-link convention), built from {@link GraphEdge}'s
 * `src`/`dst` during `buildSnapshot` (014b).
 *
 * ── Boundary vs interior (where zod lives) ──────────────────────────────────
 * These are plain TS interfaces, NOT zod schemas: an extractor BUILDS them from an
 * already-parsed syntax tree (trusted interior), so a runtime re-validation would be
 * ceremony. The rule mirrors `sources/contracts.ts`, `ontology/contracts.ts`, and
 * `pipeline/contracts.ts`: zod guards the UNTRUSTED boundary (a build request), the
 * interior shapes a producer constructs are interfaces.
 *
 * Nothing here imports tree-sitter or the storage layer — the contract is the seam
 * both sides depend on, so it stays dependency-light and circular-free.
 */

// ════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Languages (D-2). The nine the PRD names. The extractor framework is
// uniform across all nine; TS/JS is the richest (it additionally populates the
// cross-file inputs the 014b resolve pass consumes).
// ════════════════════════════════════════════════════════════════════════════

/**
 * The nine supported languages (D-2 / FR-1). Frozen so the extension router, the
 * grammar loader, and the tests all read ONE list. `typescript` covers `.ts`/`.tsx`
 * (the `.tsx` grammar is a variant the router selects on extension); the other eight
 * map 1:1 to a grammar.
 */
export const LANGUAGES = Object.freeze([
	"typescript",
	"javascript",
	"python",
	"go",
	"rust",
	"java",
	"ruby",
	"c",
	"cpp",
] as const);

/** One of the nine supported languages. */
export type Language = (typeof LANGUAGES)[number];

/** True when `value` is one of the nine supported languages. */
export function isLanguage(value: string): value is Language {
	return (LANGUAGES as readonly string[]).includes(value);
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Nodes. A graph node is a FILE or a SYMBOL. Field discipline (D-6):
// every field is tagged [STABLE] (hashed) or [VOLATILE] (excluded). The VOLATILE
// detail lives under one `observation` key so the hash exclusion is a single,
// auditable boundary, not a field-by-field judgement call in 014b.
// ════════════════════════════════════════════════════════════════════════════

/** The kinds of graph node a per-file extraction produces. */
export const NODE_KINDS = Object.freeze(["file", "symbol"] as const);
/** A graph node kind. */
export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * The kind of symbol a `symbol` node represents (the tree-sitter named-node class it
 * was extracted from). Free-form-ish but drawn from this common set so renderers and
 * resolution can branch on it. `module` is the synthetic node an `import` edge points
 * at when its specifier resolves to a repo file (014b repoints `external:` → a real
 * `module` node).
 */
export const SYMBOL_KINDS = Object.freeze([
	"function",
	"method",
	"class",
	"interface",
	"struct",
	"enum",
	"type",
	"variable",
	"constant",
	"module",
] as const);
/** A symbol kind. */
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

/**
 * The VOLATILE per-node observation block (D-6 / 014b-AC-2). EXCLUDED from
 * `computeSnapshotSha256`. Everything that can differ between two byte-identical
 * checkouts of the same content — line numbers shift when an unrelated edit moves a
 * symbol, the degree counts are computed post-resolution from the whole edge set —
 * lives here so it never perturbs the content hash. A renderer (014d) reads these;
 * the hash does not.
 *
 * - `startLine` / `endLine`  the symbol's span (1-based, inclusive). VOLATILE: a
 *                            line number is a position, not content identity.
 * - `fanIn` / `fanOut`       cross-file in/out degree, set by `annotateNodeDegrees`
 *                            (014b-AC-5). Derived, post-resolution → VOLATILE.
 * - `isEntrypoint`           `exported && fanIn === 0` (014b-AC-5). Derived → VOLATILE.
 */
export interface NodeObservation {
	/** [VOLATILE] 1-based start line of the symbol's span. */
	readonly startLine: number;
	/** [VOLATILE] 1-based end line of the symbol's span. */
	readonly endLine: number;
	/** [VOLATILE] cross-file in-degree (014b `annotateNodeDegrees`). */
	readonly fanIn?: number;
	/** [VOLATILE] cross-file out-degree (014b `annotateNodeDegrees`). */
	readonly fanOut?: number;
	/** [VOLATILE] `exported && fanIn === 0` (014b `annotateNodeDegrees`). */
	readonly isEntrypoint?: boolean;
}

/**
 * A graph node — a file or a symbol (D-2 / a-AC-1). The STABLE fields are the node's
 * content identity (hashed); the one VOLATILE field is `observation` (excluded).
 *
 * - `id`           [STABLE] the node's stable identity. For a `file` node it is the
 *                  `source_file`; for a `symbol` node it is `<source_file>#<name>`
 *                  (optionally `:<ord>` to disambiguate overloads). DETERMINISTIC —
 *                  derived only from STABLE inputs, never from a line number.
 * - `kind`         [STABLE] `file` | `symbol`.
 * - `name`         [STABLE] the symbol name (the file's basename for a file node).
 * - `sourceFile`   [STABLE] the repo-relative path the node was extracted from. On a
 *                  cache hit after a rename, the cache REWRITES this to the current
 *                  path (a-AC-2) so a reused entry never leaks the original path.
 * - `language`     [STABLE] the file's {@link Language}.
 * - `symbolKind`   [STABLE] the {@link SymbolKind} (absent on a file node).
 * - `exported`     [STABLE] whether the symbol is exported/public — drives
 *                  `isEntrypoint` and cross-file resolvability (014b).
 * - `observation`  [VOLATILE] the {@link NodeObservation} block — EXCLUDED from the
 *                  hash (D-6). The single place volatile per-node data lives.
 */
export interface GraphNode {
	/** [STABLE] stable node identity (`source_file` or `source_file#name`). */
	readonly id: string;
	/** [STABLE] node kind. */
	readonly kind: NodeKind;
	/** [STABLE] symbol name (file basename for a file node). */
	readonly name: string;
	/** [STABLE] repo-relative source path (rewritten on a rename cache hit). */
	readonly sourceFile: string;
	/** [STABLE] the file's language. */
	readonly language: Language;
	/** [STABLE] the symbol kind (absent on a file node). */
	readonly symbolKind?: SymbolKind;
	/** [STABLE] whether the symbol is exported/public. */
	readonly exported?: boolean;
	/** [VOLATILE] excluded-from-hash observation block (D-6). */
	readonly observation: NodeObservation;
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Edges. call / import / heritage. A per-file edge is a PLACEHOLDER:
// its `dst` is `external:<specifier>` until 014b's resolve pass repoints the ones it
// can prove. The `id` is PREFIXED by `source_file` so a rename rewrite (a-AC-2) and a
// per-file re-extraction touch only that file's edges.
// ════════════════════════════════════════════════════════════════════════════

/**
 * The relation an edge expresses (014b FR-7). `imports` is a file→module edge;
 * `calls` is a symbol→symbol invocation; `extends`/`implements`/`method_of` are the
 * heritage/ownership relations. Frozen so the extractor, the resolve pass, and the
 * renderers read one set.
 */
export const EDGE_RELATIONS = Object.freeze([
	"imports",
	"calls",
	"extends",
	"implements",
	"method_of",
] as const);
/** An edge relation. */
export type EdgeRelation = (typeof EDGE_RELATIONS)[number];

/**
 * Edge confidence (014b FR-7). A per-file extraction emits `EXTRACTED` placeholders;
 * the resolve pass keeps `EXTRACTED` for proven edges and may mark the residual as
 * `AMBIGUOUS` (which 014b DROPS rather than stores). `INFERRED` is reserved for a
 * future cross-file inference the PRD's open question debates — Wave 1 never emits it.
 */
export const EDGE_CONFIDENCE = Object.freeze(["EXTRACTED", "INFERRED", "AMBIGUOUS"] as const);
/** An edge confidence level. */
export type EdgeConfidence = (typeof EDGE_CONFIDENCE)[number];

/** The sentinel prefix on an unresolved edge target (a bare/unresolvable specifier). */
export const EXTERNAL_PREFIX = "external:" as const;

/** Build an unresolved `external:<specifier>` target. */
export function externalTarget(specifier: string): string {
	return `${EXTERNAL_PREFIX}${specifier}`;
}

/** True when an edge target is still an unresolved `external:` placeholder. */
export function isExternalTarget(dst: string): boolean {
	return dst.startsWith(EXTERNAL_PREFIX);
}

/**
 * A graph edge (call / import / heritage). Every field is STABLE — an edge has no
 * volatile observation; its identity and endpoints ARE content. The 014b resolve
 * pass repoints `dst` for the edges it proves; an unresolved `dst` keeps its
 * `external:` target (a-AC / 014b-AC-4).
 *
 * - `id`         [STABLE] the edge identity, PREFIXED by `sourceFile` (a-AC-2): e.g.
 *                `<source_file>::calls::<src>-><dst>[:ord]`. The prefix scopes the
 *                edge to its file so a rename rewrite touches only that file's edges
 *                and a per-file re-extraction replaces exactly its own.
 * - `relation`   [STABLE] {@link EdgeRelation}.
 * - `src`        [STABLE] the source node id (a symbol id, or a file id for `imports`).
 * - `dst`        [STABLE] the target node id. An UNRESOLVED target is
 *                `external:<specifier>` (014b repoints the provable ones).
 * - `confidence` [STABLE] {@link EdgeConfidence} — `EXTRACTED` from a per-file pass.
 * - `ord`        [STABLE] disambiguates multigraph edges that share src+dst+relation
 *                (014b FR-7) — e.g. two calls to the same target. Optional.
 * - `specifier`  [STABLE] for an `imports`/`calls` edge, the raw import specifier or
 *                binding name the resolve pass matches against (`./x`, `bar`,
 *                `ns.foo`). Carried so 014b need not re-parse. Optional.
 */
export interface GraphEdge {
	/** [STABLE] edge identity, prefixed by `sourceFile` (a-AC-2). */
	readonly id: string;
	/** [STABLE] the relation. */
	readonly relation: EdgeRelation;
	/** [STABLE] source node id. */
	readonly src: string;
	/** [STABLE] target node id; `external:<specifier>` when unresolved. */
	readonly dst: string;
	/** [STABLE] confidence; `EXTRACTED` from a per-file pass. */
	readonly confidence: EdgeConfidence;
	/** [STABLE] multigraph disambiguator (optional). */
	readonly ord?: number;
	/** [STABLE] the raw specifier/binding the resolve pass matches (optional). */
	readonly specifier?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Parse errors + the TS cross-file inputs. A malformed file reports its
// parse errors and is SKIPPED (a-AC-4); it never aborts the build. The TS extractor
// additionally emits `rawCalls` + `importBindings` for the 014b resolve pass.
// ════════════════════════════════════════════════════════════════════════════

/**
 * A tree-sitter parse error on a file (a-AC-4). When `FileExtraction.parseErrors` is
 * non-empty the file is reported and SKIPPED from the graph (its nodes/edges are not
 * trusted), but the BUILD CONTINUES — one malformed file never aborts the run.
 *
 * - `sourceFile`  the file the error is on.
 * - `message`     a human-readable summary (e.g. "tree-sitter reported ERROR nodes").
 * - `line`        a 1-based line where an `ERROR`/`MISSING` node sits (best-effort).
 */
export interface ParseError {
	/** The repo-relative file the error is on. */
	readonly sourceFile: string;
	/** Human-readable summary. */
	readonly message: string;
	/** 1-based line of the first ERROR/MISSING node (best-effort). */
	readonly line?: number;
}

/**
 * An import binding the TS/JS extractor records for the 014b resolve pass (FR-3).
 * Each is tagged `named` (incl. `as` alias), `default`, or `namespace`, with a
 * `typeOnly` flag (an `import type` / `import { type X }`). 014b uses ONLY `named`
 * and `namespace` bindings to emit high-confidence edges; `default` is deliberately
 * skipped (014b-AC-3 / FR-2). Carried as a cross-file input so the resolve pass does
 * not re-parse the file.
 *
 * - `local`      the local binding name in this file (`bar`, the alias, the `ns`).
 * - `imported`   the name in the source module (`bar`; absent for namespace/default).
 * - `kind`       `named` | `default` | `namespace`.
 * - `specifier`  the module specifier (`./x`, `lodash`).
 * - `typeOnly`   an `import type` binding (no runtime edge value).
 */
export interface ImportBinding {
	/** The local binding name in this file. */
	readonly local: string;
	/** The name in the source module (absent for namespace/default). */
	readonly imported?: string;
	/** `named` | `default` | `namespace`. */
	readonly kind: "named" | "default" | "namespace";
	/** The module specifier. */
	readonly specifier: string;
	/** An `import type` binding (type-position only). */
	readonly typeOnly: boolean;
}

/**
 * An unresolved-in-file call site the TS/JS extractor records for the 014b resolve
 * pass (FR-3). A `raw_call` names the callee binding (and, for a member call, the
 * object) so 014b can match it against {@link ImportBinding}s + the global export
 * index. A `ns.foo()` call carries `object: "ns"`, `callee: "foo"`; a bare `foo()`
 * carries `callee: "foo"`, `object` absent.
 *
 * - `fromSymbolId`  the id of the symbol node the call is INSIDE (the edge `src`).
 * - `callee`        the called name (`foo`).
 * - `object`        the receiver for a member call (`ns` in `ns.foo()`); absent for a
 *                   bare call.
 */
export interface RawCall {
	/** The enclosing symbol node id (the resolved edge's `src`). */
	readonly fromSymbolId: string;
	/** The called name. */
	readonly callee: string;
	/** The receiver object for a member call (absent for a bare call). */
	readonly object?: string;
}

/**
 * The TS/JS cross-file inputs the 014b resolve pass consumes (FR-3). Present ONLY on
 * a TypeScript/JavaScript extraction; the other eight languages leave it `undefined`
 * (their per-file edges are resolved structurally without these). This is the richest
 * part of the contract — the seam that makes TS/JS the "full" extractor.
 */
export interface TsCrossFileInputs {
	/** Imports tagged named/default/namespace, each with a `typeOnly` flag. */
	readonly importBindings: readonly ImportBinding[];
	/** Unresolved-in-file call sites for the resolve pass to match. */
	readonly rawCalls: readonly RawCall[];
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 5 — FileExtraction. The ONE shape every extractor returns (a-AC-1). The
// snapshot harness aggregates these; the cache stores and (on a rename) rewrites
// them; 014b resolves across them.
// ════════════════════════════════════════════════════════════════════════════

/**
 * The uniform per-file extraction every language produces (a-AC-1 / FR-2). The
 * extension router (`extractFile`) returns exactly this for any supported file.
 *
 * - `sourceFile`        the repo-relative path extracted.
 * - `language`          the file's {@link Language}.
 * - `nodes`             the file node + every symbol node found.
 * - `edges`             the per-file call/import/heritage PLACEHOLDER edges (their
 *                       unresolved `dst`s are `external:` until 014b repoints them).
 * - `parseErrors`       tree-sitter parse errors; non-empty ⇒ the file is SKIPPED but
 *                       the build is NOT aborted (a-AC-4).
 * - `tsCrossFileInputs` the TS/JS-only {@link TsCrossFileInputs} (FR-3). `undefined`
 *                       for the other eight languages.
 * - `contentSha256`     the sha256 of the file content this extraction came from —
 *                       the cache KEY (a-AC-2 / FR-8). Lets the harness and the cache
 *                       confirm a reuse without re-hashing.
 */
export interface FileExtraction {
	/** The repo-relative path extracted. */
	readonly sourceFile: string;
	/** The file's language. */
	readonly language: Language;
	/** The file node + symbol nodes. */
	readonly nodes: readonly GraphNode[];
	/** The per-file placeholder edges. */
	readonly edges: readonly GraphEdge[];
	/** tree-sitter parse errors (non-empty ⇒ file skipped, build continues). */
	readonly parseErrors: readonly ParseError[];
	/** TS/JS cross-file inputs for the 014b resolve pass (undefined elsewhere). */
	readonly tsCrossFileInputs?: TsCrossFileInputs;
	/** The sha256 of the file content (the cache key). */
	readonly contentSha256: string;
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 6 — The Extractor seam (per language). One `Extractor` per language; the
// router picks by extension. Each `extract` is PURE: (sourceFile, content, lang,
// langGrammar) → FileExtraction. No I/O, no global state — the grammar is injected so
// the framework owns parser lifecycle and the extractor owns only tree-walking.
// ════════════════════════════════════════════════════════════════════════════

/**
 * A loaded tree-sitter parser bound to a language grammar. The framework
 * (`extract.ts`) owns the `web-tree-sitter` `Parser` + `Language` lifecycle and hands
 * an extractor a ready `ParseHandle`; the extractor never touches `web-tree-sitter`
 * directly. Kept as an opaque-ish handle here so the contract does not import
 * `web-tree-sitter` (the seam stays dependency-light). `parse(content)` returns the
 * tree root as a minimal walkable node (see {@link SyntaxCursorNode}).
 */
export interface ParseHandle {
	/** The language this handle parses. */
	readonly language: Language;
	/** Parse source into a tree; returns the root node + whether it has errors. */
	parse(content: string): { readonly root: SyntaxCursorNode; readonly hasError: boolean };
}

/**
 * The minimal syntax-node surface an extractor walks — the subset of the
 * `web-tree-sitter` `SyntaxNode` API the extractors actually use, re-declared here so
 * the contract does not depend on `web-tree-sitter`'s types. The framework adapts the
 * real node to this shape. (Field names mirror the tree-sitter API exactly.)
 */
export interface SyntaxCursorNode {
	/** The node's grammar type (e.g. `function_declaration`). */
	readonly type: string;
	/** The node's source text. */
	readonly text: string;
	/** The 1-based-on-read start position (`row` is 0-based in tree-sitter). */
	readonly startPosition: { readonly row: number; readonly column: number };
	/** The end position. */
	readonly endPosition: { readonly row: number; readonly column: number };
	/** Whether this node or a descendant is an ERROR/MISSING node. */
	readonly hasError: boolean;
	/** Named child count. */
	readonly namedChildCount: number;
	/** The i-th named child, or null. */
	namedChild(index: number): SyntaxCursorNode | null;
	/** The child bound to a grammar field (e.g. `name`, `source`), or null. */
	childForFieldName(field: string): SyntaxCursorNode | null;
}

/**
 * The per-language extractor seam (D-2). One implementation per language; each emits
 * file/symbol nodes + call/import/heritage edges + parse errors via the uniform
 * framework. The TS/JS extractor additionally fills `tsCrossFileInputs`. An extractor
 * is PURE and stateless: it receives a ready {@link ParseHandle} and the file's
 * identity, and returns a {@link FileExtraction}. The framework owns grammar loading,
 * extension routing, hashing, and the malformed-file skip policy.
 *
 * A Wave-2 language addition (beyond the nine) implements exactly this.
 */
export interface Extractor {
	/** The language this extractor handles. */
	readonly language: Language;
	/**
	 * Extract one file. `contentSha256` is the precomputed content hash (the cache
	 * key) the framework passes through onto the {@link FileExtraction}. A parse with
	 * errors MUST still return — with `parseErrors` populated and the (untrusted)
	 * partial nodes/edges it managed to read — so the framework applies the skip
	 * policy; the extractor never throws on a malformed file (a-AC-4).
	 */
	extract(args: {
		readonly sourceFile: string;
		readonly content: string;
		readonly contentSha256: string;
		readonly handle: ParseHandle;
	}): FileExtraction;
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 7 — The Snapshot (NetworkX node-link JSON). Aggregated by the Wave-1
// harness (nodes/links) with a VOLATILE `observation` block; finalized by 014b
// (sort + canonicalize + degrees + hash + atomic write). The hash EXCLUDES
// `observation` (D-6 / 014b-AC-2).
// ════════════════════════════════════════════════════════════════════════════

/**
 * A serialized node-link entry — a {@link GraphEdge} rendered into NetworkX's
 * `{ source, target, ... }` link convention (014b `buildSnapshot`). `source`/`target`
 * are node ids; the rest mirror the edge's STABLE fields. All STABLE (hashed).
 */
export interface SnapshotLink {
	/** [STABLE] source node id (NetworkX node-link `source`). */
	readonly source: string;
	/** [STABLE] target node id (NetworkX node-link `target`). */
	readonly target: string;
	/** [STABLE] the relation. */
	readonly relation: EdgeRelation;
	/** [STABLE] confidence. */
	readonly confidence: EdgeConfidence;
	/** [STABLE] the edge id (carries the `sourceFile` prefix). */
	readonly id: string;
	/** [STABLE] multigraph disambiguator (optional). */
	readonly ord?: number;
}

/**
 * The VOLATILE snapshot-level observation block (D-6 / 014b-AC-2 / 014b-FR-9).
 * EXCLUDED from `computeSnapshotSha256`. Holds everything that differs between two
 * byte-identical-content builds: when it was built, on what branch/worktree, by what
 * generator version, and the file/node/edge counts. Any NEW volatile snapshot field
 * MUST go here or dedup breaks (two identical-content builds would hash differently).
 */
export interface SnapshotObservation {
	/** [VOLATILE] ISO-8601 build time. */
	readonly generatedAt: string;
	/** [VOLATILE] the branch HEAD pointed at, if known. */
	readonly branch?: string;
	/** [VOLATILE] the absolute worktree path the build ran in. */
	readonly worktreePath?: string;
	/** [VOLATILE] the generator/schema version that built this snapshot. */
	readonly generatorVersion: string;
	/** [VOLATILE] file count discovered. */
	readonly fileCount: number;
	/** [VOLATILE] node count. */
	readonly nodeCount: number;
	/** [VOLATILE] edge (link) count. */
	readonly edgeCount: number;
	/** [VOLATILE] parse errors encountered across all files (skipped-file count). */
	readonly parseErrorCount: number;
}

/**
 * The codebase-graph snapshot — NetworkX node-link JSON (D-6). A directed multigraph.
 * The Wave-1 harness produces the `nodes` + `links` aggregate with a VOLATILE
 * `observation`; 014b sorts, canonicalizes, annotates degrees, computes the STABLE
 * hash (EXCLUDING `observation`), and writes it atomically.
 *
 * STABLE (hashed): `directed`, `multigraph`, `graph`, `nodes`, `links`.
 * VOLATILE (excluded): `observation`.
 *
 * - `directed`     [STABLE] always `true` (a code graph is directed).
 * - `multigraph`   [STABLE] always `true` (two calls a→b are two edges).
 * - `graph`        [STABLE] graph-level attributes (the NetworkX `graph` dict). The
 *                  identity tuple lives here so it is part of content identity for a
 *                  given repo/commit; kept minimal + sorted by 014b's canonicalizer.
 * - `nodes`        [STABLE] the node list (each node's OWN `observation` is the
 *                  per-node volatile block, excluded at hash time field-wise by 014b).
 * - `links`        [STABLE] the node-link edge list.
 * - `observation`  [VOLATILE] the {@link SnapshotObservation} — EXCLUDED from the hash.
 */
export interface Snapshot {
	/** [STABLE] directed graph. */
	readonly directed: true;
	/** [STABLE] multigraph. */
	readonly multigraph: true;
	/** [STABLE] graph-level attributes (NetworkX `graph` dict). */
	readonly graph: Readonly<Record<string, string>>;
	/** [STABLE] the node list. */
	readonly nodes: readonly GraphNode[];
	/** [STABLE] the node-link edge list. */
	readonly links: readonly SnapshotLink[];
	/** [VOLATILE] excluded-from-hash observation block (D-6). */
	readonly observation: SnapshotObservation;
}

/**
 * The identity tuple a snapshot is stored under (D-7 / the `codebase` table key). A
 * build for a `(org, workspace, repo, user, worktree, commit)` is one row; push uses
 * SELECT-before-INSERT drift detection on it (014c). Maps onto the existing
 * `codebase` table columns (PRD-003d `catalog/product.ts`): `org`→`org_id`,
 * `workspace`→`workspace_id`, `repo`→`repo_slug`, `user`→`user_id`,
 * `worktree`→`worktree_id`, `commit`→`commit_sha`. The 014c push performs that mapping.
 */
export interface SnapshotIdentity {
	readonly org: string;
	readonly workspace: string;
	readonly repo: string;
	readonly user: string;
	readonly worktree: string;
	readonly commit: string;
}
