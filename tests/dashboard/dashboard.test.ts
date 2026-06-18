/**
 * PRD-020b dashboard orchestrator + launch suite — index AC-2 / b-AC-2 / b-AC-5 + FR-1.
 *
 * Index AC-2: the dashboard renders KPIs/sessions/settings/graph/skill-sync from daemon-served
 * data. b-AC-2: daemon-down → a CLEAR connectivity state (banner + retry), never a hang or blank
 * panels. b-AC-5: the SAME `renderDashboard` output is the canonical view layer 020c's webview
 * embeds (the contract-stability half; 020c's own embedding test lives in tests/cursor-extension).
 * FR-1: `launchDashboard` points the dashboard at the daemon on 3850 and returns the same tree.
 *
 * All driven through the fake `DashboardDataSource` / a fake `fetch` — no live daemon.
 */

import { describe, expect, it } from "vitest";

import {
	createDaemonDashboardDataSource,
	createFakeDashboardDataSource,
	daemonBaseUrl,
	type DashboardData,
	type FetchLike,
	launchDashboard,
	renderDashboard,
} from "../../src/dashboard/index.js";

function fullData(): DashboardData {
	return {
		kpis: { memoryCount: 10, sessionCount: 4, estimatedSavings: 99 },
		sessions: { sessions: [{ sessionId: "s1", project: "p", startedAt: "2026-06-18", eventCount: 1, status: "captured" }] },
		settings: { orgId: "o", orgName: "O", workspace: "w", settings: {} },
		graph: { built: true, nodes: [{ id: "a", label: "a", kind: "file" }], edges: [] },
		rules: { rules: [{ id: "r", title: "R", active: true }] },
		skillSync: { skills: [{ name: "k", scope: "team", syncState: "shared" }] },
	};
}

describe("PRD-020b index AC-2 dashboard renders KPIs/sessions/settings/graph/skill-sync", () => {
	it("AC-2: a reachable daemon renders all five named views (+ rules) from daemon-served data", async () => {
		const rendered = await renderDashboard(createFakeDashboardDataSource({ data: fullData() }));
		expect(rendered.connectivity.reachable).toBe(true);
		const titles = rendered.views.map((v) => v.title);
		expect(titles).toContain("KPIs");
		expect(titles).toContain("Sessions");
		expect(titles).toContain("Settings");
		expect(titles).toContain("Codebase graph");
		expect(titles).toContain("Skill-sync");
		// No blank panels: every view has either rows or data.
		for (const v of rendered.views) {
			expect((v.rows?.length ?? 0) > 0 || v.data !== undefined).toBe(true);
		}
	});
});

describe("PRD-020b b-AC-2 daemon-down surfaces a clear connectivity state (no hang/blank)", () => {
	it("b-AC-2: an unreachable probe returns the connectivity banner ALONE with the daemon URL + retry", async () => {
		const source = createFakeDashboardDataSource({ down: true, url: "http://127.0.0.1:3850" });
		const rendered = await renderDashboard(source);

		expect(rendered.connectivity.reachable).toBe(false);
		// The banner ONLY — not six blank view panels.
		expect(rendered.views).toHaveLength(1);
		const banner = rendered.views[0];
		expect(banner.kind).toBe("connectivity");
		expect(banner.title).toBe("Daemon unreachable");
		expect(banner.rows?.some((r) => r.includes("http://127.0.0.1:3850"))).toBe(true);
		expect(banner.rows?.some((r) => /retry/i.test(r))).toBe(true);
	});

	it("b-AC-2: renderDashboard NEVER calls fetchAll while the daemon is down (no hang behind a probe)", async () => {
		let fetchAllCalls = 0;
		const source = {
			async probe() {
				return { reachable: false as const, url: "http://127.0.0.1:3850", retry: true as const };
			},
			async fetchAll(): Promise<DashboardData> {
				fetchAllCalls += 1;
				return fullData();
			},
		};
		await renderDashboard(source);
		expect(fetchAllCalls).toBe(0);
	});
});

describe("PRD-020b b-AC-5 the canonical view layer 020c embeds is the SAME render output", () => {
	it("b-AC-5: rendering the same data twice via renderDashboard yields the identical ViewBlock tree (one impl)", async () => {
		// 020c's webview calls THIS same `renderDashboard` (D-6). Determinism over the same data
		// is the contract that lets both surfaces show identical views with no duplicate view code.
		const data = fullData();
		const a = await renderDashboard(createFakeDashboardDataSource({ data }));
		const b = await renderDashboard(createFakeDashboardDataSource({ data }));
		expect(JSON.stringify(a.views)).toEqual(JSON.stringify(b.views));
		// The canonical shape is stable: kinds in canonical order.
		expect(a.views.map((v) => v.kind)).toEqual(["metric", "table", "panel", "graph-canvas", "table", "panel"]);
	});
});

describe("PRD-020b FR-1 launchDashboard points the dashboard at the daemon on 3850", () => {
	it("FR-1: daemonBaseUrl defaults to the loopback daemon on port 3850", () => {
		expect(daemonBaseUrl()).toBe("http://127.0.0.1:3850");
	});

	it("FR-1: launchDashboard with an injected fake source renders the canonical tree", async () => {
		const rendered = await launchDashboard({ source: createFakeDashboardDataSource({ data: fullData() }) });
		expect(rendered.views).toHaveLength(6);
		expect(rendered.connectivity.reachable).toBe(true);
	});

	it("FR-7/FR-8: the real loopback data source probes /health then fetches the six view endpoints", async () => {
		const seen: string[] = [];
		const fakeFetch: FetchLike = async (url) => {
			seen.push(url);
			const path = url.replace("http://127.0.0.1:3850", "");
			const bodies: Record<string, unknown> = {
				"/health": { status: "ok" },
				"/api/kpis": fullData().kpis,
				"/api/diagnostics/sessions": fullData().sessions,
				"/api/diagnostics/settings": fullData().settings,
				"/api/graph": fullData().graph,
				"/api/rules": fullData().rules,
				"/api/skills": fullData().skillSync,
			};
			return { ok: true, status: 200, async json() { return bodies[path] ?? {}; } };
		};
		const source = createDaemonDashboardDataSource({ fetch: fakeFetch });
		const rendered = await renderDashboard(source);
		expect(rendered.connectivity.reachable).toBe(true);
		expect(seen).toContain("http://127.0.0.1:3850/health");
		expect(seen).toContain("http://127.0.0.1:3850/api/graph");
		expect(rendered.views[0].rows).toContain("Memories: 10");
	});

	it("FR-8: a failing /health probe yields the unreachable connectivity state (no throw, no hang)", async () => {
		const fakeFetch: FetchLike = async () => {
			throw new Error("ECONNREFUSED");
		};
		const source = createDaemonDashboardDataSource({ fetch: fakeFetch, timeoutMs: 50 });
		const conn = await source.probe();
		expect(conn.reachable).toBe(false);
		const rendered = await renderDashboard(source);
		expect(rendered.views[0].kind).toBe("connectivity");
	});
});
