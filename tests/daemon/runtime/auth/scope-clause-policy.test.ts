/**
 * PRD-011e — agent scoping verified against the EXISTING buildScopeClause (D-8).
 *
 * 011e does NOT rebuild the clause. `buildScopeClause` (recall/scope-clause.ts) is
 * the canonical inner-ring authorization chokepoint, already integrated in
 * recall/authorization.ts and live-proven by recall-authz-live.itest.ts. This suite
 * asserts the six e-ACs against that existing builder; each `describe` is named
 * after the AC it proves. If any e-AC genuinely fails here, that is a REAL finding
 * to report — these are expected to PASS against existing code.
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
import {
	buildAuthorizationSql,
	buildBrowseAuthorizationSql,
} from "../../../../src/daemon/runtime/recall/authorization.js";
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

describe("e-AC-2 the scope clause authorizes IDs BEFORE any content-bearing stage loads", () => {
	it("the authorization re-query selects id ONLY — no content column", () => {
		const clause = buildScopeClause({ agentId: "agent-a", readPolicy: "isolated" });
		const sql = buildAuthorizationSql({ candidateIds: ["m1", "m2"], clause, filters: undefined });
		expect(sql).not.toBeNull();
		// IDs-only: the authorization read projects `id`, never `content`/`normalized_content`.
		expect(sql).toContain("SELECT id AS id");
		expect(sql).not.toContain("content");
		// And the scope clause is ANDed in — a candidate only survives if it satisfies it.
		expect(sql).toContain(clause.sql);
		expect(sql).toContain("id IN (");
	});

	it("the browse authorization likewise selects id ONLY, behind the same clause", () => {
		// The VFS browse path enumerates the authorized set; it too applies the clause
		// before any content returns (the same chokepoint, no content projection).
		const clause = buildScopeClause({ agentId: "agent-a", readPolicy: "isolated" });
		const sql = buildBrowseAuthorizationSql({ clause });
		expect(sql).toContain("SELECT id AS id");
		expect(sql).not.toContain("content");
		expect(sql).toContain(clause.sql);
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
