// @vitest-environment jsdom
/**
 * PRD-024 Wave 2 — the dashboard WEB APP DOM/render suite (AC-1..AC-6 frontend).
 *
 * Mounts the real {@link App} into a jsdom document with a MOCKED `fetch` returning
 * representative WIRE payloads (the exact shapes `src/daemon/runtime/dashboard/api.ts` + the
 * recall/logs/health/dream routes serve), and asserts:
 *   AC-1  the UI-kit layout renders (header with org/workspace + Dream now, recall bar, KPI
 *         row with 4 tiles, the 2-col grid panels, the live log).
 *   AC-2  KPIs/sessions/rules/skills come from the mocked endpoints (not canned `data.js`).
 *   AC-3  the recall POST → memory cards with score + source.
 *   AC-4  a log line renders and carries NO secret.
 *   AC-5  health-fail → the ConnectivityBanner; Retry restores the view.
 *   AC-6  Dream click → POSTs `/api/diagnostics/dream` and reflects the ack.
 *
 * The app is driven through the REAL wire layer (`createWireClient({ fetchImpl })`) so the zod
 * boundary parsing is exercised; only `fetch` is mocked. No live network.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../../src/dashboard/web/app.js";
import { createWireClient } from "../../../src/dashboard/web/wire.js";

// React 18's act() environment flag — silences the "not wrapped in act(...)" warning.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The representative wire payloads (the WIRE truth, not the canned data.js). */
const PAYLOADS = {
	settings: { orgId: "org_8f3a21", orgName: "Activeloop", workspace: "deeplake-core", settings: { mode: "local", port: "3850" } },
	kpis: { memoryCount: 1284, sessionCount: 312, estimatedSavings: 2400000 },
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
	graph: {
		built: true,
		nodes: [{ id: "daemon", label: "daemon.ts", kind: "file" }],
		edges: [],
	},
	recall: {
		hits: [
			{ source: "memories", id: "deploy/prd-022", text: "We deploy from the prd-022 branch, never from main." },
			{ source: "memory", id: "auth/token-drift", text: "Heal a drifted org token before the session-start block." },
		],
		sources: ["memories", "memory"],
		degraded: true,
	},
	logs: {
		records: [{ time: "2026-06-20T14:32:08.000Z", method: "GET", path: "/api/diagnostics/kpis", status: 200 }],
		count: 1,
	},
	dreamEnqueued: { triggered: true, status: "enqueued" },
	dreamSkipped: { triggered: false, status: "skipped", reason: "disabled" },
};

/** A configurable mock fetch routing each path to its canned payload. `healthOk` toggles AC-5. */
function makeMockFetch(opts: { healthOk?: boolean; dream?: unknown } = {}): typeof fetch {
	const healthOk = opts.healthOk ?? true;
	const dream = opts.dream ?? PAYLOADS.dreamEnqueued;
	return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input.toString();
		const json = (body: unknown, status = 200): Response =>
			new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
		return new Response("not found", { status: 404 });
	}) as unknown as typeof fetch;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** Mount the App with the given mock fetch, flushing the initial async hydration. */
async function mountApp(mockFetch: typeof fetch): Promise<void> {
	const client = createWireClient({ fetchImpl: mockFetch });
	await act(async () => {
		root = createRoot(container);
		root.render(<App client={client} />);
	});
	// Flush the mount effects' microtasks (hydrate/health/logs).
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("PRD-024 AC-1: the UI-kit layout renders on the DS tokens", () => {
	it("renders the header (org/workspace + Dream now), recall bar, KPI row, grid panels, live log", async () => {
		await mountApp(makeMockFetch());
		const text = container.textContent ?? "";

		// Header — mark wordmark + org · workspace + Dream now.
		expect(text).toContain("honeycomb");
		expect(text).toContain("Activeloop");
		expect(text).toContain("deeplake-core");
		expect(text).toContain("Dream now");
		// Recall bar (the primary action button).
		expect(text).toContain("Recall");
		// The 4 KPI tiles.
		expect(text).toContain("Memories");
		expect(text).toContain("Sessions");
		expect(text).toContain("Est. savings");
		expect(text).toContain("Team skills");
		// The 2-col grid panels.
		expect(text).toContain("Rules");
		expect(text).toContain("Skill-sync");
		expect(text).toContain("Codebase graph");
		// The live log panel.
		expect(text).toContain("Live log");
		// The kit's grid container classes are present.
		expect(container.querySelector(".kpirow")).not.toBeNull();
		expect(container.querySelector(".grid2")).not.toBeNull();
	});
});

describe("PRD-024 AC-2: KPIs/sessions/rules/skills come from the LIVE endpoints (not canned)", () => {
	it("renders the mocked KPI values + session ids + rule titles + skill names", async () => {
		await mountApp(makeMockFetch());
		const text = container.textContent ?? "";
		// KPI values from the mocked /api/diagnostics/kpis (1284 → "1,284").
		expect(text).toContain("1,284");
		expect(text).toContain("312");
		// Sessions from the mocked endpoint.
		expect(text).toContain("a7f3c");
		expect(text).toContain("deeplake-core");
		// Rules + skills from their endpoints.
		expect(text).toContain("Never deploy from main");
		expect(text).toContain("deeplake-query-builder");
	});

	it("AC-2 empty states: no sessions/skills → the panel empty state, not a crash", async () => {
		const emptyFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
			const url = typeof input === "string" ? input : input.toString();
			const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
			if (url.endsWith("/health")) return new Response("", { status: 200 });
			if (url.includes("/api/diagnostics/settings")) return json(PAYLOADS.settings);
			if (url.includes("/api/diagnostics/kpis")) return json({ memoryCount: 0, sessionCount: 0, estimatedSavings: 0 });
			if (url.includes("/api/graph")) return json({ built: false, nodes: [], edges: [] });
			if (url.includes("/api/logs")) return json({ records: [], count: 0 });
			// sessions/rules/skills return empty arrays.
			return json({ sessions: [], rules: [], skills: [] });
		}) as unknown as typeof fetch;
		await mountApp(emptyFetch);
		const text = container.textContent ?? "";
		expect(text).toContain("No sessions captured yet.");
		expect(text).toContain("No skills synced.");
		// Graph not built → the kit's build prompt.
		expect(text).toContain("honeycomb graph build");
	});
});

describe("PRD-024 AC-3: Recall posts /api/memories/recall and renders memory cards", () => {
	it("clicking Recall renders the returned hits with score + source", async () => {
		const mockFetch = makeMockFetch();
		await mountApp(mockFetch);

		// Find the Recall button and click it.
		const recallBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Recall");
		expect(recallBtn, "the Recall button exists").toBeTruthy();
		await act(async () => {
			recallBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		const text = container.textContent ?? "";
		// The recalled memory keys + a derived score render as MemoryCards.
		expect(text).toContain("deploy/prd-022");
		expect(text).toContain("We deploy from the prd-022 branch");
		expect(text).toContain("1.00"); // top hit's derived score
		// The POST hit the recall endpoint.
		expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/api/memories/recall"), expect.objectContaining({ method: "POST" }));
	});
});

describe("PRD-024 AC-4: LiveLog shows real /api/logs lines with no secret", () => {
	it("renders a daemon log line carrying no token/secret", async () => {
		await mountApp(makeMockFetch());
		const text = container.textContent ?? "";
		// The mocked log record renders as a formatted line (path + method).
		expect(text).toContain("/api/diagnostics/kpis");
		expect(text).toContain("GET");
		// No secret leaked into a rendered line.
		for (const needle of ["token", "secret", "bearer", "authorization", "password"]) {
			expect(text.toLowerCase()).not.toContain(needle);
		}
	});
});

describe("PRD-024 AC-5: ConnectivityBanner on /health-down + Retry restores", () => {
	it("health-fail swaps the view for the banner; Retry re-probes and restores", async () => {
		// Start with health DOWN.
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
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;

		await mountApp(mockFetch);
		// Banner is shown (the whole view swapped).
		expect(container.textContent ?? "").toContain("Daemon not reachable");
		expect(container.textContent ?? "").not.toContain("Skill-sync");

		// Recover health, then click Retry.
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
		expect(text).toContain("Skill-sync"); // the full view restored
	});
});

describe("PRD-024 AC-6: Dream now POSTs /api/diagnostics/dream and reflects the ack", () => {
	it("an enqueued ack pulses + logs the consolidation", async () => {
		const mockFetch = makeMockFetch({ dream: PAYLOADS.dreamEnqueued });
		await mountApp(mockFetch);

		const dreamBtn = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Dream now"));
		expect(dreamBtn).toBeTruthy();
		await act(async () => {
			dreamBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		// The POST hit the Wave-1 dream endpoint.
		expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/api/diagnostics/dream"), expect.objectContaining({ method: "POST" }));
		// The ack is reflected in the live log (consolidating, not a fake forever spinner).
		expect(container.textContent ?? "").toContain("dreaming");
	});

	it("a skipped ack is reflected HONESTLY (skipped · disabled), not a fake forever-dreaming", async () => {
		const mockFetch = makeMockFetch({ dream: PAYLOADS.dreamSkipped });
		await mountApp(mockFetch);

		const dreamBtn = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Dream now"));
		await act(async () => {
			dreamBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		const text = container.textContent ?? "";
		expect(text).toContain("skipped");
		expect(text).toContain("disabled");
		// The button is NOT stuck in the dreaming state.
		const btnAfter = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Dream"));
		expect(btnAfter?.textContent).toContain("Dream now");
	});
});
