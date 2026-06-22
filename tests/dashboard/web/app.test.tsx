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
	dreamEnqueued: { triggered: true, status: "enqueued" },
	dreamSkipped: { triggered: false, status: "skipped", reason: "disabled" },
};

/** A configurable mock fetch routing each path to its canned payload. `healthOk` toggles the down-swap. */
function makeMockFetch(opts: { healthOk?: boolean; dream?: unknown } = {}): typeof fetch {
	const healthOk = opts.healthOk ?? true;
	const dream = opts.dream ?? PAYLOADS.dreamEnqueued;
	return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input.toString();
		const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		if (url.endsWith("/health")) return new Response("", { status: healthOk ? 200 : 503 });
		if (url.includes("/api/diagnostics/kpis")) return json(PAYLOADS.kpis);
		if (url.includes("/api/diagnostics/sessions")) return json(PAYLOADS.sessions);
		if (url.includes("/api/diagnostics/settings")) return json(PAYLOADS.settings);
		if (url.includes("/api/diagnostics/rules")) return json(PAYLOADS.rules);
		if (url.includes("/api/diagnostics/skills")) return json(PAYLOADS.skills);
		if (url.includes("/api/diagnostics/dream")) return json(dream, 202);
		if (url.includes("/api/graph")) return json(PAYLOADS.graph);
		if (url.includes("/api/memories/recall")) {
			expect(init?.method, "recall is a POST").toBe("POST");
			return json(PAYLOADS.recall);
		}
		if (url.includes("/api/logs")) return json(PAYLOADS.logs);
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
	it("renders the sidebar (mark, wordmark, seven items) + the Dream now action", async () => {
		await mountShell(makeMockFetch());
		const text = container.textContent ?? "";
		// Brand chrome + the seven nav items.
		expect(text).toContain("honeycomb");
		for (const label of ["Dashboard", "Harnesses", "Memories", "Graph", "Sync", "Logs", "Settings"]) {
			expect(text).toContain(label);
		}
		// The org/workspace identity + the relocated Dream now live in the shell chrome.
		expect(text).toContain("Activeloop");
		expect(text).toContain("deeplake-core");
		expect(text).toContain("Dream now");
		// The seven nav items are present as routes.
		expect(container.querySelectorAll("[data-route]")).toHaveLength(7);
	});
});

describe("037b AC-5: Dashboard route parity — the monolithic content renders intact on '/'", () => {
	it("renders KPIs/recall/sessions/rules/skills/graph/live-log on the default Dashboard route", async () => {
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
		expect(text).toContain("Codebase graph");
		expect(text).toContain("Live log");
		// The kit's grid container classes are present.
		expect(container.querySelector(".kpirow")).not.toBeNull();
		expect(container.querySelector(".grid2")).not.toBeNull();
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
		// Click the Graph nav item → the outlet swaps to the Graph placeholder; the recall bar is gone.
		const graphItem = container.querySelector('[data-route="/graph"]');
		await act(async () => {
			graphItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			// jsdom queues `hashchange` on a hash assignment; dispatch it so the Shell's useHashRoute
			// re-renders the outlet synchronously under act (a real browser fires it for free).
			window.dispatchEvent(new HashChangeEvent("hashchange"));
		});
		await act(async () => {
			await Promise.resolve();
		});
		const text = container.textContent ?? "";
		expect(window.location.hash).toBe("#/graph");
		expect(text).toContain("coming soon · owned by PRD-041"); // the Graph placeholder content
		expect(text).not.toContain("Recall"); // the Dashboard body is no longer mounted
		// The sidebar (the seven items) is STILL mounted — only the content region swapped.
		expect(container.querySelectorAll("[data-route]")).toHaveLength(7);
	});

	it("AC-3: deep-linking — loading #/logs mounts the Logs route directly", async () => {
		window.location.hash = "#/logs";
		await mountShell(makeMockFetch());
		const text = container.textContent ?? "";
		expect(text).toContain("coming soon · owned by PRD-043"); // the Logs placeholder
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
			if (url.includes("/api/graph")) return json(PAYLOADS.graph);
			if (url.includes("/api/logs")) return json(PAYLOADS.logs);
			if (url.endsWith("/api/settings")) return json({ settings: {}, catalog: [] });
			if (url.endsWith("/api/secrets")) return json({ names: [] });
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;

		await mountShell(mockFetch);
		// The banner replaced the CONTENT region…
		expect(container.textContent ?? "").toContain("Daemon not reachable");
		expect(container.textContent ?? "").not.toContain("Skill-sync"); // the Dashboard body is suspended
		// …but the SIDEBAR stays mounted (the seven nav items are still there).
		expect(container.querySelectorAll("[data-route]")).toHaveLength(7);

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

describe("037 AC-9 / D-5: Dream now POSTs the trigger from the shell chrome", () => {
	it("clicking Dream now POSTs /api/diagnostics/dream", async () => {
		const mockFetch = makeMockFetch({ dream: PAYLOADS.dreamEnqueued });
		await mountShell(mockFetch);
		const dreamBtn = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Dream now"));
		expect(dreamBtn).toBeTruthy();
		await act(async () => {
			dreamBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/api/diagnostics/dream"), expect.objectContaining({ method: "POST" }));
	});

	it("a skipped ack is reflected honestly — the button returns to 'Dream now', not a forever spinner", async () => {
		const mockFetch = makeMockFetch({ dream: PAYLOADS.dreamSkipped });
		await mountShell(mockFetch);
		const dreamBtn = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Dream now"));
		await act(async () => {
			dreamBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		const btnAfter = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Dream"));
		expect(btnAfter?.textContent).toContain("Dream now");
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
			if (url.includes("/api/graph")) return json(PAYLOADS.graph);
			if (url.includes("/api/logs")) return json(PAYLOADS.logs);
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
