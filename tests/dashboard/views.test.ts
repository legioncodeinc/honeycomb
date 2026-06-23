/**
 * PRD-020b dashboard view-builders suite — b-AC-1 / b-AC-3 / b-AC-4 / b-AC-6.
 *
 * The view-builders are PURE (view-model → `ViewBlock`), so these assert the render-tree
 * STRUCTURE without a DOM — exactly what lets the SAME builders feed both the daemon-served
 * dashboard and the 020c Cursor webview (D-6). Drives the fake `DashboardDataSource` so there
 * is no live daemon.
 */

import { describe, expect, it } from "vitest";

import {
	buildGraphView,
	buildKpisView,
	buildRulesView,
	buildSessionsView,
	buildSettingsView,
	buildSkillSyncView,
	createFakeDashboardDataSource,
	type DashboardData,
	GRAPH_BUILD_PROMPT,
	renderDashboard,
} from "../../src/dashboard/index.js";

/** A fully-populated DashboardData (a built graph, rules, sessions, skills) for the render tests. */
function fullData(): DashboardData {
	return {
		kpis: { memoryCount: 42, sessionCount: 7, estimatedSavings: 1234, extra: { orgSeats: 5 } },
		sessions: {
			sessions: [
				{ sessionId: "sess-1", project: "honeycomb", startedAt: "2026-06-18T00:00:00Z", eventCount: 12, status: "captured" },
				{ sessionId: "sess-2", project: "sample-project", startedAt: "2026-06-17T00:00:00Z", eventCount: 3, status: "summarized" },
			],
		},
		settings: { orgId: "org-1", orgName: "Acme", workspace: "default", settings: { mode: "local", port: "3850" } },
		graph: {
			built: true,
			nodes: [
				{ id: "n1", label: "index.ts", kind: "file" },
				{ id: "n2", label: "main", kind: "function" },
			],
			edges: [{ from: "n1", to: "n2", kind: "contains" }],
		},
		rules: {
			rules: [
				{ id: "r1", title: "Use ESM", active: true },
				{ id: "r2", title: "Old rule", active: false },
			],
		},
		skillSync: {
			skills: [
				{ name: "deeplake-recall", scope: "team", syncState: "shared" },
				{ name: "local-helper", scope: "personal", syncState: "pulled" },
			],
		},
	};
}

describe("PRD-020b b-AC-1 renders all 6 views from daemon-served data", () => {
	it("b-AC-1: renderDashboard builds KPIs, sessions, settings, graph, rules, skill-sync from the daemon data", async () => {
		const source = createFakeDashboardDataSource({ data: fullData() });
		const rendered = await renderDashboard(source);

		expect(rendered.connectivity.reachable).toBe(true);
		// Six views, in the canonical order (the STABLE contract 020c embeds).
		expect(rendered.views).toHaveLength(6);
		expect(rendered.views.map((v) => v.title)).toEqual([
			"KPIs",
			"Sessions",
			"Settings",
			"Codebase graph",
			"Rules",
			"Skill-sync",
		]);
		// Each view carries its data — not a blank panel.
		const kpis = rendered.views[0];
		expect(kpis.rows).toContain("Memories: 42");
		expect(kpis.rows).toContain("Sessions: 7");
		const sessions = rendered.views[1];
		expect(sessions.rows?.[0]).toContain("sess-1");
		const skillSync = rendered.views[5];
		expect(skillSync.rows?.[0]).toContain("deeplake-recall");
	});

	it("b-AC-1: each builder is pure (view-model in → ViewBlock out) so both surfaces render identically", () => {
		const data = fullData();
		expect(buildKpisView(data.kpis).kind).toBe("metric");
		expect(buildSessionsView(data.sessions).kind).toBe("table");
		expect(buildSettingsView(data.settings).rows).toContain("Org: Acme (org-1)");
		expect(buildSkillSyncView(data.skillSync).kind).toBe("panel");
	});
});

describe("PRD-020b b-AC-3 built graph renders the canvas from the graph endpoints", () => {
	it("b-AC-3: a built GraphView renders a graph-canvas block carrying the daemon's nodes/edges", () => {
		const block = buildGraphView(fullData().graph);
		expect(block.kind).toBe("graph-canvas");
		expect(block.rows).toContain("2 nodes");
		expect(block.rows).toContain("1 edges");
		const data = block.data as { nodes: unknown[]; edges: unknown[] };
		expect(data.nodes).toHaveLength(2);
		expect(data.edges).toHaveLength(1);
	});
});

describe("PRD-020b b-AC-4 rules view lists the active rules", () => {
	it("b-AC-4: buildRulesView lists each org rule with its active marker", () => {
		const block = buildRulesView(fullData().rules);
		expect(block.kind).toBe("table");
		expect(block.title).toBe("Rules");
		expect(block.rows?.[0]).toContain("Use ESM");
		expect(block.rows?.[0]?.startsWith("●")).toBe(true); // active
		expect(block.rows?.[1]?.startsWith("○")).toBe(true); // inactive
	});
});

describe("PRD-020b b-AC-6 no-graph shows the empty-state prompt, not an error", () => {
	it("b-AC-6: an unbuilt GraphView renders the `honeycomb graph build` empty-state (not a throw)", () => {
		const block = buildGraphView({ built: false, nodes: [], edges: [] });
		expect(block.kind).toBe("empty-state");
		expect(block.rows).toContain(GRAPH_BUILD_PROMPT);
		expect(block.rows?.[0]).toContain("honeycomb graph build");
	});

	it("b-AC-6: the unbuilt graph flows through renderDashboard as an empty-state block, not an error", async () => {
		const data = { ...fullData(), graph: { built: false, nodes: [], edges: [] } };
		const rendered = await renderDashboard(createFakeDashboardDataSource({ data }));
		const graphBlock = rendered.views[3];
		expect(graphBlock.kind).toBe("empty-state");
		expect(graphBlock.rows?.[0]).toContain("honeycomb graph build");
	});
});
