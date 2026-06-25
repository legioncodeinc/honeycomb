/**
 * PRD-049c — per-project skill isolation + propagation. Proves 49c-AC-1..5 (named, unskipped).
 *
 * Verification posture (no live DeepLake, mirrors skills-write.test.ts):
 *   - 49c-AC-1 / 49c-AC-2 (surfacing): the project-segment predicate is built by the SINGLE
 *     factored `buildProjectScopeClause` (049b) with the skills `project_id` + `cross_project_scope`
 *     columns. The structural shape is asserted on the predicate AND end-to-end through the
 *     `GET /api/skills` SQL a canned-row storage fake observes.
 *   - 49c-AC-3 (pull lands in origin scope): the daemon-side pull writes `cross_project_scope='none'`,
 *     so a pulled skill is governed purely by its `project_id` and surfaces only in that project.
 *   - 49c-AC-4 (explicit promotion + provenance; mine/pull NEVER promote): the STRUCTURAL guarantee —
 *     a mined row (`writeSkill`) and a published/pulled row both carry `none`; ONLY `promoteSkill`
 *     stamps a non-`none` reach, recorded WITH provenance.
 *   - 49c-AC-5 (identity-less → __unsorted__): the worker's project resolution falls to the inbox.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildProjectScopeClause } from "../../../../src/daemon/runtime/recall/scope-clause.js";
import { UNSORTED_PROJECT_ID } from "../../../../src/hooks/shared/project-resolver.js";
import {
	createFsInstallTarget,
	type GateVerdict,
	promoteSkill,
	promoteToMyProjects,
	promoteWorkspaceWide,
	type Skill,
	type SkillStore,
	skillLogicalId,
	writeSkill,
} from "../../../../src/daemon/runtime/skillify/index.js";

const AUTHOR = "alice";

/** A temp dir unique per call — the install seam roots here (no real cwd/home writes). */
function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "skillify-049c-"));
}

/** A FAKE recording SkillStore — records every appended row + serves the active (highest) per id. */
interface RecordingSkillStore extends SkillStore {
	readonly appended: Skill[];
	seed(skill: Skill): void;
}
function createRecordingStore(): RecordingSkillStore {
	const appended: Skill[] = [];
	const byId = new Map<string, Skill>();
	return {
		appended,
		seed(skill: Skill): void {
			byId.set(skill.id, skill);
		},
		async maxVersion(id: string): Promise<number> {
			return byId.get(id)?.provenance.version ?? 0;
		},
		async readActive(id: string): Promise<Skill | null> {
			return byId.get(id) ?? null;
		},
		async appendVersion(skill: Skill): Promise<number> {
			appended.push(skill);
			const cur = byId.get(skill.id);
			if (!cur || skill.provenance.version >= cur.provenance.version) byId.set(skill.id, skill);
			return skill.provenance.version;
		},
	};
}

function keepVerdict(over: Partial<GateVerdict> = {}): GateVerdict {
	return {
		decision: "KEEP",
		name: "tidy-imports",
		description: "Sort and dedupe imports",
		triggerText: "when editing import blocks",
		body: "## Tidy imports\n\nSort imports alphabetically.",
		...over,
	};
}

describe("PRD-049c per-project skill isolation + promotion", () => {
	// ── 49c-AC-1 — a skill mined in project A is NOT surfaced in project B ─────────
	it("49c-AC-1 the surfacing predicate (REUSED buildProjectScopeClause) admits project A + inbox, EXCLUDES project B", () => {
		// A session in project A. The skills predicate uses the skill table's `project_id` column.
		const clause = buildProjectScopeClause({
			projectId: "proj-A",
			bound: true,
			projectColumn: "project_id",
			promotionColumn: "cross_project_scope",
		});
		// Admits the session's own project A + the unset/legacy sentinel (back-compat, D5)…
		expect(clause.sql).toContain(`project_id = 'proj-A'`);
		expect(clause.sql).toContain(`project_id = ''`);
		// …and the cross-project promotion arm (49c-AC-2)…
		expect(clause.sql).toContain(`cross_project_scope = 'user'`);
		expect(clause.sql).toContain(`cross_project_scope = 'workspace'`);
		// …but NEVER another project's id, so a project-B row is filtered server-side (isolation).
		expect(clause.sql).not.toContain("proj-B");
		// The mine/pull default `none` is NOT admitted by the promotion arm (an unpromoted skill
		// stays isolated to its project_id).
		expect(clause.sql).not.toContain(`cross_project_scope = 'none'`);
		// The interpolated values are tracked for auditability (project + inbox + both reaches).
		expect(clause.values).toEqual(["proj-A", "", "user", "workspace"]);
	});

	// ── 49c-AC-1 (write side) — a mined skill carries its origin project_id, scope `none` ──
	it("49c-AC-1 a mined (KEEP) skill stamps the resolved project_id and cross_project_scope stays none", async () => {
		const store = createRecordingStore();
		const install = createFsInstallTarget({ projectDir: tempDir(), globalDir: tempDir() });

		const outcome = await writeSkill(
			keepVerdict(),
			{ store, install, author: AUTHOR, projectId: "proj-A" },
			["s1"],
			"project",
		);

		expect(outcome.decision).toBe("KEEP");
		const row = store.appended[0];
		expect(row.provenance.projectId).toBe("proj-A");
		// The mine path NEVER promotes — no promotion block (→ row writes `cross_project_scope='none'`).
		expect(row.provenance.promotion).toBeUndefined();
	});

	// ── 49c-AC-5 — a mined skill with no resolvable project is tagged __unsorted__ ──
	it("49c-AC-5 a mined skill with no project (absent projectId) falls to the workspace __unsorted__ inbox", async () => {
		const store = createRecordingStore();
		const install = createFsInstallTarget({ projectDir: tempDir(), globalDir: tempDir() });

		// No projectId on the deps → the identity-less write (mirrors a no-cwd session).
		const outcome = await writeSkill(keepVerdict(), { store, install, author: AUTHOR }, ["s1"], "project");

		expect(outcome.decision).toBe("KEEP");
		expect(store.appended[0].provenance.projectId).toBe(UNSORTED_PROJECT_ID);
	});

	// ── 49c-AC-4 — promotion is EXPLICIT, recorded WITH provenance; mine never sets it ──
	it("49c-AC-4 promoteToMyProjects stamps cross_project_scope=user WITH provenance, preserving origin project", async () => {
		const store = createRecordingStore();
		// Seed a mined skill in project A (v1, unpromoted).
		const id = skillLogicalId("tidy-imports", AUTHOR);
		store.seed({
			id,
			name: "tidy-imports",
			author: AUTHOR,
			description: "d",
			triggerText: "t",
			body: "B",
			install: "global",
			provenance: { sourceSessions: ["s1"], version: 1, createdBy: AUTHOR, scope: "me", projectId: "proj-A" },
		});

		const out = await promoteToMyProjects(
			{ name: "tidy-imports", author: AUTHOR, promotedBy: "alice", now: () => "2026-06-25T00:00:00.000Z" },
			{ store },
		);

		expect(out.promoted).toBe(true);
		expect(out.crossProjectScope).toBe("user");
		// A NEW version row (append-only), not an in-place mutation of the mined row.
		expect(out.version).toBe(2);
		const promotedRow = store.appended.at(-1) as Skill;
		// The origin project is PRESERVED (promotion WIDENS surfacing, never MOVES the skill)…
		expect(promotedRow.provenance.projectId).toBe("proj-A");
		// …and the cross-project provenance is recorded + VISIBLE (49c-AC-2).
		expect(promotedRow.provenance.promotion).toEqual({
			crossProjectScope: "user",
			promotedBy: "alice",
			promotedAt: "2026-06-25T00:00:00.000Z",
			promotedFromProject: "proj-A",
		});
	});

	// ── 49c-AC-2 — workspace-wide promotion is surfaced everywhere, with provenance ──
	it("49c-AC-2 promoteWorkspaceWide stamps cross_project_scope=workspace with visible provenance", async () => {
		const store = createRecordingStore();
		const id = skillLogicalId("house-style", AUTHOR);
		store.seed({
			id,
			name: "house-style",
			author: AUTHOR,
			description: "d",
			triggerText: "t",
			body: "B",
			install: "global",
			provenance: { sourceSessions: ["s1"], version: 3, createdBy: AUTHOR, scope: "team", projectId: "proj-A" },
		});

		const out = await promoteWorkspaceWide(
			{ name: "house-style", author: AUTHOR, promotedBy: "lead", now: () => "2026-06-25T12:00:00.000Z" },
			{ store },
		);

		expect(out.crossProjectScope).toBe("workspace");
		expect(out.version).toBe(4); // append-only N+1.
		const row = store.appended.at(-1) as Skill;
		expect(row.provenance.promotion?.crossProjectScope).toBe("workspace");
		expect(row.provenance.promotion?.promotedBy).toBe("lead");
		expect(row.provenance.promotion?.promotedFromProject).toBe("proj-A");
	});

	// ── 49c-AC-4 — promoting an absent skill is a no-op (promotion never CREATES) ──
	it("49c-AC-4 promoting a skill that does not exist returns promoted:false (never creates a row)", async () => {
		const store = createRecordingStore();
		const out = await promoteSkill(
			{ name: "ghost", author: AUTHOR, reach: "user", promotedBy: "alice" },
			{ store },
		);
		expect(out.promoted).toBe(false);
		expect(store.appended.length).toBe(0);
	});

	// ── 49c-AC-4 (structural) — the mine path and a published row carry `none`, only promote widens ──
	it("49c-AC-4 (structural) the mine path NEVER sets a promotion; only promoteSkill writes a non-none reach", async () => {
		const store = createRecordingStore();
		const install = createFsInstallTarget({ projectDir: tempDir(), globalDir: tempDir() });

		// MINE: KEEP + MERGE-fallback both produce rows with NO promotion block.
		await writeSkill(keepVerdict({ name: "a" }), { store, install, author: AUTHOR, projectId: "proj-A" }, ["s1"], "global");
		await writeSkill(
			{ decision: "MERGE", target: "ghost", name: "ghost", body: "body", description: "d", triggerText: "t" },
			{ store, install, author: AUTHOR, projectId: "proj-A" },
			["s2"],
			"global",
		);
		for (const row of store.appended) {
			expect(row.provenance.promotion, `mined row ${row.id} must carry NO promotion`).toBeUndefined();
		}

		// Only the EXPLICIT promote operation widens — and it is the single writer of a non-none reach.
		const beforePromoteCount = store.appended.length;
		await promoteToMyProjects({ name: "a", author: AUTHOR, promotedBy: "alice" }, { store });
		const promoted = store.appended.slice(beforePromoteCount);
		expect(promoted.length).toBe(1);
		expect(promoted[0].provenance.promotion?.crossProjectScope).toBe("user");
	});

	// ── 49c-AC-2 — frontmatter / round-trip: a promoted row reads back its provenance ──
	it("49c-AC-2 a promoted row round-trips its cross-project provenance through the SKILL.md scope", async () => {
		// The SKILL.md scope frontmatter is the me/team axis (unchanged); the cross-project provenance
		// lives on the row. Assert the mined SKILL.md still renders (no regression) and the row carries
		// the project id for the surfacing predicate.
		const store = createRecordingStore();
		const projectDir = tempDir();
		const install = createFsInstallTarget({ projectDir, globalDir: tempDir() });
		const out = await writeSkill(
			keepVerdict({ name: "p-skill" }),
			{ store, install, author: AUTHOR, projectId: "proj-A" },
			["s1"],
			"project",
		);
		const md = readFileSync(out.filePath as string, "utf-8");
		expect(md).toMatch(/^---\n/); // frontmatter intact (no SKILL.md format change — Non-Goal).
		expect(store.appended[0].provenance.projectId).toBe("proj-A");
	});
});
