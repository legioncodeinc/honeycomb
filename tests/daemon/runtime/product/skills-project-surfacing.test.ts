/**
 * PRD-049c — skills SURFACING is project-scoped + admits explicitly-promoted skills.
 *
 * Proves the read side of 49c-AC-1 (a project-B skill is not surfaced in a project-A session),
 * 49c-AC-2 (a promoted skill IS surfaced with its cross-project provenance visible), and the
 * read side of 49c-AC-3 (a pulled `none` skill is governed purely by its project_id, so it
 * surfaces only in its origin project). The check is on the SQL `fetchSkills` builds (the
 * project-segment predicate is ANDed onto the highest-version read) AND on the view-row shape
 * carrying the promotion provenance.
 */

import { describe, expect, it } from "vitest";

import { ok, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { fetchSkills } from "../../../../src/daemon/runtime/product/api.js";

const SCOPE: QueryScope = { org: "acme", workspace: "backend" };

/** A storage fake that records the SQL it was asked to run and returns a fixed skills row set. */
class RecordingReadFake implements StorageQuery {
	public lastSql = "";
	constructor(private readonly rows: StorageRow[]) {}
	query(sql: string, _scope: QueryScope): Promise<QueryResult> {
		if (/FROM\s+"skills"/i.test(sql)) {
			this.lastSql = sql;
			return Promise.resolve(ok(this.rows.map((r) => ({ ...r })), 1));
		}
		return Promise.resolve(ok([], 1));
	}
}

describe("PRD-049c skills surfacing (project-scoped + promotion-aware)", () => {
	// ── 49c-AC-1 (read) — a project-A session's SELECT admits A + inbox, excludes other projects ──
	it("49c-AC-1 fetchSkills for a bound project ANDs the project-segment predicate onto the highest-version read", async () => {
		const fake = new RecordingReadFake([]);
		await fetchSkills(fake, SCOPE, { projectId: "proj-A", bound: true });

		// The project segment (REUSED buildProjectScopeClause with the skills columns) is ANDed in.
		expect(fake.lastSql).toContain("WHERE");
		expect(fake.lastSql).toContain("project_id = 'proj-A'");
		expect(fake.lastSql).toContain("project_id = ''"); // legacy/unset rows (D5 back-compat).
		// Promotion arm admits explicitly-promoted skills (49c-AC-2)…
		expect(fake.lastSql).toContain("cross_project_scope = 'user'");
		expect(fake.lastSql).toContain("cross_project_scope = 'workspace'");
		// …but NEVER another project's id (isolation — a project-B row is filtered server-side).
		expect(fake.lastSql).not.toContain("proj-B");
	});

	// ── 49c-AC-3 (read) — an UNBOUND/no-project session narrows to inbox + unset, never a project ──
	it("49c-AC-3 fetchSkills with no project resolves the unbound inbox segment (inbox + unset only)", async () => {
		const fake = new RecordingReadFake([]);
		await fetchSkills(fake, SCOPE); // no project arg → unbound inbox session.

		expect(fake.lastSql).toContain(`project_id = '__unsorted__'`);
		expect(fake.lastSql).toContain("project_id = ''");
		// A pulled project-A skill (cross_project_scope='none', project_id='proj-A') is NOT admitted
		// by the inbox segment — it surfaces only in project A (49c-AC-3).
		expect(fake.lastSql).not.toContain("proj-A");
	});

	// ── 49c-AC-2 (read) — the surfaced row carries the cross-project provenance, VISIBLE ──
	it("49c-AC-2 a promoted skill row surfaces its crossProjectScope + promotedBy + promotedFromProject", async () => {
		const promotedRow: StorageRow = {
			id: "house-style--alice",
			name: "house-style",
			scope: "team",
			visibility: "global",
			version: 4,
			project_id: "proj-A",
			cross_project_scope: "workspace",
			promoted_by: "lead",
			promoted_from_project: "proj-A",
		};
		const fake = new RecordingReadFake([promotedRow]);

		// Surfaced from a DIFFERENT project (proj-B) — the promotion is what admits it.
		const rows = await fetchSkills(fake, SCOPE, { projectId: "proj-B", bound: true });
		expect(rows.length).toBe(1);
		const view = rows[0];
		expect(view.crossProjectScope).toBe("workspace");
		expect(view.promotedBy).toBe("lead");
		expect(view.promotedFromProject).toBe("proj-A");
		expect(view.projectId).toBe("proj-A");
	});

	// ── 49c-AC-1 (read) — an unpromoted row reads back crossProjectScope='none' (default) ──
	it("49c-AC-1 an unpromoted surfaced row reports crossProjectScope none and empty promotion provenance", async () => {
		const minedRow: StorageRow = {
			id: "tidy--alice",
			name: "tidy",
			scope: "me",
			visibility: "global",
			version: 1,
			project_id: "proj-A",
			cross_project_scope: "none",
			promoted_by: "",
			promoted_from_project: "",
		};
		const fake = new RecordingReadFake([minedRow]);
		const rows = await fetchSkills(fake, SCOPE, { projectId: "proj-A", bound: true });
		expect(rows[0].crossProjectScope).toBe("none");
		expect(rows[0].promotedBy).toBe("");
		expect(rows[0].promotedFromProject).toBe("");
	});
});
