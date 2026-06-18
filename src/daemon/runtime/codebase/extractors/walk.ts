/**
 * Shared tree-walking primitives for the per-language extractors (PRD-014a Wave 1).
 *
 * Every extractor builds the SAME {@link FileExtraction} shape; these helpers are the
 * common machinery: the file node, deterministic node/edge id construction (STABLE,
 * line-free — D-6), a depth-first named-child walk, and the parse-error builder for
 * the malformed-skip policy (a-AC-4). The id helpers are the load-bearing determinism
 * guarantee — they derive ids ONLY from STABLE inputs (paths + names + ords), NEVER
 * from a line number, so two byte-identical files anywhere produce identical ids.
 */

import {
	type EdgeRelation,
	type GraphEdge,
	type GraphNode,
	type Language,
	type ParseError,
	type SymbolKind,
	type SyntaxCursorNode,
} from "../contracts.js";

/**
 * Build a deterministic ord allocator: the FIRST occurrence of a name returns
 * `undefined` (no ord suffix), each later occurrence returns the next integer (1, 2, …)
 * so same-named symbols in one file disambiguate deterministically (`m`, `m:1`, …).
 * Shared by every extractor so the id scheme is identical across languages.
 */
export function makeOrdAllocator(): (name: string) => number | undefined {
	const seq = new Map<string, number>();
	return (name: string): number | undefined => {
		const seen = seq.get(name);
		if (seen === undefined) {
			seq.set(name, 0);
			return undefined;
		}
		const next = seen + 1;
		seq.set(name, next);
		return next;
	};
}

/** Strip surrounding quotes (`'`/`"`/backtick) from a string-literal node's text. */
export function stripQuotes(text: string): string {
	const t = text.trim();
	if (t.length >= 2 && (t[0] === '"' || t[0] === "'" || t[0] === "`")) {
		return t.slice(1, -1);
	}
	return t;
}

/** The basename of a forward-slash-normalized repo-relative path. */
export function baseName(sourceFile: string): string {
	const norm = sourceFile.replace(/\\/g, "/");
	const i = norm.lastIndexOf("/");
	return i < 0 ? norm : norm.slice(i + 1);
}

/**
 * The file node id is the `source_file` itself (STABLE). The single coarsest node;
 * every symbol id and edge id is prefixed by it so a rename rewrite (a-AC-2) is a
 * pure string substitution over this prefix.
 */
export function fileNodeId(sourceFile: string): string {
	return sourceFile;
}

/**
 * A symbol node id: `<source_file>#<name>` (STABLE, line-free — D-6). An optional
 * `ord` disambiguates same-named symbols in one file (overloads, two methods named
 * `m` on different classes) as `<source_file>#<name>:<ord>`. NEVER includes a line
 * number, so moving an unrelated symbol does not change this id.
 */
export function symbolNodeId(sourceFile: string, name: string, ord?: number): string {
	const base = `${sourceFile}#${name}`;
	return ord === undefined ? base : `${base}:${ord}`;
}

/**
 * An edge id, PREFIXED by `source_file` (a-AC-2). Shape:
 * `<source_file>::<relation>::<src>-><dst>[:ord]`. The prefix scopes the edge to its
 * file so (a) a rename rewrite repoints only that file's edges and (b) a per-file
 * re-extraction replaces exactly its own edges. STABLE — `src`/`dst`/`relation`/`ord`
 * are all content, never positions.
 */
export function edgeId(sourceFile: string, relation: EdgeRelation, src: string, dst: string, ord?: number): string {
	const base = `${sourceFile}::${relation}::${src}->${dst}`;
	return ord === undefined ? base : `${base}:${ord}`;
}

/** Build the file node for a source file (STABLE id + a minimal observation span). */
export function makeFileNode(sourceFile: string, language: Language, endLine: number): GraphNode {
	return {
		id: fileNodeId(sourceFile),
		kind: "file",
		name: baseName(sourceFile),
		sourceFile,
		language,
		observation: { startLine: 1, endLine: Math.max(1, endLine) },
	};
}

/**
 * Build a symbol node. The line span goes into the VOLATILE `observation` (excluded
 * from the hash); the STABLE identity is `id`/`name`/`kind`/`exported`.
 */
export function makeSymbolNode(args: {
	readonly sourceFile: string;
	readonly language: Language;
	readonly name: string;
	readonly symbolKind: SymbolKind;
	readonly node: SyntaxCursorNode;
	readonly exported?: boolean;
	readonly ord?: number;
}): GraphNode {
	return {
		id: symbolNodeId(args.sourceFile, args.name, args.ord),
		kind: "symbol",
		name: args.name,
		sourceFile: args.sourceFile,
		language: args.language,
		symbolKind: args.symbolKind,
		exported: args.exported ?? false,
		observation: {
			// tree-sitter rows are 0-based; the contract's span is 1-based.
			startLine: args.node.startPosition.row + 1,
			endLine: args.node.endPosition.row + 1,
		},
	};
}

/** Build a placeholder edge (its `dst` is typically an `external:` target until 014b). */
export function makeEdge(args: {
	readonly sourceFile: string;
	readonly relation: EdgeRelation;
	readonly src: string;
	readonly dst: string;
	readonly ord?: number;
	readonly specifier?: string;
}): GraphEdge {
	return {
		id: edgeId(args.sourceFile, args.relation, args.src, args.dst, args.ord),
		relation: args.relation,
		src: args.src,
		dst: args.dst,
		confidence: "EXTRACTED",
		ord: args.ord,
		specifier: args.specifier,
	};
}

/**
 * Depth-first walk over the NAMED children of a node, invoking `visit` on each
 * descendant (pre-order). `visit` returns `false` to PRUNE the subtree (do not
 * descend) — used so an extractor that handled a `function_declaration` does not also
 * re-handle its nested nodes as top-level symbols when it wants only the outer one.
 * Returning `true`/`undefined` descends.
 */
export function walkNamed(node: SyntaxCursorNode, visit: (n: SyntaxCursorNode) => boolean | void): void {
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (child === null) continue;
		const descend = visit(child);
		if (descend !== false) walkNamed(child, visit);
	}
}

/** Find the first descendant (pre-order, including `node`) whose type is in `types`. */
export function firstOfType(node: SyntaxCursorNode, types: ReadonlySet<string>): SyntaxCursorNode | null {
	if (types.has(node.type)) return node;
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (child === null) continue;
		const found = firstOfType(child, types);
		if (found) return found;
	}
	return null;
}

/** Collect every descendant (pre-order, including `node`) whose type is in `types`. */
export function collectOfType(node: SyntaxCursorNode, types: ReadonlySet<string>): SyntaxCursorNode[] {
	const out: SyntaxCursorNode[] = [];
	(function rec(n: SyntaxCursorNode): void {
		if (types.has(n.type)) out.push(n);
		for (let i = 0; i < n.namedChildCount; i++) {
			const c = n.namedChild(i);
			if (c !== null) rec(c);
		}
	})(node);
	return out;
}

/** The text of a node's named field child, or `undefined`. */
export function fieldText(node: SyntaxCursorNode, field: string): string | undefined {
	return node.childForFieldName(field)?.text;
}

/**
 * Build the standard parse-error result for a malformed file (a-AC-4): a single file
 * node and one {@link ParseError}, no symbols/edges trusted. The extractor returns
 * this when the tree `hasError`; the harness skips the file but the build continues.
 */
export function parseErrorResult(
	sourceFile: string,
	language: Language,
	contentSha256: string,
	root: SyntaxCursorNode,
): {
	readonly nodes: readonly GraphNode[];
	readonly edges: readonly GraphEdge[];
	readonly parseErrors: readonly ParseError[];
	readonly contentSha256: string;
	readonly language: Language;
	readonly sourceFile: string;
} {
	const error: ParseError = {
		sourceFile,
		message: "tree-sitter reported ERROR/MISSING nodes — file skipped from the graph",
		line: root.startPosition.row + 1,
	};
	return {
		sourceFile,
		language,
		nodes: [makeFileNode(sourceFile, language, root.endPosition.row + 1)],
		edges: [],
		parseErrors: [error],
		contentSha256,
	};
}
