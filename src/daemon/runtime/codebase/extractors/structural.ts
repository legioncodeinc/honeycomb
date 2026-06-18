/**
 * Structural extractors for the seven non-TS/JS languages — PRD-014a Wave 1
 * (Python, Go, Rust, Java, Ruby, C, C++). Each emits the SAME {@link FileExtraction}
 * shape as the TS/JS extractor via the uniform framework: a `file` node + `symbol`
 * nodes for declarations, `imports` edges (file → `external:<specifier>`), `calls`
 * edges (symbol → `external:<callee>`), and heritage edges (`extends`/`implements`).
 * They do NOT populate `tsCrossFileInputs` (that is the TS/JS richness, FR-3); their
 * per-file edges are resolved structurally by 014b without the binding index.
 *
 * Depth here is "lighter but real, not a stub": each language is driven by a
 * {@link LanguageSpec} grounded in its real tree-sitter grammar (node types + field
 * names verified against the prebuilt WASM grammars). The spec names the symbol
 * declaration node types (+ how to read each one's name), the call node type, the
 * import node types (+ how to read the specifier), and the heritage shape. The shared
 * driver walks the tree once and emits nodes/edges; a malformed file returns a lone
 * file node + a ParseError (a-AC-4) — never a throw, never an abort.
 *
 * The grammars diverge enough that a few node types need a small custom name reader
 * (Go's `type_spec`, C's nested `function_declarator`); those live in the spec as a
 * `nameOf` function rather than a field name.
 */

import {
	type Extractor,
	type FileExtraction,
	externalTarget,
	type GraphEdge,
	type GraphNode,
	type Language,
	type SymbolKind,
	type SyntaxCursorNode,
} from "../contracts.js";
import {
	collectOfType,
	fieldText,
	firstOfType,
	makeEdge,
	makeFileNode,
	makeOrdAllocator,
	makeSymbolNode,
	parseErrorResult,
	stripQuotes,
	symbolNodeId,
} from "./walk.js";

// ── Spec types ───────────────────────────────────────────────────────────────

/** How to read a declaration's name + the symbol kind it yields. */
interface DeclSpec {
	/** The symbol kind this declaration node produces. */
	readonly kind: SymbolKind;
	/** Read the declaration's name from the node (field-based or custom). */
	readonly nameOf: (node: SyntaxCursorNode) => string | undefined;
	/**
	 * Heritage base-type node types to emit `extends` edges to (read from the node's
	 * fields/descendants). Empty for languages/decls with no heritage. The relation is
	 * `extends` for a single-inheritance base and `implements` for an interface list.
	 */
	readonly heritage?: readonly HeritageSpec[];
}

/** A heritage edge spec: where the base type(s) live and the relation to emit. */
interface HeritageSpec {
	/** The field or descendant node-type the base type list hangs off. */
	readonly from: string;
	/** Whether `from` is a grammar FIELD name or a descendant NODE type. */
	readonly via: "field" | "descendant";
	/** The node types that ARE base-type references (read their text). */
	readonly baseTypes: readonly string[];
	/** The relation to emit. */
	readonly relation: "extends" | "implements";
}

/** A full language extraction spec. */
interface LanguageSpec {
	readonly language: Language;
	/** Declaration node type → how to extract it. */
	readonly decls: Readonly<Record<string, DeclSpec>>;
	/** The call-expression node type(s). */
	readonly callTypes: readonly string[];
	/** Import node types → how to read the specifier from each. */
	readonly imports: readonly ImportSpec[];
}

/** How to read an import specifier from an import node. */
interface ImportSpec {
	/** The import node type. */
	readonly type: string;
	/** Read the raw specifier (module path / package) from the node. */
	readonly specifierOf: (node: SyntaxCursorNode) => string | undefined;
}

// ── Shared name readers ──────────────────────────────────────────────────────

const byField = (field: string) => (node: SyntaxCursorNode): string | undefined => fieldText(node, field);

/** C/C++: the function name is nested in a `function_declarator`'s `declarator`. */
function cFunctionName(node: SyntaxCursorNode): string | undefined {
	const declarator = firstOfType(node, new Set(["function_declarator"]));
	if (declarator === null) return undefined;
	const id = firstOfType(declarator, new Set(["identifier", "field_identifier"]));
	return id?.text;
}

/** Go: `type_declaration` → `type_spec`.`name`. */
function goTypeName(node: SyntaxCursorNode): string | undefined {
	const spec = firstOfType(node, new Set(["type_spec"]));
	return spec ? fieldText(spec, "name") : undefined;
}

/** Read an import specifier from a string-bearing import (Go/Python/etc.): first string descendant. */
function stringSpecifier(node: SyntaxCursorNode): string | undefined {
	const str = firstOfType(node, new Set(["interpreted_string_literal", "string", "string_literal"]));
	if (str) return stripQuotes(str.text);
	// Fallback: a dotted/scoped name (python `import os`, rust `use a::b`).
	const name = firstOfType(node, new Set(["dotted_name", "scoped_identifier", "identifier"]));
	return name?.text;
}

// ── The seven specs (grammar-grounded) ───────────────────────────────────────

const SPECS: readonly LanguageSpec[] = [
	{
		language: "python",
		decls: {
			function_definition: { kind: "function", nameOf: byField("name") },
			class_definition: {
				kind: "class",
				nameOf: byField("name"),
				heritage: [{ from: "superclasses", via: "field", baseTypes: ["identifier"], relation: "extends" }],
			},
		},
		callTypes: ["call"],
		imports: [
			{ type: "import_statement", specifierOf: stringSpecifier },
			{ type: "import_from_statement", specifierOf: (n) => fieldText(n, "module_name") ?? stringSpecifier(n) },
		],
	},
	{
		language: "go",
		decls: {
			function_declaration: { kind: "function", nameOf: byField("name") },
			method_declaration: { kind: "method", nameOf: byField("name") },
			type_declaration: { kind: "struct", nameOf: goTypeName },
		},
		callTypes: ["call_expression"],
		imports: [{ type: "import_declaration", specifierOf: stringSpecifier }],
	},
	{
		language: "rust",
		decls: {
			function_item: { kind: "function", nameOf: byField("name") },
			struct_item: { kind: "struct", nameOf: byField("name") },
			enum_item: { kind: "enum", nameOf: byField("name") },
			trait_item: { kind: "interface", nameOf: byField("name") },
			impl_item: {
				kind: "type",
				nameOf: (n) => fieldText(n, "type"),
				heritage: [{ from: "trait", via: "field", baseTypes: ["type_identifier"], relation: "implements" }],
			},
		},
		callTypes: ["call_expression"],
		imports: [{ type: "use_declaration", specifierOf: (n) => fieldText(n, "argument") ?? stringSpecifier(n) }],
	},
	{
		language: "java",
		decls: {
			class_declaration: {
				kind: "class",
				nameOf: byField("name"),
				heritage: [
					{ from: "superclass", via: "field", baseTypes: ["type_identifier"], relation: "extends" },
					{ from: "interfaces", via: "field", baseTypes: ["type_identifier"], relation: "implements" },
				],
			},
			interface_declaration: { kind: "interface", nameOf: byField("name") },
			method_declaration: { kind: "method", nameOf: byField("name") },
			enum_declaration: { kind: "enum", nameOf: byField("name") },
		},
		callTypes: ["method_invocation"],
		imports: [{ type: "import_declaration", specifierOf: (n) => scopedText(n) }],
	},
	{
		language: "ruby",
		decls: {
			method: { kind: "method", nameOf: byField("name") },
			class: {
				kind: "class",
				nameOf: byField("name"),
				heritage: [{ from: "superclass", via: "field", baseTypes: ["constant"], relation: "extends" }],
			},
			module: { kind: "module", nameOf: byField("name") },
		},
		callTypes: ["call"],
		imports: [],
	},
	{
		language: "c",
		decls: {
			function_definition: { kind: "function", nameOf: cFunctionName },
			struct_specifier: { kind: "struct", nameOf: byField("name") },
		},
		callTypes: ["call_expression"],
		imports: [{ type: "preproc_include", specifierOf: includeSpecifier }],
	},
	{
		language: "cpp",
		decls: {
			function_definition: { kind: "function", nameOf: cFunctionName },
			class_specifier: {
				kind: "class",
				nameOf: byField("name"),
				heritage: [
					{ from: "base_class_clause", via: "descendant", baseTypes: ["type_identifier"], relation: "extends" },
				],
			},
			struct_specifier: { kind: "struct", nameOf: byField("name") },
			namespace_definition: { kind: "module", nameOf: byField("name") },
		},
		callTypes: ["call_expression"],
		imports: [{ type: "preproc_include", specifierOf: includeSpecifier }],
	},
];

// ── The shared driver ────────────────────────────────────────────────────────

/** Build all seven structural extractors keyed by language. */
export function structuralExtractors(): Readonly<Record<string, Extractor>> {
	const out: Record<string, Extractor> = {};
	for (const spec of SPECS) {
		out[spec.language] = makeStructuralExtractor(spec);
	}
	return out;
}

function makeStructuralExtractor(spec: LanguageSpec): Extractor {
	const declTypes = new Set(Object.keys(spec.decls));
	const callTypes = new Set(spec.callTypes);
	const importTypes = new Set(spec.imports.map((i) => i.type));
	const importByType = new Map(spec.imports.map((i) => [i.type, i] as const));

	return {
		language: spec.language,
		extract({ sourceFile, content, contentSha256, handle }): FileExtraction {
			const { root, hasError } = handle.parse(content);
			if (hasError) {
				return parseErrorResult(sourceFile, spec.language, contentSha256, root);
			}

			const nodes: GraphNode[] = [makeFileNode(sourceFile, spec.language, root.endPosition.row + 1)];
			const edges: GraphEdge[] = [];
			const ordFor = makeOrdAllocator();

			// Imports: collect every import node anywhere (top-level + grouped).
			for (const imp of collectOfType(root, importTypes)) {
				const reader = importByType.get(imp.type);
				const specifier = reader?.specifierOf(imp);
				if (specifier && specifier.trim() !== "") {
					edges.push(
						makeEdge({
							sourceFile,
							relation: "imports",
							src: sourceFile,
							dst: externalTarget(specifier),
							specifier,
						}),
					);
				}
			}

			// Declarations: every declaration node → a symbol + its calls + heritage.
			for (const decl of collectOfType(root, declTypes)) {
				const declSpec = spec.decls[decl.type];
				if (declSpec === undefined) continue;
				const name = declSpec.nameOf(decl);
				if (name === undefined || name.trim() === "") continue;
				const ord = ordFor(name);
				const symId = symbolNodeId(sourceFile, name, ord);
				nodes.push(
					makeSymbolNode({
						sourceFile,
						language: spec.language,
						name,
						symbolKind: declSpec.kind,
						node: decl,
						// Heuristic export/visibility: a capitalized name (Go/Java public,
						// Rust `pub fn` carries `visibility_modifier`); refined per-language below.
						exported: isExported(spec.language, name, decl),
						ord,
					}),
				);
				emitHeritage(sourceFile, symId, decl, declSpec, edges);
				emitCalls(sourceFile, symId, decl, callTypes, edges);
			}

			return { sourceFile, language: spec.language, nodes, edges, parseErrors: [], contentSha256 };
		},
	};
}

/** Emit `calls` edges for every call site inside a declaration's subtree. */
function emitCalls(
	sourceFile: string,
	symId: string,
	decl: SyntaxCursorNode,
	callTypes: ReadonlySet<string>,
	edges: GraphEdge[],
): void {
	let ord = 0;
	for (const call of collectOfType(decl, callTypes)) {
		const callee = calleeName(call);
		if (callee === undefined) continue;
		const dst = externalTarget(callee);
		edges.push({
			id: `${sourceFile}::calls::${symId}->${dst}:${ord}`,
			relation: "calls",
			src: symId,
			dst,
			confidence: "EXTRACTED",
			ord,
			specifier: callee,
		});
		ord++;
	}
}

/** Read the callee name from a call node across the structural grammars. */
function calleeName(call: SyntaxCursorNode): string | undefined {
	// Most grammars expose a `function`/`name` field; Ruby's `call` uses `method`.
	const byFn = fieldText(call, "function") ?? fieldText(call, "name") ?? fieldText(call, "method");
	if (byFn !== undefined) {
		// A member/scoped call → take the trailing segment.
		return tailIdentifier(byFn);
	}
	// Fallback: first identifier-ish descendant.
	const id = firstOfType(call, new Set(["identifier", "field_identifier", "constant"]));
	return id ? tailIdentifier(id.text) : undefined;
}

/** Emit heritage edges per the decl's heritage spec. */
function emitHeritage(
	sourceFile: string,
	symId: string,
	decl: SyntaxCursorNode,
	declSpec: DeclSpec,
	edges: GraphEdge[],
): void {
	if (declSpec.heritage === undefined) return;
	for (const h of declSpec.heritage) {
		const container = h.via === "field" ? decl.childForFieldName(h.from) : firstOfType(decl, new Set([h.from]));
		if (container === null) continue;
		const baseTypeSet = new Set(h.baseTypes);
		const bases = collectOfType(container, baseTypeSet);
		let ord = 0;
		for (const base of bases) {
			const baseName = tailIdentifier(base.text);
			if (baseName.trim() === "") continue;
			edges.push(
				makeEdge({
					sourceFile,
					relation: h.relation,
					src: symId,
					dst: externalTarget(baseName),
					ord: ord > 0 ? ord : undefined,
					specifier: baseName,
				}),
			);
			ord++;
		}
	}
}

// ── Small grammar helpers ────────────────────────────────────────────────────

/** Java import: the scoped name (`java.util.List`) text, trimmed of the `import`/`;`. */
function scopedText(node: SyntaxCursorNode): string | undefined {
	const scoped = firstOfType(node, new Set(["scoped_identifier", "identifier"]));
	return scoped?.text;
}

/** C/C++ `#include`: the path between <> or "". */
function includeSpecifier(node: SyntaxCursorNode): string | undefined {
	const path = firstOfType(node, new Set(["system_lib_string", "string_literal"]));
	if (path === null) return undefined;
	const t = path.text.trim();
	return t.replace(/^[<"]/, "").replace(/[>"]$/, "");
}

/** The trailing identifier of a dotted/scoped/`::`-qualified name (`a.b.c` → `c`). */
function tailIdentifier(name: string): string {
	const cleaned = name.trim();
	const byColon = cleaned.split("::").pop() ?? cleaned;
	const byDot = byColon.split(".").pop() ?? byColon;
	return byDot.trim();
}

// stripQuotes is shared from walk.ts (used by stringSpecifier above).

/**
 * A coarse, deterministic export/visibility heuristic (refined per language). Go and
 * Java treat a Capitalized identifier as exported/public; Rust marks `pub` via a
 * `visibility_modifier` child; Python/Ruby/C/C++ have no first-class export at this
 * granularity, so a leading-underscore name is treated as private, else public.
 * STABLE — derived only from the name + the node's modifiers, never a line number.
 */
function isExported(language: Language, name: string, decl: SyntaxCursorNode): boolean {
	if (language === "go" || language === "java") {
		return /^[A-Z]/.test(name);
	}
	if (language === "rust") {
		return firstOfType(decl, new Set(["visibility_modifier"])) !== null;
	}
	return !name.startsWith("_");
}
