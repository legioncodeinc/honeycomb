/**
 * PRD-049b — STRUCTURAL guarantee (49b-AC-5).
 *
 * Per the project memory note: "isolated unit mounts structurally miss exactly this
 * cross-scope class." So this suite asserts the INVARIANTS at the source level rather than
 * (only) at runtime — a new recall/capture code path either upholds them or fails CI:
 *
 *   (a) NO capture or recall code path resolves the session project from the machine-global
 *       `credentials.workspaceId` directly — the project authority is the cwd resolver
 *       (`resolveScope` / `resolveRequestScope` / `resolveRequestProject` / `resolveScopeFromDisk`).
 *       `workspaceId` may only appear where it is the FALLBACK partition default (049a), never as
 *       the project key.
 *   (b) the `project_id` predicate is present on EVERY memory recall query — every arm builder
 *       in the live recall engine, the fast-path collection layer, and the vector search ANDs the
 *       project segment. We assert each arm SELECT carries a `project_id` reference.
 *
 * The check reads the real source files (not a reconstruction), so a future arm that forgets the
 * predicate, or a path that reaches for `workspaceId` as the project key, trips this test.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../../../src");

function read(rel: string): string {
	return readFileSync(resolve(SRC, rel), "utf8");
}

describe("49b-AC-5 (b): the project_id predicate is on every memory recall query", () => {
	it("every lexical arm builder in recall.ts ANDs the project segment", () => {
		const src = read("daemon/runtime/memories/recall.ts");
		// Each arm builder threads a `projectClause` that is appended into its WHERE.
		for (const builder of ["buildMemoriesArmSql", "buildMemoryArmSql", "buildSessionsArmSql"]) {
			expect(src).toContain(builder);
		}
		// The three arms are invoked WITH the computed project clause (not bare).
		expect(src).toContain("buildMemoriesArmSql(term, limit, projectClause)");
		expect(src).toContain("buildMemoryArmSql(term, limit, projectClause)");
		expect(src).toContain("buildSessionsArmSql(term, limit, projectClause)");
		// The semantic arm threads the project clause into the `<#>` vector search + the hydrate.
		expect(src).toContain("buildProjectScopeConjunct");
		expect(src).toMatch(/extraClause:\s*projectClause/);
		expect(src).toMatch(/buildSemanticHydrateSql\(spec, ids, projectClause\)/);
	});

	it("the fast-path collection layer ANDs the project segment into the FTS + vector channels", () => {
		const src = read("daemon/runtime/recall/collection.ts");
		expect(src).toContain("buildProjectScopeConjunct");
		// FTS channel carries it...
		expect(src).toMatch(/buildFtsSql\(\{[^}]*projectClause[^}]*\}\)/s);
		// ...and the vector channel rides it inline on the `<#>` statement.
		expect(src).toMatch(/extraClause:\s*projectClause/);
	});

	it("the vector search builder accepts + emits an extra (project) conjunct inline", () => {
		const src = read("daemon/storage/vector.ts");
		expect(src).toContain("extraClause");
		// The conjunct is appended into the `<#>` WHERE in the same statement as the match.
		expect(src).toMatch(
			/"WHERE ARRAY_LENGTH\(",\s*emb,\s*", 1\) > 0 ",\s*scopeConjuncts,\s*extraClause/,
		);
	});

	it("the project-segment predicate is single-sourced + exported (one factored builder, 049c reuse)", () => {
		const src = read("daemon/runtime/recall/scope-clause.ts");
		expect(src).toContain("export function buildProjectScopeClause");
		expect(src).toContain("export function buildProjectScopeConjunct");
		// It segments on the resolved `project_id` column (not the raw `project` cwd path, D5).
		expect(src).toContain('PROJECT_ID_COLUMN = "project_id"');
		// The barrel re-exports it so a scoping review is a search for this one symbol.
		expect(read("daemon/runtime/recall/index.ts")).toContain("buildProjectScopeClause");
	});
});

describe("49b-AC-5 (a): no capture/recall path reads workspaceId as the project authority", () => {
	const PATHS = [
		"daemon/runtime/memories/recall.ts",
		"daemon/runtime/memories/api.ts",
		"daemon/runtime/recall/collection.ts",
		"daemon/runtime/vfs/api.ts",
		"daemon/runtime/capture/capture-handler.ts",
	];

	it("the project segment is derived from the cwd resolver, never from workspaceId", () => {
		for (const p of PATHS) {
			const src = read(p);
			// A `.workspaceId` member access would be the machine-global field misused as identity.
			expect(src, `${p} must not read .workspaceId`).not.toMatch(/\.workspaceId\b/);
		}
	});

	it("the capture + recall paths resolve the project through the 049a resolver seam", () => {
		// capture-handler resolves via resolveScopeFromDisk; the recall/browse handlers via
		// resolveRequestProject (which delegates to resolveScopeFromDisk) — the single authority.
		expect(read("daemon/runtime/capture/capture-handler.ts")).toContain("resolveScopeFromDisk");
		expect(read("daemon/runtime/memories/api.ts")).toContain("resolveRequestProject");
		expect(read("daemon/runtime/vfs/api.ts")).toContain("resolveRequestProject");
		// The shared resolver helper itself delegates to the 049a thin-client resolver.
		expect(read("daemon/runtime/scope.ts")).toContain("resolveScopeFromDisk");
	});
});
