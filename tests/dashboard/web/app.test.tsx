// @vitest-environment jsdom
/**
 * PRD-037b — the dashboard SHELL DOM suite, porting the PRD-024 dashboard parity suite onto the
 * Dashboard route (037b AC-5 lift-and-shift parity) and adding the shell-level routing assertions
 * (037 AC-1..AC-6 / 037b AC-2, AC-3, AC-4, AC-6).
 *
 * The old `app.test.tsx` mounted `<App>` (the single page). PRD-037 split that into `<Shell>` (sidebar
 * + routed outlet); the monolithic content moved VERBATIM onto the Dashboard route (`pages/dashboard`).
 * This suite mounts the real `<Shell>` with a MOCKED `fetch` returning the exact WIRE payloads and
 * asserts the Dashboard route renders the SAME content as before — plus that the shell routes, swaps
 * without reload, deep-links, falls back on an unknown hash, and swaps the CONTENT (not the sidebar)
 * for the ConnectivityBanner when the daemon is down.
 *
 * Driven through the REAL wire layer (`createWireClient({ fetchImpl })`) so the zod boundary parsing is
 * exercised; only `fetch` is mocked. No live network.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Shell } from "../../../src/dashboard/web/app.js";
import { createWireClient } from "../../../src/dashboard/web/wire.js";
import { ROUTES } from "../../../src/dashboard/web/registry.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The representative wire payloads (the WIRE truth, not the canned data.js). */
const PAYLOADS = {
	settings: { orgId: "org_8f3a21", orgName: "Activeloop", workspace: "deeplake-core", settings: { mode: "local", port: "3850" } },
	kpis: { memoryCount: 1284, sessionCount: 312, turnCount: 312, estimatedSavings: 2400000, teamSkillCount: 5 },
	sessions: {
		sessions: [
			{ sessionId: "a7f3c", project: "deeplake-core", startedAt: "14:32", eventCount: 48, status: "summarized" },
			{ sessionId: "c4d22", project: "honeycomb", startedAt: "11:48", eventCount: 67, status: "captured" },
		],
	},
	rules: {
		rules: [
			{ id: "r_01", title: "Never deploy from main", active: true },
			{ id: "r_02", title: "All findings cite a source", active: false },
		],
	},
	skills: {
		skills: [
			{ name: "deeplake-query-builder", scope: "team", syncState: "shared" },
			{ name: "drift-healer", scope: "personal", syncState: "pending" },
		],
	},
	graph: { built: true, nodes: [{ id: "daemon", label: "daemon.ts", kind: "file" }], edges: [] },
	recall: {
		hits: [
			{ source: "memories", id: "deploy/prd-022", text: "We deploy from the prd-022 branch, never from main.", score: 0.42, kind: "memory", secondary: false },
			{ source: "sessions", id: "auth/token-drift", text: "Heal a drifted org token before the session-start block.", score: 0.17, kind: "session", secondary: true },
		],
		sources: ["memories", "sessions"],
		degraded: true,
	},
	logs: { records: [{ time: "2026-06-20T14:32:08.000Z", method: "GET", path: "/api/diagnostics/kpis", status: 200 }], count: 1 },
	// PRD-038c: the harness registry/telemetry backbone the home harness strip reads (wire.harnesses()).
	harnesses: {
		harnesses: [
			{ name: "claude-code", installed: true, active: true, lastSeen: "2026-06-20T14:31:00.000Z", turnsCaptured: 7, runtimePath: "legacy", capabilities: { name: "claude-code", runtimePath: "legacy", contextChannel: "model-only", hostCli: { bin: "claude", args: ["-p"] }, lifecycleEvents: [] } },
			{ name: "codex", installed: false, active: false, lastSeen: null, turnsCaptured: 0, runtimePath: "legacy", capabilities: { name: "codex", runtimePath: "legacy", contextChannel: "model-only", hostCli: { bin: "codex", args: [] }, lifecycleEvents: [] } },
		],
	},
	pollinateEnqueued: { triggered: true, status: "enqueued" },
	pollinateSkipped: { triggered: false, status: "skipped", reason: "disabled" },
};

/** A configurable mock fetch routing each path to its canned payload. `healthOk` toggles the down-swap. */
function makeMockFetch(opts: { healthOk?: boolean; pollinate?: unknown } = {}): typeof fetch {
	const healthOk = opts.healthOk ?? true;
	const pollinate = opts.pollinate ?? PAYLOADS.pollinateEnqueued;
	return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input.toString();
		const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		if (url.endsWith("/health")) return new Response("", { status: healthOk ? 200 : 503 });
		if (url.includes("/api/diagnostics/kpis")) return json(PAYLOADS.kpis);
		if (url.includes("/api/diagnostics/sessions")) return json(PAYLOADS.sessions);
		if (url.includes("/api/diagnostics/settings")) return json(PAYLOADS.settings);
		if (url.includes("/api/diagnostics/rules")) return json(PAYLOADS.rules);
		if (url.includes("/api/diagnostics/skills")) return json(PAYLOADS.skills);
		if (url.includes("/api/diagnostics/harnesses")) return json(PAYLOADS.harnesses);
		if (url.includes("/api/diagnostics/pollinate")) return json(pollinate, 202);
		if (url.includes("/api/graph")) return json(PAYLOADS.graph);
		if (url.includes("/api/memories/recall")) {
			expect(init?.method, "recall is a POST").toBe("POST");
			return json(PAYLOADS.recall);
		}
		if (url.includes("/api/logs")) return json(PAYLOADS.logs);
		// PRD-059b: the scope-projects read drives the first-run CTA gate. The Dashboard-parity suite needs
		// a workspace that ALREADY has a locally-bound project so the Dashboard page renders (not the
		// first-run "pick a folder" CTA). Return one bound project (+ the inbox) so parity holds; the CTA's
		// own zero-bound behavior is covered by the dedicated needs-project / first-run suite.
		if (url.includes("/api/diagnostics/scope/projects")) {
			return json({ projects: [{ projectId: "honeycomb", name: "honeycomb", boundLocally: true }], org: "org_8f3a21", workspace: "deeplake-core" });
		}
		if (url.includes("/api/diagnostics/scope/orgs")) return json({ orgs: [{ id: "org_8f3a21", name: "Activeloop" }] });
		if (url.includes("/api/diagnostics/scope/workspaces")) return json({ workspaces: [{ id: "deeplake-core", name: "deeplake-core" }], org: "org_8f3a21", reminted: false });
		if (url.endsWith("/api/settings") || url.includes("/api/settings?")) return json({ settings: {}, catalog: [] });
		if (url.endsWith("/api/secrets") || url.includes("/api/secrets?")) return json({ names: [] });
		return new Response("not found", { status: 404 });
	}) as unknown as typeof fetch;
}

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
	window.location.hash = "";
	container = document.createElement("div");
	document.body.appendChild(container);
});

afterEach(() => {
	// Guard: a test may fail before `mountShell()` assigns `root`; an unconditional unmount would throw
	// in teardown and MASK the real failing assertion.
	if (root !== undefined) act(() => root.unmount());
	root = undefined;
	container.remove();
	window.location.hash = "";
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** Mount the Shell with the given mock fetch, flushing the initial async hydration. */
async function mountShell(mockFetch: typeof fetch): Promise<void> {
	const client = createWireClient({ fetchImpl: mockFetch });
	await act(async () => {
		root = createRoot(container);
		root.render(<Shell client={client} />);
	});
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("037 AC-1: the left-nav shell renders all seven nav items + the chrome", () => {
	it("renders the sidebar (mark, wordmark, seven items) + the Pollinate now action", async () => {
		await mountShell(makeMockFetch());
		const text = container.textContent ?? "";
		// Brand chrome + the seven nav items.
		expect(text).toContain("honeycomb");
		for (const label of ["Dashboard", "Harnesses", "Memories", "Memory Graph", "Sync", "Logs", "Settings"]) {
			expect(text).toContain(label);
		}
		// The org/workspace identity + the relocated Pollinate now live in the shell chrome.
		expect(text).toContain("Activeloop");
		expect(text).toContain("deeplake-core");
		expect(text).toContain("Pollinate now");
		// The nav items are present as routes (nine since PRD-059c added Projects + PRD-060e added ROI).
		expect(container.querySelectorAll("[data-route]")).toHaveLength(ROUTES.length);
	});
});

describe("037b AC-5: Dashboard route parity — the monolithic content renders intact on '/'", () => {
	it("renders KPIs/recall/sessions/rules/skills/live-log on the default Dashboard route", async () => {
		await mountShell(makeMockFetch());
		const text = container.textContent ?? "";
		// Recall bar + KPI tiles.
		expect(text).toContain("Recall");
		expect(text).toContain("Memories");
		expect(text).toContain("Turns");
		expect(text).not.toContain("Sessions");
		expect(text).toContain("Est. savings");
		expect(text).toContain("Team skills");
		// KPI values from the mocked endpoints (1284 → "1,284", turnCount 312, teamSkillCount 5).
		expect(text).toContain("1,284");
		expect(text).toContain("312");
		expect(text).toContain("5");
		// Grid panels + their data.
		expect(text).toContain("Rules");
		expect(text).toContain("Never deploy from main");
		expect(text).toContain("Skill-sync");
		expect(text).toContain("deeplake-query-builder");
		// graph memory cap: the codebase graph is NO LONGER on the dashboard home (a real snapshot froze the
		// browser). It lives on its own bounded `#/graph` page; the home must not render it.
		expect(text).not.toContain("Codebase graph");
		expect(text).toContain("Live log");
		// The kit's grid container classes are present.
		expect(container.querySelector(".kpirow")).not.toBeNull();
		expect(container.querySelector(".grid2")).not.toBeNull();
		// PRD-038: the Dashboard route now reads as three ordered area landmarks.
		const areas = [...container.querySelectorAll("[data-area]")].map((el) => el.getAttribute("data-area"));
		expect(areas).toEqual(["kpi-band", "recall-area", "harness-area"]);
		// The harness strip surfaces the INSTALLED harness (claude-code), not the uninstalled (codex).
		expect(container.querySelector('[data-testid="harness-tile-claude-code"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="harness-tile-codex"]')).toBeNull();
	});

	it("recall POSTs /api/memories/recall and renders the hits with the ENGINE score", async () => {
		const mockFetch = makeMockFetch();
		await mountShell(mockFetch);
		const recallBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Recall");
		expect(recallBtn).toBeTruthy();
		await act(async () => {
			recallBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		const text = container.textContent ?? "";
		expect(text).toContain("deploy/prd-022");
		expect(text).toContain("0.42");
		expect(text).toContain("0.17");
		expect(text).not.toContain("1.00");
		expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/api/memories/recall"), expect.objectContaining({ method: "POST" }));
	});

	it("the live log shows a real /api/logs line carrying no secret", async () => {
		await mountShell(makeMockFetch());
		const text = container.textContent ?? "";
		expect(text).toContain("/api/diagnostics/kpis");
		expect(text).toContain("GET");
		for (const needle of ["token", "secret", "bearer", "authorization", "password"]) {
			expect(text.toLowerCase()).not.toContain(needle);
		}
	});
});

describe("037b AC-2/AC-3/AC-4: client-side routing — swap without reload, deep-link, unknown→Dashboard", () => {
	it("AC-2: clicking a nav item swaps the outlet to that page with NO reload", async () => {
		await mountShell(makeMockFetch());
		// On the Dashboard route the recall bar is present.
		expect(container.textContent ?? "").toContain("Recall");
		// Click the Graph nav item → the outlet swaps to the REAL PRD-041 Graph page; the recall bar is gone.
		const graphItem = container.querySelector('[data-route="/graph"]');
		await act(async () => {
			graphItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			// jsdom queues `hashchange` on a hash assignment; dispatch it so the Shell's useHashRoute
			// re-renders the outlet synchronously under act (a real browser fires it for free).
			window.dispatchEvent(new HashChangeEvent("hashchange"));
		});
		await act(async () => {
			// Flush the Graph page's fetch-on-mount (it hydrates the codebase graph from the wire).
			await Promise.resolve();
			await Promise.resolve();
		});
		const text = container.textContent ?? "";
		expect(window.location.hash).toBe("#/graph");
		// PRD-041 replaced the ComingSoon placeholder with the real Graph page. PRD-049e: with NO project
		// selected in the scope switcher, the Graph page renders its explicit needs-selection state (49e-AC-5)
		// rather than another scope's graph — so the outlet swap is proven by the Graph page's OWN content
		// (the needs-selection panel + the page title), not the project-gated source toggle.
		expect(text).not.toContain("coming soon · owned by PRD-041");
		expect(container.querySelector('[data-testid="needs-project-selection"]'), "the real Graph page is mounted (needs-selection)").not.toBeNull();
		expect(text).toContain("No project selected.");
		expect(text).not.toContain("Recall"); // the Dashboard body is no longer mounted
		// The sidebar (the nine items) is STILL mounted — only the content region swapped.
		expect(container.querySelectorAll("[data-route]")).toHaveLength(ROUTES.length);
	});

	it("AC-3: deep-linking — loading #/logs mounts the Logs route directly", async () => {
		window.location.hash = "#/logs";
		await mountShell(makeMockFetch());
		const text = container.textContent ?? "";
		// PRD-043: the Logs route now mounts the REAL Logs page (request log + turns), not a
		// placeholder — assert its distinctive surfaces (the Requests/Turns tabs + the live tail).
		expect(text).toContain("Requests");
		expect(text).toContain("Turns");
		expect(text).toContain("Live tail");
		// The Logs nav item is the single active one.
		const active = [...container.querySelectorAll('[data-active="true"]')];
		expect(active).toHaveLength(1);
		expect(active[0]?.getAttribute("data-route")).toBe("/logs");
	});

	it("AC-4: an unknown hash falls back to the Dashboard route (no blank screen)", async () => {
		window.location.hash = "#/nope";
		await mountShell(makeMockFetch());
		// The Dashboard content renders (the fallback), not a blank outlet.
		expect(container.textContent ?? "").toContain("Recall");
		const active = [...container.querySelectorAll('[data-active="true"]')];
		expect(active).toHaveLength(1);
		expect(active[0]?.getAttribute("data-route")).toBe("/");
	});
});

describe("037 AC-6 / 037b AC-6: daemon-down swaps the CONTENT for the banner; sidebar stays mounted", () => {
	it("health-fail → the content outlet shows the banner on ANY route while the sidebar persists; Retry restores", async () => {
		let healthOk = false;
		const mockFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
			const url = typeof input === "string" ? input : input.toString();
			const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
			if (url.endsWith("/health")) return new Response("", { status: healthOk ? 200 : 503 });
			if (url.includes("/api/diagnostics/settings")) return json(PAYLOADS.settings);
			if (url.includes("/api/diagnostics/kpis")) return json(PAYLOADS.kpis);
			if (url.includes("/api/diagnostics/sessions")) return json(PAYLOADS.sessions);
			if (url.includes("/api/diagnostics/rules")) return json(PAYLOADS.rules);
			if (url.includes("/api/diagnostics/skills")) return json(PAYLOADS.skills);
			if (url.includes("/api/diagnostics/harnesses")) return json(PAYLOADS.harnesses);
			if (url.includes("/api/graph")) return json(PAYLOADS.graph);
			if (url.includes("/api/logs")) return json(PAYLOADS.logs);
			// PRD-059b: a bound project so the Dashboard route renders the page (not the first-run CTA).
			if (url.includes("/api/diagnostics/scope/projects")) return json({ projects: [{ projectId: "honeycomb", name: "honeycomb", boundLocally: true }], org: "o", workspace: "w" });
			if (url.endsWith("/api/settings")) return json({ settings: {}, catalog: [] });
			if (url.endsWith("/api/secrets")) return json({ names: [] });
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;

		await mountShell(mockFetch);
		// The banner replaced the CONTENT region…
		expect(container.textContent ?? "").toContain("Daemon not reachable");
		expect(container.textContent ?? "").not.toContain("Skill-sync"); // the Dashboard body is suspended
		// …but the SIDEBAR stays mounted (the nine nav items are still there).
		expect(container.querySelectorAll("[data-route]")).toHaveLength(ROUTES.length);

		// Recover + click Retry → the active page restores.
		healthOk = true;
		const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Retry");
		expect(retry).toBeTruthy();
		await act(async () => {
			retry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		const text = container.textContent ?? "";
		expect(text).not.toContain("Daemon not reachable");
		expect(text).toContain("Skill-sync"); // the Dashboard content restored
	});
});

describe("037 AC-9 / D-5: Pollinate now POSTs the trigger from the shell chrome", () => {
	it("clicking Pollinate now POSTs /api/diagnostics/pollinate", async () => {
		const mockFetch = makeMockFetch({ pollinate: PAYLOADS.pollinateEnqueued });
		await mountShell(mockFetch);
		const pollinateBtn = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Pollinate now"));
		expect(pollinateBtn).toBeTruthy();
		await act(async () => {
			pollinateBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/api/diagnostics/pollinate"), expect.objectContaining({ method: "POST" }));
	});

	it("a skipped ack is reflected honestly — the button returns to 'Pollinate now', not a forever spinner", async () => {
		const mockFetch = makeMockFetch({ pollinate: PAYLOADS.pollinateSkipped });
		await mountShell(mockFetch);
		const pollinateBtn = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Pollinate now"));
		await act(async () => {
			pollinateBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		const btnAfter = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Pollinate"));
		expect(btnAfter?.textContent).toContain("Pollinate now");
	});
});

describe("PRD-029 D-2 (parity): the per-subsystem health strip still renders on the Dashboard route", () => {
	function reasonsFetch(reasons: unknown): typeof fetch {
		return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
			const url = typeof input === "string" ? input : input.toString();
			const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
			if (url.endsWith("/health")) return json({ status: "ok", reasons });
			if (url.includes("/api/diagnostics/settings")) return json(PAYLOADS.settings);
			if (url.includes("/api/diagnostics/kpis")) return json(PAYLOADS.kpis);
			if (url.includes("/api/diagnostics/sessions")) return json(PAYLOADS.sessions);
			if (url.includes("/api/diagnostics/rules")) return json(PAYLOADS.rules);
			if (url.includes("/api/diagnostics/skills")) return json(PAYLOADS.skills);
			if (url.includes("/api/diagnostics/harnesses")) return json(PAYLOADS.harnesses);
			if (url.includes("/api/graph")) return json(PAYLOADS.graph);
			if (url.includes("/api/logs")) return json(PAYLOADS.logs);
			// PRD-059b: a bound project so the Dashboard route renders the page (not the first-run CTA).
			if (url.includes("/api/diagnostics/scope/projects")) return json({ projects: [{ projectId: "honeycomb", name: "honeycomb", boundLocally: true }], org: "o", workspace: "w" });
			if (url.endsWith("/api/settings")) return json({ settings: {}, catalog: [] });
			if (url.endsWith("/api/secrets")) return json({ names: [] });
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;
	}

	it("a degraded subsystem renders its state in the strip on the Dashboard route", async () => {
		await mountShell(reasonsFetch({ storage: "unreachable", embeddings: "off", schema: "ok" }));
		const strip = container.querySelector('[data-testid="health-strip"]');
		expect(strip, "the health strip rendered on the Dashboard route").not.toBeNull();
		const text = strip?.textContent ?? "";
		expect(text).toContain("storage: unreachable");
		expect(text).toContain("semantic: off");
	});
});
