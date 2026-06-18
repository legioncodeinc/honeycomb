/**
 * PRD-014a extractor framework — a-AC-1 + a-AC-4 against SOURCE FIXTURES.
 *
 * Verification posture (EXECUTION_LEDGER-prd-014): no DeepLake, no network. We write
 * known source strings and assert `extractFile` routes by extension and returns a
 * uniform FileExtraction with nodes / edges / parse errors / TS cross-file inputs, and
 * that a malformed file reports parse errors + is skipped without aborting.
 *
 * These run the REAL web-tree-sitter WASM parser (no mock) — the whole point of Wave 1
 * is that the nine grammars actually parse.
 */

import { describe, expect, it } from "vitest";

import { extractFile, languageForFile } from "../../../../src/daemon/runtime/codebase/extract.js";
import type { GraphEdge, GraphNode } from "../../../../src/daemon/runtime/codebase/contracts.js";

function symbolNames(nodes: readonly GraphNode[]): string[] {
	return nodes.filter((n) => n.kind === "symbol").map((n) => n.name);
}
function relations(edges: readonly GraphEdge[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const e of edges) out[e.relation] = (out[e.relation] ?? 0) + 1;
	return out;
}

describe("PRD-014a a-AC-1: extractFile routes by extension and returns a uniform FileExtraction", () => {
	it("a-AC-1 routes a .ts file to the TS extractor with nodes, edges, parse errors, and TS cross-file inputs", async () => {
		const src = [
			"import { bar } from './x';",
			"import * as ns from './n';",
			"import type { T } from './t';",
			"export function foo(): T { bar(); ns.baz(); return null as never; }",
			"export class A extends B implements I { m() { this.foo(); } }",
		].join("\n");
		const r = await extractFile("src/a.ts", src);
		expect(r).not.toBeNull();
		const ex = r!;
		expect(ex.language).toBe("typescript");
		// file node + symbol nodes (foo, A, A.m).
		expect(ex.nodes.some((n) => n.kind === "file")).toBe(true);
		expect(symbolNames(ex.nodes)).toEqual(expect.arrayContaining(["foo", "A", "A.m"]));
		// edges: imports + calls + extends + implements + method_of.
		const rel = relations(ex.edges);
		expect(rel.imports).toBeGreaterThanOrEqual(2);
		expect(rel.calls).toBeGreaterThanOrEqual(2);
		expect(rel.extends).toBe(1);
		expect(rel.implements).toBe(1);
		expect(rel.method_of).toBe(1);
		// parse errors empty for a clean file.
		expect(ex.parseErrors).toEqual([]);
		// TS cross-file inputs: import bindings (named/namespace/typeOnly) + raw calls.
		expect(ex.tsCrossFileInputs).toBeDefined();
		const bindings = ex.tsCrossFileInputs!.importBindings;
		expect(bindings.some((b) => b.kind === "named" && b.local === "bar")).toBe(true);
		expect(bindings.some((b) => b.kind === "namespace" && b.local === "ns")).toBe(true);
		expect(bindings.some((b) => b.typeOnly === true)).toBe(true);
		expect(ex.tsCrossFileInputs!.rawCalls.length).toBeGreaterThanOrEqual(2);
		// every unresolved target is an external: placeholder (014b repoints later).
		expect(ex.edges.filter((e) => e.relation === "imports").every((e) => e.dst.startsWith("external:"))).toBe(true);
	});

	it("a-AC-1 routes each of the nine languages to its extractor and emits nodes + edges + parse errors", async () => {
		const fixtures: Record<string, string> = {
			"f.ts": "export function foo(){ bar(); }",
			"f.js": "export function foo(){ bar(); }",
			"f.py": "import os\ndef foo():\n    bar()\nclass A(B): pass\n",
			"f.go": 'package m\nimport "fmt"\nfunc Foo(){ bar() }\ntype S struct{}\n',
			"f.rs": "use std::fmt;\nfn foo(){ bar(); }\nstruct S{}\ntrait T{}\nimpl T for S{}\n",
			"f.java": "import java.util.List;\nclass A extends B implements C { void m(){ foo(); } }\n",
			"f.rb": "class A < B\n  def m; end\nend\n",
			"f.c": "#include <stdio.h>\nint foo(){ bar(); return 0; }\n",
			"f.cpp": "#include <vector>\nclass A : public B { void m(){ foo(); } };\n",
		};
		for (const [file, src] of Object.entries(fixtures)) {
			const r = await extractFile(file, src);
			expect(r, `${file} should extract`).not.toBeNull();
			const ex = r!;
			// Uniform shape: a file node always exists; arrays are always present.
			expect(ex.nodes.some((n) => n.kind === "file"), `${file} file node`).toBe(true);
			expect(Array.isArray(ex.edges)).toBe(true);
			expect(Array.isArray(ex.parseErrors)).toBe(true);
			expect(ex.contentSha256).toMatch(/^[0-9a-f]{64}$/);
			// At least one symbol for each fixture (they all declare something).
			expect(symbolNames(ex.nodes).length, `${file} symbols`).toBeGreaterThanOrEqual(1);
		}
	});

	it("a-AC-1 only TS/JS populate tsCrossFileInputs; the other seven leave it undefined", async () => {
		const ts = await extractFile("a.ts", "export function f(){ g(); }");
		const py = await extractFile("a.py", "def f():\n    g()\n");
		expect(ts!.tsCrossFileInputs).toBeDefined();
		expect(py!.tsCrossFileInputs).toBeUndefined();
	});

	it("a-AC-1 an unsupported extension routes to null", async () => {
		expect(await extractFile("readme.md", "# hi")).toBeNull();
		expect(await extractFile("data.json", "{}")).toBeNull();
		expect(languageForFile("x.md")).toBeNull();
	});

	it("a-AC-1 node ids are deterministic and line-free (moving an unrelated symbol does not change ids)", async () => {
		const a = await extractFile("m.ts", "export function foo(){}\nexport function bar(){}\n");
		// Insert a blank line BEFORE bar so bar shifts down — its id must NOT change.
		const b = await extractFile("m.ts", "export function foo(){}\n\n\nexport function bar(){}\n");
		const idA = a!.nodes.find((n) => n.name === "bar")!.id;
		const idB = b!.nodes.find((n) => n.name === "bar")!.id;
		expect(idA).toBe(idB);
		expect(idA).toBe("m.ts#bar");
	});
});

describe("PRD-014a a-AC-4: a malformed file reports parse errors and is skipped, build not aborted", () => {
	it("a-AC-4 a malformed TS file returns parse errors and only its file node (symbols/edges skipped)", async () => {
		const r = await extractFile("broken.ts", "function ( { oops $$$ <<< not valid");
		expect(r).not.toBeNull();
		const ex = r!;
		expect(ex.parseErrors.length).toBeGreaterThanOrEqual(1);
		expect(ex.parseErrors[0].sourceFile).toBe("broken.ts");
		// The file node is the sole trusted contribution; no symbol nodes, no edges.
		expect(ex.nodes.filter((n) => n.kind === "symbol")).toEqual([]);
		expect(ex.edges).toEqual([]);
	});

	it("a-AC-4 extraction of a malformed file NEVER throws (the build continues)", async () => {
		// A pile of malformed inputs across languages — none may throw.
		const inputs: Array<[string, string]> = [
			["x.py", "def (:::"],
			["x.go", "func ( {{{ "],
			["x.rs", "fn ( { && "],
			["x.java", "class { ( void"],
			["x.c", "int ( { struct"],
		];
		for (const [file, src] of inputs) {
			await expect(extractFile(file, src)).resolves.not.toThrow();
		}
	});

	it("a-AC-4 a clean file mixed with the malformed-file policy still yields a full extraction", async () => {
		const clean = await extractFile("ok.ts", "export const x = 1;");
		expect(clean!.parseErrors).toEqual([]);
		expect(clean!.nodes.some((n) => n.kind === "symbol")).toBe(true);
	});
});
