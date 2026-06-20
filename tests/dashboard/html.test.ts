/**
 * PRD-021d dashboard HTML host serializer suite — FR-3 / FR-4 / d-AC-3 / d-AC-5 / d-AC-6.
 *
 * `renderDashboardPage` serializes the 020b `RenderedDashboard` (the canonical `ViewBlock` tree)
 * into a COMPLETE, standalone HTML page the daemon serves at `/dashboard`. This proves: a
 * reachable render carries the six view titles in a real page; a daemon-DOWN render carries the
 * 020b connectivity banner alone (d-AC-5); a not-built graph carries the 020b empty-state prompt
 * (d-AC-6); and view data is HTML-escaped so it never breaks the markup.
 */

import { describe, expect, it } from "vitest";

import {
	buildConnectivityBanner,
	type DashboardData,
	escapePageHtml,
	GRAPH_BUILD_PROMPT,
	type RenderedDashboard,
	renderDashboard,
	renderDashboardPage,
	unreachable,
} from "../../src/dashboard/index.js";
import { createFakeDashboardDataSource } from "../../src/dashboard/index.js";

function fullData(): DashboardData {
	return {
		kpis: { memoryCount: 10, sessionCount: 4, estimatedSavings: 99 },
		sessions: { sessions: [] },
		settings: { orgId: "o", orgName: "O", workspace: "w", settings: {} },
		graph: { built: false, nodes: [], edges: [] },
		rules: { rules: [] },
		skillSync: { skills: [] },
	};
}

describe("PRD-021d renderDashboardPage serializes the canonical view tree to a page", () => {
	it("d-AC-3: a reachable render carries the six view titles in a standalone HTML page", async () => {
		const rendered = await renderDashboard(createFakeDashboardDataSource({ data: fullData() }));
		const html = renderDashboardPage(rendered);
		expect(html).toContain("<!doctype html>");
		expect(html).toContain("<title>Honeycomb dashboard</title>");
		for (const title of ["KPIs", "Sessions", "Settings", "Codebase graph", "Rules", "Skill-sync"]) {
			expect(html).toContain(title);
		}
		expect(html).toContain('data-connectivity="reachable"');
	});

	it("d-AC-6: a not-built graph serializes the 020b empty-state prompt (not an error)", async () => {
		const rendered = await renderDashboard(createFakeDashboardDataSource({ data: fullData() }));
		const html = renderDashboardPage(rendered);
		expect(html).toContain(GRAPH_BUILD_PROMPT);
		expect(html).toContain("hc-kind-empty-state");
	});

	it("d-AC-5: a daemon-down render serializes the connectivity banner ALONE, not blank", async () => {
		const rendered = await renderDashboard(createFakeDashboardDataSource({ down: true }));
		const html = renderDashboardPage(rendered);
		expect(html).toContain('data-connectivity="unreachable"');
		expect(html).toContain("Daemon unreachable");
		expect(html).toContain("hc-kind-connectivity");
		// The banner is the ONLY block — no view sections leaked through.
		expect(html).not.toContain(">KPIs<");
	});

	it("the banner builder + page agree on the connectivity block", () => {
		const banner = buildConnectivityBanner(unreachable("http://127.0.0.1:3850", "ECONNREFUSED"));
		const page: RenderedDashboard = { connectivity: unreachable("http://127.0.0.1:3850"), views: [banner] };
		const html = renderDashboardPage(page);
		expect(html).toContain("ECONNREFUSED");
	});

	it("escapes HTML-significant characters in view data", () => {
		expect(escapePageHtml("<script>&\"'")).toBe("&lt;script&gt;&amp;&quot;&#39;");
	});
});
