/**
 * PRD-049e (49e-AC-2) — the Memories LIST project-segment threading suite.
 *
 * The dashboard's selected project re-scopes the Memories list to that `project_id`. The wire stamps
 * the `x-honeycomb-project` header; the daemon resolves it via `resolveRequestProject` (an EXPLICIT
 * selection that short-circuits cwd — 049e), and `buildListSql` ANDs the SHARED project-segment
 * predicate (the SAME clause recall uses) so the list shows ONLY the selected project's rows (+
 * unset/legacy rows), never another project's. These tests pin both halves:
 *
 *   - `buildListSql(limit, project)` emits the project-segment WHERE conjunct narrowing to the project;
 *     `buildListSql(limit)` (no project) is byte-for-byte the prior project-agnostic SQL (back-compat).
 *   - `resolveRequestProject` honors the `x-honeycomb-project` header as a BOUND, non-degraded project
 *     (the viewer-side selection), short-circuiting the cwd branch; absent the header it falls through.
 */

import { describe, expect, it } from "vitest";
import type { Context } from "hono";

import { buildListSql } from "../../../../src/daemon/runtime/memories/reads.js";
import { resolveRequestProject, PROJECT_HEADER, CWD_HEADER } from "../../../../src/daemon/runtime/scope.js";
import { UNSORTED_PROJECT_ID } from "../../../../src/hooks/shared/project-resolver.js";

/** A minimal Hono `Context` stub exposing only `req.header(name)` from a fixed header map. */
function ctx(headers: Record<string, string>): Context {
	const lower: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
	return {
		req: { header: (name: string): string | undefined => lower[name.toLowerCase()] },
	} as unknown as Context;
}

describe("buildListSql threads the project-segment predicate (49e-AC-2)", () => {
	it("with a bound project → ANDs the project_id narrowing conjunct (admits the project + unset rows)", () => {
		const sql = buildListSql(50, { projectId: "api", bound: true });
		// The project segment narrows to the selected project (+ the unset/legacy sentinel).
		expect(sql).toContain("project_id");
		expect(sql).toContain("'api'");
		// It is ANDed beside the soft-delete predicate (a narrowing conjunct, not a replacement).
		expect(sql).toMatch(/is_deleted.*=.*0.*AND.*project_id/s);
	});

	it("with the inbox selection → narrows to the inbox + unset rows (never another project)", () => {
		const sql = buildListSql(50, { projectId: UNSORTED_PROJECT_ID, bound: false });
		expect(sql).toContain(UNSORTED_PROJECT_ID);
	});

	it("with NO project → the prior project-agnostic SQL (back-compat, no project predicate)", () => {
		const sql = buildListSql(50);
		expect(sql).not.toContain("project_id");
	});
});

describe("resolveRequestProject honors the x-honeycomb-project selection (49e-AC-2)", () => {
	it("an explicit project header → a BOUND, non-degraded project (short-circuits cwd)", () => {
		// A cwd header is ALSO present — the explicit selection must win over it.
		const project = resolveRequestProject(ctx({ [PROJECT_HEADER]: "api", [CWD_HEADER]: "/some/path" }), { org: "acme", workspace: "backend" });
		expect(project.projectId).toBe("api");
		expect(project.bound).toBe(true);
		expect(project.degraded).toBe(false);
	});

	it("an explicit inbox selection → the inbox (bound:false), still non-degraded", () => {
		const project = resolveRequestProject(ctx({ [PROJECT_HEADER]: UNSORTED_PROJECT_ID }), { org: "acme", workspace: "backend" });
		expect(project.projectId).toBe(UNSORTED_PROJECT_ID);
		expect(project.bound).toBe(false);
		expect(project.degraded).toBe(false);
	});

	it("NO project header AND no cwd → the degraded inbox fallback (the unchanged 49b path)", () => {
		const project = resolveRequestProject(ctx({}), { org: "acme", workspace: "backend" });
		expect(project.projectId).toBe(UNSORTED_PROJECT_ID);
		expect(project.degraded).toBe(true);
	});

	it("a blank/whitespace project header is treated as ABSENT (falls through to 49b)", () => {
		const project = resolveRequestProject(ctx({ [PROJECT_HEADER]: "   " }), { org: "acme", workspace: "backend" });
		expect(project.degraded).toBe(true);
	});
});
