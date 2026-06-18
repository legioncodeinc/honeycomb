/**
 * TypeScript / JavaScript extractor — PRD-014a Wave 1 (the RICHEST, FR-2 + FR-3).
 *
 * This is the repo's own language and the only extractor that additionally populates
 * {@link TsCrossFileInputs} (`importBindings` + `rawCalls`) so the 014b resolve pass
 * can wire calls and imports ACROSS files. It emits, via the uniform framework:
 *
 *   - a `file` node + a `symbol` node per top-level declaration (function, class,
 *     method, interface, type alias, enum, exported const/let);
 *   - an `imports` edge file → `external:<specifier>` for every import statement;
 *   - a `calls` edge symbol → `external:<callee>` for every call site inside a symbol;
 *   - heritage edges (`extends`/`implements` symbol → `external:<base>`), and a
 *     `method_of` edge method → owning class.
 *
 * Every unresolved target is an `external:` placeholder the 014b pass repoints; the
 * `importBindings` (tagged named/default/namespace + `typeOnly`) and `rawCalls` carry
 * the binding/callee detail so 014b resolves without re-parsing. The extractor is PURE
 * and NEVER throws on a malformed file: a tree with errors returns a single file node
 * + a ParseError (the framework/harness skips it — a-AC-4).
 *
 * Grammar grounding (web-tree-sitter @ tree-sitter-typescript): verified node types
 * `function_declaration` / `class_declaration` / `method_definition` /
 * `interface_declaration` / `type_alias_declaration` / `enum_declaration`;
 * `import_statement` → `import_clause` (`named_imports`/`namespace_import`/`identifier`)
 * + `string`; `class_heritage` → `extends_clause` / `implements_clause`;
 * `call_expression`.`function` (identifier | `member_expression`.`object`/`.property`).
 */

import {
	type Extractor,
	type FileExtraction,
	externalTarget,
	type GraphEdge,
	type GraphNode,
	type ImportBinding,
	type Language,
	type RawCall,
	type SymbolKind,
	type SyntaxCursorNode,
} from "../contracts.js";
import {
	collectOfType,
	fieldText,
	makeEdge,
	makeFileNode,
	makeOrdAllocator,
	makeSymbolNode,
	parseErrorResult,
	stripQuotes,
	symbolNodeId,
	walkNamed,
} from "./walk.js";

/** A declaration node type → the symbol kind it yields. */
const DECL_KIND: Readonly<Record<string, SymbolKind>> = {
	function_declaration: "function",
	generator_function_declaration: "function",
	class_declaration: "class",
	abstract_class_declaration: "class",
	interface_declaration: "interface",
	type_alias_declaration: "type",
	enum_declaration: "enum",
};

const CALL_TYPES: ReadonlySet<string> = new Set(["call_expression"]);

/** Build the TS or JS extractor (same logic; the language tag differs). */
export function tsJsExtractor(language: Language): Extractor {
	return {
		language,
		extract({ sourceFile, content, contentSha256, handle }): FileExtraction {
			const { root, hasError } = handle.parse(content);
			if (hasError) {
				return parseErrorResult(sourceFile, language, contentSha256, root);
			}

			const nodes: GraphNode[] = [makeFileNode(sourceFile, language, root.endPosition.row + 1)];
			const edges: GraphEdge[] = [];
			const importBindings: ImportBinding[] = [];
			const rawCalls: RawCall[] = [];
			// Track the ord per (name) so two same-named symbols disambiguate deterministically.
			const ordFor = makeOrdAllocator();

			// Walk the tree once. We handle declarations, imports, and (inside a symbol)
			// its calls + heritage. `export_statement` is transparent — we unwrap it and
			// mark the inner declaration `exported`.
			const visit = (node: SyntaxCursorNode, exported: boolean): boolean | void => {
				switch (node.type) {
					case "export_statement": {
						// Descend into the wrapped declaration, marking it exported. We do the
						// descent here (not via the generic walk) so the `exported` flag flows.
						for (let i = 0; i < node.namedChildCount; i++) {
							const child = node.namedChild(i);
							if (child !== null) visit(child, true);
						}
						return false; // handled children ourselves
					}
					case "import_statement": {
						handleImport(sourceFile, node, edges, importBindings);
						return false;
					}
					case "function_declaration":
					case "generator_function_declaration":
					case "interface_declaration":
					case "type_alias_declaration":
					case "enum_declaration": {
						const name = fieldText(node, "name");
						if (name !== undefined) {
							const ord = ordFor(name);
							const symId = symbolNodeId(sourceFile, name, ord);
							nodes.push(
								makeSymbolNode({
									sourceFile,
									language,
									name,
									symbolKind: DECL_KIND[node.type] ?? "variable",
									node,
									exported,
									ord,
								}),
							);
							collectCalls(node, symId, sourceFile, edges, rawCalls);
						}
						return false;
					}
					case "class_declaration":
					case "abstract_class_declaration": {
						handleClass(sourceFile, language, node, exported, ordFor, nodes, edges, rawCalls);
						return false;
					}
					case "lexical_declaration":
					case "variable_declaration": {
						// `export const x = ...` / top-level const: emit a variable symbol per
						// declarator name (a const that may hold an arrow function is still a symbol).
						handleVariables(sourceFile, language, node, exported, ordFor, nodes, edges, rawCalls);
						return false;
					}
					default:
						return undefined; // keep descending for nested declarations
				}
			};

			// Top-level pass: walk named children of the program with exported=false; the
			// visitor unwraps export statements itself.
			walkNamed(root, (n) => visit(n, false));

			return {
				sourceFile,
				language,
				nodes,
				edges,
				parseErrors: [],
				tsCrossFileInputs: { importBindings, rawCalls },
				contentSha256,
			};
		},
	};
}

/** Extract an `import_statement` → an `imports` edge + the tagged import bindings (FR-3). */
function handleImport(
	sourceFile: string,
	node: SyntaxCursorNode,
	edges: GraphEdge[],
	bindings: ImportBinding[],
): void {
	const source = fieldText(node, "source");
	const specifier = source ? stripQuotes(source) : "";
	if (specifier === "") return;

	// One `imports` edge file → external:<specifier> (014b repoints relative ones).
	edges.push(
		makeEdge({
			sourceFile,
			relation: "imports",
			src: sourceFile,
			dst: externalTarget(specifier),
			specifier,
		}),
	);

	// A whole `import type { … }` makes every binding type-only.
	const wholeTypeOnly = /^\s*import\s+type\b/.test(node.text);
	const clause = firstChildOfType(node, "import_clause");
	if (clause === null) return;

	for (let i = 0; i < clause.namedChildCount; i++) {
		const child = clause.namedChild(i);
		if (child === null) continue;
		if (child.type === "identifier") {
			// default import: `import def from '...'`
			bindings.push({ local: child.text, kind: "default", specifier, typeOnly: wholeTypeOnly });
		} else if (child.type === "namespace_import") {
			// `import * as ns from '...'`
			const ns = firstChildOfType(child, "identifier");
			if (ns) bindings.push({ local: ns.text, kind: "namespace", specifier, typeOnly: wholeTypeOnly });
		} else if (child.type === "named_imports") {
			for (let j = 0; j < child.namedChildCount; j++) {
				const spec = child.namedChild(j);
				if (spec === null || spec.type !== "import_specifier") continue;
				const name = fieldText(spec, "name");
				if (name === undefined) continue;
				const alias = fieldText(spec, "alias");
				// A per-specifier `type X` makes just that binding type-only.
				const specTypeOnly = wholeTypeOnly || /^\s*type\s/.test(spec.text);
				bindings.push({
					local: alias ?? name,
					imported: name,
					kind: "named",
					specifier,
					typeOnly: specTypeOnly,
				});
			}
		}
	}
}

/** Extract a class: the class symbol, its heritage edges, and each method (+ method_of). */
function handleClass(
	sourceFile: string,
	language: Language,
	node: SyntaxCursorNode,
	exported: boolean,
	ordFor: (name: string) => number | undefined,
	nodes: GraphNode[],
	edges: GraphEdge[],
	rawCalls: RawCall[],
): void {
	const name = fieldText(node, "name") ?? node.childForFieldName("name")?.text;
	if (name === undefined) return;
	const ord = ordFor(name);
	const classId = symbolNodeId(sourceFile, name, ord);
	nodes.push(makeSymbolNode({ sourceFile, language, name, symbolKind: "class", node, exported, ord }));

	// Heritage: class_heritage → extends_clause / implements_clause → base type idents.
	const heritage = firstChildOfType(node, "class_heritage");
	if (heritage !== null) {
		emitHeritage(sourceFile, classId, heritage, "extends_clause", "extends", edges);
		emitHeritage(sourceFile, classId, heritage, "implements_clause", "implements", edges);
	}

	// Methods: each method_definition → a method symbol + a method_of edge → the class.
	const body = node.childForFieldName("body") ?? firstChildOfType(node, "class_body");
	if (body !== null) {
		for (let i = 0; i < body.namedChildCount; i++) {
			const member = body.namedChild(i);
			if (member === null || member.type !== "method_definition") continue;
			const mName = fieldText(member, "name");
			if (mName === undefined) continue;
			const qualified = `${name}.${mName}`;
			const mOrd = ordFor(qualified);
			const methodId = symbolNodeId(sourceFile, qualified, mOrd);
			nodes.push(
				makeSymbolNode({
					sourceFile,
					language,
					name: qualified,
					symbolKind: "method",
					node: member,
					exported,
					ord: mOrd,
				}),
			);
			edges.push(makeEdge({ sourceFile, relation: "method_of", src: methodId, dst: classId }));
			collectCalls(member, methodId, sourceFile, edges, rawCalls);
		}
	}
}

/** Emit `extends`/`implements` edges from a class_heritage's clause to each base identifier. */
function emitHeritage(
	sourceFile: string,
	classId: string,
	heritage: SyntaxCursorNode,
	clauseType: string,
	relation: "extends" | "implements",
	edges: GraphEdge[],
): void {
	const clause = firstChildOfType(heritage, clauseType);
	if (clause === null) return;
	let ord = 0;
	for (let i = 0; i < clause.namedChildCount; i++) {
		const base = clause.namedChild(i);
		if (base === null) continue;
		// The base is an identifier / type_identifier (a `generic_type` wraps one).
		const ident = base.type === "identifier" || base.type === "type_identifier" ? base : firstChildOfType(base, "type_identifier") ?? firstChildOfType(base, "identifier");
		const baseName = ident?.text;
		if (baseName === undefined) continue;
		edges.push(
			makeEdge({
				sourceFile,
				relation,
				src: classId,
				dst: externalTarget(baseName),
				ord: ord > 0 ? ord : undefined,
				specifier: baseName,
			}),
		);
		ord++;
	}
}

/** Emit a variable/const symbol per declarator name (captures arrow-function consts). */
function handleVariables(
	sourceFile: string,
	language: Language,
	node: SyntaxCursorNode,
	exported: boolean,
	ordFor: (name: string) => number | undefined,
	nodes: GraphNode[],
	edges: GraphEdge[],
	rawCalls: RawCall[],
): void {
	for (let i = 0; i < node.namedChildCount; i++) {
		const declarator = node.namedChild(i);
		if (declarator === null || declarator.type !== "variable_declarator") continue;
		const name = fieldText(declarator, "name");
		if (name === undefined) continue;
		const ord = ordFor(name);
		const symId = symbolNodeId(sourceFile, name, ord);
		nodes.push(
			makeSymbolNode({ sourceFile, language, name, symbolKind: "variable", node: declarator, exported, ord }),
		);
		collectCalls(declarator, symId, sourceFile, edges, rawCalls);
	}
}

/**
 * Collect every call site inside a symbol's subtree → a `calls` edge symbol →
 * `external:<callee>` + a {@link RawCall} for the resolve pass. A member call
 * `ns.foo()` records `object: ns`, `callee: foo`; a bare `foo()` records `callee: foo`.
 * `this.m()` is recorded with `object: this` (014b skips `this`-dispatch by design).
 */
function collectCalls(
	symbolNode: SyntaxCursorNode,
	symbolId: string,
	sourceFile: string,
	edges: GraphEdge[],
	rawCalls: RawCall[],
): void {
	const calls = collectOfType(symbolNode, CALL_TYPES);
	let ord = 0;
	for (const call of calls) {
		const fn = call.childForFieldName("function");
		if (fn === null) continue;
		let object: string | undefined;
		let callee: string | undefined;
		if (fn.type === "identifier") {
			callee = fn.text;
		} else if (fn.type === "member_expression") {
			object = fieldText(fn, "object");
			callee = fieldText(fn, "property");
		}
		if (callee === undefined) continue;
		const dst = externalTarget(object ? `${object}.${callee}` : callee);
		edges.push({
			id: `${sourceFile}::calls::${symbolId}->${dst}:${ord}`,
			relation: "calls",
			src: symbolId,
			dst,
			confidence: "EXTRACTED",
			ord,
			specifier: object ? `${object}.${callee}` : callee,
		});
		rawCalls.push({ fromSymbolId: symbolId, callee, object });
		ord++;
	}
}

/** First direct or descendant child of a given type. */
function firstChildOfType(node: SyntaxCursorNode, type: string): SyntaxCursorNode | null {
	for (let i = 0; i < node.namedChildCount; i++) {
		const c = node.namedChild(i);
		if (c !== null && c.type === type) return c;
	}
	return null;
}
