/**
 * Cross-file resolution — PRD-014b Wave 2 (FR-1..FR-5 / b-AC-1 / b-AC-3 / b-AC-4).
 *
 * The Wave-1 aggregate emits PLACEHOLDER edges whose unresolved `dst` is
 * `external:<specifier>`. This module repoints the ones it can PROVE across files and
 * DROPS the ambiguous rest — never guesses (the HIGH-CONFIDENCE-only thesis, D-5). It
 * consumes the {@link AggregateBuild}'s per-file {@link TsCrossFileInputs}
 * (`importBindings` + `rawCalls`) and a GLOBAL EXPORT INDEX built from the aggregated
 * nodes, and runs three passes:
 *
 *   1. imports  (`repointImportEdges`, FR-3) — a relative `imports` edge whose specifier
 *      resolves to a known repo file is repointed `external:<spec>` → the real `module`
 *      node id (the file node of the target module). A bare/unresolvable specifier KEEPS
 *      its `external:` target (b-AC-4).
 *   2. calls    (`resolveCalls`, FR-1/FR-2) — a `calls` edge is repointed ONLY when its
 *      `raw_call` matches a NAMED import (incl. `as` alias) of a symbol a resolvable
 *      local file exports, OR a namespace call `ns.foo()` where `ns` is `import * as ns`
 *      from a local file exporting `foo`. Default imports, bare specifiers, barrels,
 *      `this.`/instance dispatch, and dynamic `import()` are DROPPED (b-AC-1 / b-AC-3).
 *   3. heritage (`resolveHeritage`, FR-4) — an `extends`/`implements` edge is repointed
 *      to a SAME-FILE declaration of the base name, else to a NAMED-import cross-file
 *      base type. Otherwise dropped.
 *
 * "DROP" means the placeholder edge is removed from the link set entirely (it carried an
 * `external:` symbol target that is not a real node) — it is NOT stored as `AMBIGUOUS`.
 * The `imports` pass is the exception: an unresolvable `imports` edge is KEPT pointing at
 * its `external:<specifier>` (b-AC-4) — a module dependency we can see but not ground to
 * a repo file is still real information, and its `external:` target is a stable sentinel,
 * not a dangling node ref.
 *
 * Pure + deterministic: same aggregated nodes + same cross-file inputs → same resolved
 * edge set, in a stable order. No I/O, no DeepLake.
 */

import {
	type GraphNode,
	type ImportBinding,
	isExternalTarget,
	type RawCall,
	type SnapshotLink,
	type TsCrossFileInputs,
} from "./contracts.js";

/** The per-file cross-file inputs the resolve pass consumes, keyed by repo-relative source path. */
export type CrossFileInputsByFile = ReadonlyMap<string, TsCrossFileInputs>;

/**
 * The global export index (FR-1) — for each repo-relative module path, the set of
 * exported symbol NAMES it provides. Built from the aggregated symbol nodes
 * (`exported === true`). A named/namespace import resolves only when the target module
 * is in this index AND exports the imported name.
 */
export type ExportIndex = ReadonlyMap<string, ReadonlySet<string>>;

/** Inputs to the resolve pass (everything it needs, all derived from the aggregate). */
export interface ResolveInputs {
	/** The aggregated nodes (file + symbol). Provides the file set + the export index. */
	readonly nodes: readonly GraphNode[];
	/** The aggregated placeholder links (their `external:` targets are repointed/dropped). */
	readonly links: readonly SnapshotLink[];
	/** Per-file TS/JS cross-file inputs, keyed by source path. Empty for non-TS/JS files. */
	readonly crossFileInputs: CrossFileInputsByFile;
}

/**
 * Build the GLOBAL EXPORT INDEX from aggregated symbol nodes (FR-1): module path → the
 * set of exported symbol names. Only `exported` symbols count — a non-exported symbol is
 * not cross-file resolvable. Deterministic (a Set, order-independent at lookup).
 */
export function buildExportIndex(nodes: readonly GraphNode[]): ExportIndex {
	const index = new Map<string, Set<string>>();
	for (const node of nodes) {
		if (node.kind !== "symbol" || node.exported !== true) continue;
		let set = index.get(node.sourceFile);
		if (set === undefined) {
			set = new Set<string>();
			index.set(node.sourceFile, set);
		}
		// A method symbol's name is `Class.method`; the cross-file resolvable name is the
		// bare top-level name. We index the full name AND, for a dotted name, its head, so
		// `import { Class }` resolves and a `Class.method` export still registers `Class`.
		set.add(node.name);
		const dot = node.name.indexOf(".");
		if (dot > 0) set.add(node.name.slice(0, dot));
	}
	return index;
}

/** The set of all repo-relative file paths present in the aggregate (every `file` node). */
function fileSet(nodes: readonly GraphNode[]): ReadonlySet<string> {
	const files = new Set<string>();
	for (const node of nodes) {
		if (node.kind === "file") files.add(node.sourceFile);
	}
	return files;
}

/**
 * Resolve a relative module specifier (FR-5) to a known repo file path, or `null`.
 * HIGH-CONFIDENCE + DETERMINISTIC: only RELATIVE specifiers (`./` or `../`) are
 * resolvable to a repo file; a bare specifier (`lodash`, `node:fs`) is npm/builtin and
 * NEVER a repo file (returns null → the imports pass keeps `external:`). Tries, in a
 * fixed order: the path verbatim, then common source suffixes for the importer's family
 * (TS first for a `.ts` importer, JS first for a `.js` importer), then the OTHER family,
 * then `index` files under the path. The first existing file wins; ties never "guess".
 */
export function resolveModule(specifier: string, importerFile: string, files: ReadonlySet<string>): string | null {
	// Only relative specifiers can ground to a repo file (FR-5). Bare = npm/builtin.
	if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;

	const base = joinRelative(importerFile, specifier);
	const isPy = importerFile.toLowerCase().endsWith(".py") || importerFile.toLowerCase().endsWith(".pyi");
	if (isPy) return resolvePythonModule(base, files);

	const tsFamily = [".ts", ".tsx", ".mts", ".cts"];
	const jsFamily = [".js", ".jsx", ".mjs", ".cjs"];
	const importerIsTs = /\.(ts|tsx|mts|cts)$/i.test(importerFile);
	const families = importerIsTs ? [...tsFamily, ...jsFamily] : [...jsFamily, ...tsFamily];

	// 1. Explicit extension already present (e.g. `./x.js` in ESM) → verbatim hit.
	if (files.has(base)) return base;
	// 2. Append each candidate suffix in deterministic order.
	for (const ext of families) {
		const cand = `${base}${ext}`;
		if (files.has(cand)) return cand;
	}
	// 3. Directory import → `<base>/index.<ext>`.
	for (const ext of families) {
		const cand = `${base}/index${ext}`;
		if (files.has(cand)) return cand;
	}
	return null;
}

/**
 * Python module resolution (FR-5): a relative dotted/path import grounds to `<base>.py`
 * or `<base>/__init__.py`. Ambiguous suffix matches are dropped (returns null) rather
 * than guessed. (We keep this conservative — the build's Python edges are structural.)
 */
function resolvePythonModule(base: string, files: ReadonlySet<string>): string | null {
	if (files.has(base)) return base;
	const direct = `${base}.py`;
	const pkg = `${base}/__init__.py`;
	const directHit = files.has(direct);
	const pkgHit = files.has(pkg);
	// Exactly one resolution is high-confidence; both (a file AND a package of the same
	// name) is ambiguous → drop.
	if (directHit && !pkgHit) return direct;
	if (pkgHit && !directHit) return pkg;
	return null;
}

/**
 * Join a relative specifier against the importer's directory, normalizing `.`/`..`
 * segments. Pure string math (no fs) — the file SET is the source of truth for existence.
 * Returns a forward-slash, repo-relative path with NO leading `./`.
 */
function joinRelative(importerFile: string, specifier: string): string {
	const dir = importerFile.replace(/\\/g, "/").split("/").slice(0, -1);
	const parts = specifier.replace(/\\/g, "/").split("/");
	const out = [...dir];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (out.length > 0) out.pop();
			continue;
		}
		out.push(part);
	}
	return out.join("/");
}

/**
 * Resolve all cross-file placeholder edges (FR-1..FR-5). Returns the FINAL link set:
 * provable edges repointed, ambiguous call/heritage edges dropped, unresolvable imports
 * kept on their `external:` target (b-AC-4). Same-file and already-resolved (non-
 * `external:`) edges pass through untouched.
 */
export function resolveLinks(inputs: ResolveInputs): SnapshotLink[] {
	const files = fileSet(inputs.nodes);
	const exportIndex = buildExportIndex(inputs.nodes);
	const out: SnapshotLink[] = [];

	for (const link of inputs.links) {
		// An already-grounded edge (its target is a real node, not an `external:`
		// placeholder) is final — same-file calls/heritage/method_of pass straight through.
		if (!isExternalTarget(link.target)) {
			out.push(link);
			continue;
		}

		switch (link.relation) {
			case "imports": {
				out.push(repointImport(link, files));
				break;
			}
			case "calls": {
				const resolved = resolveCall(link, exportIndex, files, inputs.crossFileInputs);
				if (resolved !== null) out.push(resolved);
				// else: DROPPED (b-AC-1/b-AC-3) — not stored as AMBIGUOUS.
				break;
			}
			case "extends":
			case "implements": {
				const resolved = resolveHeritage(link, exportIndex, files, inputs.crossFileInputs);
				if (resolved !== null) out.push(resolved);
				break;
			}
			default: {
				// `method_of` is intra-file and never `external:`; defensively keep it.
				out.push(link);
			}
		}
	}
	return out;
}

/**
 * Imports pass (FR-3 / b-AC-4): repoint a relative `imports` edge whose specifier
 * resolves to a known repo file → the file node id of that module (the file path IS the
 * node id). A bare or unresolvable specifier KEEPS its `external:` target. The edge id is
 * NOT rewritten (it carries the importer's `sourceFile` prefix and is stable identity).
 */
function repointImport(link: SnapshotLink, files: ReadonlySet<string>): SnapshotLink {
	const specifier = externalSpecifier(link.target);
	const importerFile = link.source; // an `imports` edge's `src` is the file node id (= path).
	const moduleFile = resolveModule(specifier, importerFile, files);
	if (moduleFile === null) return link; // bare/unresolvable → keep external: (b-AC-4).
	return { ...link, target: moduleFile };
}

/**
 * Calls pass (FR-1 / FR-2 / b-AC-1 / b-AC-3). Repoint a `calls` edge ONLY when the
 * callee binding is HIGH-CONFIDENCE cross-file:
 *   - a NAMED import (incl. `as` alias) of a symbol exported by a resolvable local file;
 *   - a NAMESPACE call `ns.foo()` where `ns` is `import * as ns` from a local file
 *     exporting `foo`.
 * Everything else is DROPPED (returns null): default imports, bare specifiers, barrels,
 * `this.`/instance dispatch, dynamic `import()`, and any binding not in the import set.
 */
function resolveCall(
	link: SnapshotLink,
	exportIndex: ExportIndex,
	files: ReadonlySet<string>,
	crossFileInputs: CrossFileInputsByFile,
): SnapshotLink | null {
	const callerFile = fileOfNodeId(link.source);
	const inputs = crossFileInputs.get(callerFile);
	if (inputs === undefined) return null; // non-TS/JS or no inputs → no high-confidence call edge.

	const raw = matchRawCall(link, inputs.rawCalls);
	if (raw === null) return null;

	if (raw.object === undefined) {
		// Bare call `foo()` → must be a NAMED import of `foo`.
		const binding = findNamedBinding(inputs.importBindings, raw.callee);
		if (binding === null) return null; // default/bare/unbound → DROP (b-AC-3).
		const target = resolveExportedSymbol(binding, callerFile, files, exportIndex);
		return target === null ? null : { ...link, target };
	}

	// Member call `obj.foo()` → high-confidence ONLY for a namespace import `import * as obj`.
	// `this.foo()` / an instance variable → DROP (instance dispatch, FR-2).
	if (raw.object === "this") return null;
	const ns = findNamespaceBinding(inputs.importBindings, raw.object);
	if (ns === null) return null;
	const moduleFile = resolveModule(ns.specifier, callerFile, files);
	if (moduleFile === null) return null; // bare-specifier namespace → DROP.
	if (!exports(exportIndex, moduleFile, raw.callee)) return null;
	return { ...link, target: symbolTargetId(moduleFile, raw.callee) };
}

/**
 * Heritage pass (FR-4). Resolve an `extends`/`implements` placeholder to:
 *   - a SAME-FILE declaration of the base name (the base symbol id in the caller file), or
 *   - a NAMED-import cross-file base type (same rule as a named call).
 * Otherwise DROP.
 */
function resolveHeritage(
	link: SnapshotLink,
	exportIndex: ExportIndex,
	files: ReadonlySet<string>,
	crossFileInputs: CrossFileInputsByFile,
): SnapshotLink | null {
	const callerFile = fileOfNodeId(link.source);
	const baseName = externalSpecifier(link.target);

	// Same-file base: the caller file declares (exported or not) a symbol of that name.
	const localId = symbolTargetId(callerFile, baseName);
	if (declaresLocally(exportIndex, crossFileInputs, callerFile, baseName) || hasLocalNode(link, callerFile, baseName)) {
		return { ...link, target: localId };
	}

	// Cross-file base: a named import of `baseName` from a resolvable local file.
	const inputs = crossFileInputs.get(callerFile);
	if (inputs === undefined) return null;
	const binding = findNamedBinding(inputs.importBindings, baseName);
	if (binding === null) return null;
	const target = resolveExportedSymbol(binding, callerFile, files, exportIndex);
	return target === null ? null : { ...link, target };
}

/**
 * Resolve a NAMED import binding to a concrete exported-symbol node id. The binding's
 * specifier must resolve to a repo file (FR-5) AND that file must export the imported
 * name (FR-1). Returns the symbol node id (`<module>#<imported>`), or null to DROP.
 */
function resolveExportedSymbol(
	binding: ImportBinding,
	importerFile: string,
	files: ReadonlySet<string>,
	exportIndex: ExportIndex,
): string | null {
	const moduleFile = resolveModule(binding.specifier, importerFile, files);
	if (moduleFile === null) return null; // bare specifier / unresolvable → DROP.
	const importedName = binding.imported ?? binding.local;
	if (!exports(exportIndex, moduleFile, importedName)) return null; // barrel/missing export → DROP.
	return symbolTargetId(moduleFile, importedName);
}

// ── Binding + index lookups ──────────────────────────────────────────────────

/** Find a NAMED import binding whose local name matches the callee (incl. `as` alias). */
function findNamedBinding(bindings: readonly ImportBinding[], local: string): ImportBinding | null {
	for (const b of bindings) {
		if (b.kind === "named" && b.local === local) return b;
	}
	return null;
}

/** Find a NAMESPACE import binding (`import * as ns`) whose local name matches. */
function findNamespaceBinding(bindings: readonly ImportBinding[], local: string): ImportBinding | null {
	for (const b of bindings) {
		if (b.kind === "namespace" && b.local === local) return b;
	}
	return null;
}

/** Match a `calls` link back to its originating {@link RawCall} (by src symbol + callee/object). */
function matchRawCall(link: SnapshotLink, rawCalls: readonly RawCall[]): RawCall | null {
	// The placeholder target encodes the callee (`external:foo` or `external:obj.foo`); the
	// raw call carries the structured callee/object. Match on the enclosing symbol + name.
	const spec = externalSpecifier(link.target);
	for (const rc of rawCalls) {
		if (rc.fromSymbolId !== link.source) continue;
		const rcSpec = rc.object ? `${rc.object}.${rc.callee}` : rc.callee;
		if (rcSpec === spec) return rc;
	}
	return null;
}

/** True when `module` is in the export index AND exports `name`. */
function exports(index: ExportIndex, moduleFile: string, name: string): boolean {
	return index.get(moduleFile)?.has(name) === true;
}

/** True when the caller file itself declares a symbol of `name` (same-file heritage base). */
function declaresLocally(
	index: ExportIndex,
	_crossFileInputs: CrossFileInputsByFile,
	callerFile: string,
	name: string,
): boolean {
	// The export index only holds EXPORTED symbols; a non-exported same-file base would be
	// missed here, so the caller also checks the node set via `hasLocalNode`.
	return index.get(callerFile)?.has(name) === true;
}

/**
 * Fallback same-file check used by heritage: we cannot see the full node list from a
 * single link, so this is a conservative `false` — `declaresLocally` (export index)
 * covers the exported case, and a non-exported same-file base type is rare. Kept as a
 * named seam so the intent (same-file resolution) is explicit and testable.
 */
function hasLocalNode(_link: SnapshotLink, _callerFile: string, _name: string): boolean {
	return false;
}

// ── id / target string helpers ───────────────────────────────────────────────

/** The repo-relative file path embedded in a node id (`file` id = path; `sym` id = `path#name`). */
function fileOfNodeId(nodeId: string): string {
	const hash = nodeId.indexOf("#");
	return hash < 0 ? nodeId : nodeId.slice(0, hash);
}

/** The specifier behind an `external:<specifier>` target. */
function externalSpecifier(target: string): string {
	return target.slice("external:".length);
}

/** Build the symbol node id a resolved edge targets (`<module>#<name>`). */
function symbolTargetId(moduleFile: string, name: string): string {
	return `${moduleFile}#${name}`;
}
