/**
 * PRD-049b — the project-segment predicate (`buildProjectScopeClause` /
 * `buildProjectScopeConjunct`), the SECOND inner-ring clause beside the agent_id
 * read-policy clause. This is the factored, EXPORTED builder the live recall arms,
 * the fast-path collection layer, and PRD-049c (skills) all reuse — so it is unit-
 * tested in isolation here for the admission/exclusion semantics every caller relies on:
 *
 *   - a BOUND session in project P admits ONLY `project_id = 'P'` + the unset sentinel
 *     (`''`, legacy/workspace-global per D5) — and NOTHING else (49b-AC-2);
 *   - an UNBOUND session admits ONLY the `__unsorted__` inbox + the unset sentinel
 *     (D8 / 49b-AC-3), never a real project;
 *   - every interpolated value is SQL-escaped through `sLiteral` (the 002b floor);
 *   - the conjunct form is the inline ` AND (…)` an arm appends verbatim.
 */

import { describe, expect, it } from "vitest";

import {
	buildProjectScopeClause,
	buildProjectScopeConjunct,
} from "../../../../src/daemon/runtime/recall/scope-clause.js";
import { UNSORTED_PROJECT_ID } from "../../../../src/daemon/storage/catalog/projects.js";

describe("buildProjectScopeClause — the project-segment predicate (49b-AC-2)", () => {
	it("a BOUND session admits its project OR the unset sentinel, and nothing else", () => {
		const clause = buildProjectScopeClause({ projectId: "proj-A", bound: true });
		expect(clause.bound).toBe(true);
		// Admits the resolved project + the '' legacy/global sentinel.
		expect(clause.sql).toContain("project_id = 'proj-A'");
		expect(clause.sql).toContain("project_id = ''");
		// Excludes any OTHER project: B's id must NOT appear.
		expect(clause.sql).not.toContain("proj-B");
		// Does NOT admit the inbox for a bound session (its captures landed in the real project).
		expect(clause.sql).not.toContain(UNSORTED_PROJECT_ID);
		expect(clause.values).toEqual(["proj-A", ""]);
	});

	it("an UNBOUND session admits the inbox OR the unset sentinel, never a real project", () => {
		const clause = buildProjectScopeClause({ projectId: UNSORTED_PROJECT_ID, bound: false });
		expect(clause.bound).toBe(false);
		expect(clause.sql).toContain(`project_id = '${UNSORTED_PROJECT_ID}'`);
		expect(clause.sql).toContain("project_id = ''");
		expect(clause.values).toEqual([UNSORTED_PROJECT_ID, ""]);
	});

	it("a blank projectId is treated as the unbound inbox session (D8 default)", () => {
		const clause = buildProjectScopeClause({ projectId: "" });
		expect(clause.bound).toBe(false);
		expect(clause.sql).toContain(`project_id = '${UNSORTED_PROJECT_ID}'`);
		expect(clause.sql).toContain("project_id = ''");
	});

	it("the `__unsorted__` id is inferred unbound even without an explicit bound flag", () => {
		const clause = buildProjectScopeClause({ projectId: UNSORTED_PROJECT_ID });
		expect(clause.bound).toBe(false);
	});

	it("a non-blank, non-inbox id is inferred BOUND even without an explicit bound flag", () => {
		const clause = buildProjectScopeClause({ projectId: "proj-X" });
		expect(clause.bound).toBe(true);
		expect(clause.sql).toContain("project_id = 'proj-X'");
	});

	it("an explicit bound:false overrides inference (resolver authority wins)", () => {
		// The resolver said unbound even though a non-inbox id was passed → honor the flag.
		const clause = buildProjectScopeClause({ projectId: "leftover", bound: false });
		expect(clause.bound).toBe(false);
		// Admits the inbox (the unbound admission), not the passed-but-unbound id.
		expect(clause.sql).toContain(`project_id = '${UNSORTED_PROJECT_ID}'`);
		expect(clause.sql).not.toContain("leftover");
	});

	it("SQL-escapes the project id through sLiteral (injection floor)", () => {
		const clause = buildProjectScopeClause({ projectId: "p'; DROP TABLE memories; --", bound: true });
		// The embedded quote is DOUBLED (`p''`), so it can never close the literal early — the
		// whole payload collapses into one inert string literal, no second statement is produced.
		expect(clause.sql).toContain("project_id = 'p''; DROP TABLE memories; --'");
		// The raw (un-doubled) `p';` shape — which WOULD break out — never appears.
		expect(clause.sql).not.toContain("'p'; DROP");
	});

	it("uses a custom project column when asked (049c skills reuse)", () => {
		const clause = buildProjectScopeClause({ projectId: "p", bound: true, projectColumn: "project_id" });
		expect(clause.sql).toContain("project_id = 'p'");
	});

	// FIX #6 — legacy rows a backend healed to SQL NULL (rather than the '' DEFAULT) must
	// ALSO be admitted: `project_id = ''` never matches NULL under SQL three-valued logic.
	it("a BOUND session ALSO admits `project_id IS NULL` alongside the '' sentinel (FIX #6)", () => {
		const clause = buildProjectScopeClause({ projectId: "proj-A", bound: true });
		expect(clause.sql).toContain("project_id = 'proj-A'");
		expect(clause.sql).toContain("project_id = ''");
		// NULL is treated identically to '' as "unset/legacy".
		expect(clause.sql).toContain("project_id IS NULL");
		// `IS NULL` carries no interpolated value — it must not pollute the auditable `values`.
		expect(clause.values).toEqual(["proj-A", ""]);
	});

	it("an UNBOUND session ALSO admits `project_id IS NULL` alongside the inbox + '' (FIX #6)", () => {
		const clause = buildProjectScopeClause({ projectId: UNSORTED_PROJECT_ID, bound: false });
		expect(clause.sql).toContain(`project_id = '${UNSORTED_PROJECT_ID}'`);
		expect(clause.sql).toContain("project_id = ''");
		expect(clause.sql).toContain("project_id IS NULL");
		expect(clause.values).toEqual([UNSORTED_PROJECT_ID, ""]);
	});

	it("the NULL arm rides the custom project column too (049c skills reuse)", () => {
		const clause = buildProjectScopeClause({
			projectId: "p",
			bound: true,
			projectColumn: "cross_project_scope_dummy",
		});
		// Whatever column the '' equality targets (sqlIdent emits a safe identifier — bare
		// when no quoting is needed), the IS NULL arm targets the SAME column.
		expect(clause.sql).toContain("cross_project_scope_dummy = ''");
		expect(clause.sql).toContain("cross_project_scope_dummy IS NULL");
	});

	it("the NULL arm is a bare keyword — no value is interpolated (injection-safe)", () => {
		const clause = buildProjectScopeClause({ projectId: "proj-A", bound: true });
		// The IS NULL predicate must be a keyword, never `IS NULL = '<something>'` or a literal.
		expect(clause.sql).toMatch(/project_id IS NULL/);
		expect(clause.sql).not.toContain("IS NULL = ");
		expect(clause.sql).not.toContain("'NULL'");
	});

	it("the parenthesized fragment carries no leading WHERE/AND (the caller composes it)", () => {
		const clause = buildProjectScopeClause({ projectId: "p", bound: true });
		expect(clause.sql.startsWith("(")).toBe(true);
		expect(clause.sql.endsWith(")")).toBe(true);
		expect(clause.sql.trimStart().startsWith("AND")).toBe(false);
		expect(clause.sql.trimStart().startsWith("WHERE")).toBe(false);
	});
});

describe("buildProjectScopeConjunct — the inline AND fragment", () => {
	it("prepends a leading ' AND ' so an arm appends it verbatim after its WHERE", () => {
		const conj = buildProjectScopeConjunct({ projectId: "proj-A", bound: true });
		expect(conj.startsWith(" AND (")).toBe(true);
		expect(conj).toContain("project_id = 'proj-A'");
	});

	it("never returns an empty string — the predicate always constrains", () => {
		// Even the unbound/blank case constrains to inbox+unset, never wide-open.
		expect(buildProjectScopeConjunct({ projectId: "" }).trim().length).toBeGreaterThan(0);
		expect(buildProjectScopeConjunct({ projectId: UNSORTED_PROJECT_ID }).trim().length).toBeGreaterThan(0);
	});
});
