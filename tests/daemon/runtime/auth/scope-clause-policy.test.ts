/**
 * PRD-011e — agent scoping verified against the EXISTING buildScopeClause (D-8).
 *
 * 011e does NOT rebuild the clause. `buildScopeClause` (recall/scope-clause.ts) is
 * the canonical inner-ring authorization chokepoint, live-proven by
 * recall-authz-live.itest.ts. This suite asserts the six e-ACs against that existing
 * builder; each `describe` is named after the AC it proves. If any e-AC genuinely
 * fails here, that is a REAL finding to report — these are expected to PASS against
 * existing code.
 *
 * ── PRD-045b de-scope note ───────────────────────────────────────────────────
 * The dormant five-phase `RecallEngine` (and its `recall/authorization.ts`
 * re-query SQL builders) was removed — it had zero production callers; live recall
 * is `recallMemories` (lexical+vector RRF). `buildScopeClause` itself is RETAINED as
 * the canonical scope-clause chokepoint, so the e-AC assertions below target it
 * directly (e-AC-2 no longer asserts the removed `buildAuthorizationSql` shape; it
 * asserts the clause the chokepoint compiles, which is the live guarantee).
 *
 * e-AC-1 read_policy+policy_group → matching WHERE, values escaped via helpers.
 * e-AC-2 FTS/vector/traversal IDs → scope clause authorizes BEFORE any content load.
 * e-AC-3 isolated agent → only own non-archived returned.
 * e-AC-4 shared agent → workspace-global + own, archived excluded.
 * e-AC-5 group agent → same-policy_group globals + own, archived excluded.
 * e-AC-6 malformed/missing read policy → falls back to isolated.
 */

import { describe, expect, it } from "vitest";

import { buildScopeClause } from "../../../../src/daemon/runtime/recall/index.js";
import { sLiteral } from "../../../../src/daemon/storage/sql.js";

describe("e-AC-1 read_policy+policy_group emits the matching WHERE with escaped values", () => {
	it("escapes the agent id through sLiteral (no raw concatenation)", () => {
		// A hostile agent id with an embedded quote must be escaped, not closed early.
		const hostile = "a'gent";
		const clause = buildScopeClause({ agentId: hostile, readPolicy: "isolated" });
		// The escaped literal (doubled quote) appears; a raw unescaped quote-break does not.
		expect(clause.sql).toContain(sLiteral(hostile));
		expect(clause.values).toContain(hostile);
	});

	it("renders the group WHERE with every member id escaped via the helper", () => {
		const members = ["peer-1", "peer-2"];
		const clause = buildScopeClause({
			agentId: "agent-a",
			readPolicy: "group",
			policyGroup: "team-x",
			groupAgentIds: members,
		});
		expect(clause.policyApplied).toBe("group");
		for (const m of members) {
			expect(clause.sql).toContain(sLiteral(m));
		}
		// The IN-list arm + own arm are both present.
		expect(clause.sql).toContain("IN (");
		expect(clause.sql).toContain(sLiteral("agent-a"));
	});
});

describe("e-AC-2 the scope clause is a pure predicate (it authorizes BEFORE content loads)", () => {
	it("the compiled clause is a WHERE predicate, never a content projection", () => {
		// The chokepoint compiles a read-policy predicate any authorizing read ANDs in
		// before projecting content. The clause itself carries no SELECT and no content
		// column — the IDs-only-before-authorization guarantee starts here at the source.
		const clause = buildScopeClause({ agentId: "agent-a", readPolicy: "isolated" });
		expect(clause.sql).not.toContain("content");
		expect(clause.sql).not.toMatch(/\bSELECT\b/i);
		// The predicate restricts to the authorized agent and excludes archived rows —
		// a candidate only survives a re-query that ANDs this clause in.
		expect(clause.sql).toContain(`agent_id = ${sLiteral("agent-a")}`);
		expect(clause.sql).toContain("is_deleted = 0");
	});
});

describe("e-AC-3 isolated agent → only own non-archived", () => {
	it("emits own-only AND not-archived", () => {
		const clause = buildScopeClause({ agentId: "agent-a", readPolicy: "isolated" });
		expect(clause.policyApplied).toBe("isolated");
		// Own predicate present; global visibility NOT present (isolated never sees global).
		expect(clause.sql).toContain(`agent_id = ${sLiteral("agent-a")}`);
		expect(clause.sql).not.toContain("visibility = 'global'");
		// Archived excluded.
		expect(clause.sql).toContain("is_deleted = 0");
	});
});

describe("e-AC-4 shared agent → workspace-global + own, archived excluded", () => {
	it("emits global OR own AND not-archived", () => {
		const clause = buildScopeClause({ agentId: "agent-a", readPolicy: "shared" });
		expect(clause.policyApplied).toBe("shared");
		expect(clause.sql).toContain("visibility = 'global'");
		expect(clause.sql).toContain(`agent_id = ${sLiteral("agent-a")}`);
		expect(clause.sql).toContain(" OR ");
		expect(clause.sql).toContain("is_deleted = 0");
	});
});

describe("e-AC-5 group agent → same-policy_group globals + own, archived excluded", () => {
	it("emits group-global IN (...) OR own AND not-archived", () => {
		const clause = buildScopeClause({
			agentId: "agent-a",
			readPolicy: "group",
			policyGroup: "team-x",
			groupAgentIds: ["agent-a", "peer-1"],
		});
		expect(clause.policyApplied).toBe("group");
		expect(clause.sql).toContain("visibility = 'global'");
		expect(clause.sql).toContain("IN (");
		expect(clause.sql).toContain(`agent_id = ${sLiteral("agent-a")}`);
		expect(clause.sql).toContain("is_deleted = 0");
	});

	it("a group with no resolved members degrades to own-only (fail-closed, never wider)", () => {
		const clause = buildScopeClause({
			agentId: "agent-a",
			readPolicy: "group",
			policyGroup: "team-x",
			groupAgentIds: [],
		});
		// policyApplied stays "group" but the rendered SQL is own-only (no global arm).
		expect(clause.policyApplied).toBe("group");
		expect(clause.sql).toContain(`agent_id = ${sLiteral("agent-a")}`);
		expect(clause.sql).not.toContain("visibility = 'global'");
		expect(clause.sql).toContain("is_deleted = 0");
	});
});

describe("e-AC-6 malformed/missing read policy → falls back to isolated", () => {
	it("an unknown read policy falls back to isolated + a structured error", () => {
		const clause = buildScopeClause({ agentId: "agent-a", readPolicy: "superuser" });
		expect(clause.policyApplied).toBe("isolated");
		expect(clause.error).toBeDefined();
		expect(clause.error?.reason).toContain("unknown read policy");
		// The fallback SQL is the safe own-only isolated fragment.
		expect(clause.sql).toContain(`agent_id = ${sLiteral("agent-a")}`);
		expect(clause.sql).not.toContain("visibility = 'global'");
	});

	it("a blank/malformed agent id falls back to isolated + a structured error", () => {
		const clause = buildScopeClause({ agentId: "   ", readPolicy: "shared" });
		expect(clause.policyApplied).toBe("isolated");
		expect(clause.error).toBeDefined();
		expect(clause.error?.reason).toContain("missing or malformed agent id");
	});
});
