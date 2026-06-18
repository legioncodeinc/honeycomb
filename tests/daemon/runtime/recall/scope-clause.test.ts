/**
 * PRD-007 ScopeClauseBuilder — the authorization chokepoint (Wave 1, built so
 * 007c/d/e + live tests reuse it). 007c FR-2/FR-3 + D-7.
 *
 * Adversarial: this is THE security boundary. The fail-closed posture (malformed
 * agent / unknown policy → `isolated`, never wider) is the load-bearing property
 * Wave 3 `security-worker-bee` audits — proved here at the builder level.
 *
 * No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import { buildScopeClause } from "../../../../src/daemon/runtime/recall/scope-clause.js";

describe("ScopeClauseBuilder — the three read policies (007c FR-3 / D-7)", () => {
	it("isolated → own memories only, archived excluded", () => {
		const clause = buildScopeClause({ agentId: "agent-1", readPolicy: "isolated" });
		expect(clause.policyApplied).toBe("isolated");
		expect(clause.sql).toContain("agent_id = 'agent-1'");
		expect(clause.sql).toContain("is_deleted = 0");
		// isolated does NOT widen to global visibility.
		expect(clause.sql).not.toContain("visibility");
		expect(clause.error).toBeUndefined();
	});

	it("shared → workspace-global OR own, archived excluded", () => {
		const clause = buildScopeClause({ agentId: "agent-1", readPolicy: "shared" });
		expect(clause.policyApplied).toBe("shared");
		expect(clause.sql).toContain("visibility = 'global'");
		expect(clause.sql).toContain("agent_id = 'agent-1'");
		expect(clause.sql).toContain("is_deleted = 0");
		expect(clause.sql).toMatch(/OR/);
	});

	it("group → same-policy_group global (resolved members) + own, archived excluded", () => {
		const clause = buildScopeClause({
			agentId: "agent-1",
			readPolicy: "group",
			policyGroup: "team-a",
			groupAgentIds: ["agent-1", "agent-2", "agent-3"],
		});
		expect(clause.policyApplied).toBe("group");
		// Global from same-group agents.
		expect(clause.sql).toContain("visibility = 'global'");
		expect(clause.sql).toContain("agent_id IN ('agent-1', 'agent-2', 'agent-3')");
		// Plus own.
		expect(clause.sql).toContain("agent_id = 'agent-1'");
		expect(clause.sql).toContain("is_deleted = 0");
	});

	it("group with no resolved members degrades to own-only (fail-closed, never wider)", () => {
		const clause = buildScopeClause({ agentId: "agent-1", readPolicy: "group", groupAgentIds: [] });
		expect(clause.policyApplied).toBe("group");
		// No global arm — own-only.
		expect(clause.sql).toContain("agent_id = 'agent-1'");
		expect(clause.sql).not.toContain("visibility = 'global'");
		expect(clause.sql).toContain("is_deleted = 0");
	});
});

describe("ScopeClauseBuilder — fail-closed (007c FR-7 / c-AC-5)", () => {
	it("a blank agent id falls back to isolated + a structured error, never wider", () => {
		const clause = buildScopeClause({ agentId: "", readPolicy: "shared", org: "o", workspace: "w" });
		// Even though `shared` was requested, the applied policy is the safe isolated.
		expect(clause.policyApplied).toBe("isolated");
		expect(clause.sql).not.toContain("visibility = 'global'");
		expect(clause.error).toBeDefined();
		expect(clause.error?.reason).toMatch(/agent id/i);
		expect(clause.error?.org).toBe("o");
		expect(clause.error?.workspace).toBe("w");
		expect(clause.error?.policy).toBe("shared");
	});

	it("a whitespace-only agent id is treated as missing → isolated + error", () => {
		const clause = buildScopeClause({ agentId: "   ", readPolicy: "group" });
		expect(clause.policyApplied).toBe("isolated");
		expect(clause.error).toBeDefined();
	});

	it("an unknown read policy falls back to isolated + a structured error", () => {
		const clause = buildScopeClause({ agentId: "agent-1", readPolicy: "superadmin" });
		expect(clause.policyApplied).toBe("isolated");
		expect(clause.sql).toContain("agent_id = 'agent-1'");
		expect(clause.sql).not.toContain("visibility");
		expect(clause.error?.reason).toMatch(/unknown read policy/i);
		expect(clause.error?.policy).toBe("superadmin");
	});
});

describe("ScopeClauseBuilder — SQL safety (007c FR-2 / PRD-002b)", () => {
	it("escapes an injection-shaped agent id (doubled quote, no early literal close)", () => {
		const evil = "x'; DROP TABLE memories; --";
		const clause = buildScopeClause({ agentId: evil, readPolicy: "isolated" });
		// The embedded quote is doubled by sLiteral — the literal cannot close early,
		// so the whole payload collapses into one inert literal value.
		expect(clause.sql).toContain("'x''; DROP TABLE memories; --'");
		// There is no LONE (un-doubled) single quote that could terminate the literal
		// before the payload's end: every `'` inside the value appears doubled.
		const inner = clause.sql.slice(clause.sql.indexOf("'x"), clause.sql.lastIndexOf("--'") + 3);
		expect(inner.replace(/''/g, "")).not.toContain("';");
		// The values list records the raw value for auditability.
		expect(clause.values).toContain(evil);
	});

	it("escapes every resolved group member id in the IN list", () => {
		const clause = buildScopeClause({
			agentId: "agent-1",
			readPolicy: "group",
			groupAgentIds: ["a'b", "c"],
		});
		expect(clause.sql).toContain("'a''b'");
		expect(clause.values).toContain("a'b");
	});

	it("the sql is a parenthesized fragment with no leading WHERE/AND", () => {
		const clause = buildScopeClause({ agentId: "agent-1", readPolicy: "isolated" });
		expect(clause.sql.startsWith("(")).toBe(true);
		expect(clause.sql.trimStart().startsWith("WHERE")).toBe(false);
		expect(clause.sql.trimStart().startsWith("AND")).toBe(false);
	});
});
