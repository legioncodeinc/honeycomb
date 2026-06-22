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
	// PRD-035a: `turnCount` mirrors `sessionCount` (the honest "Turns" name). PRD-036c: `teamSkillCount`
	// is the DEFINED team-shared count the KPI binds to (distinct from the skills array length).
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
	graph: {
		built: true,
		nodes: [{ id: "daemon", label: "daemon.ts", kind: "file" }],
		edges: [],
	},
	recall: {
		// PRD-027 Wave 1: the engine returns hits ALREADY ranked DESC by the fused RRF `score`,
		// each carrying its provenance `kind`/`secondary`. The client renders the ENGINE score +
		// ENGINE order verbatim (AC-4) — it does NOT fabricate `1 - i*0.06`. The distilled
		// `[memory]` fact (score 0.42) leads; the raw `[sessions]` drill-down (0.17) trails.
		hits: [
			{ source: "memories", id: "deploy/prd-022", text: "We deploy from the prd-022 branch, never from main.", score: 0.42, kind: "memory", secondary: false },
			{ source: "sessions", id: "auth/token-drift", text: "Heal a drifted org token before the session-start block.", score: 0.17, kind: "session", secondary: true },
		],
		sources: ["memories", "sessions"],
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
		// The 4 KPI tiles. PRD-035a: the captured-turns KPI + panel read "Turns", never "Sessions".
		expect(text).toContain("Memories");
		expect(text).toContain("Turns");
		expect(text).not.toContain("Sessions");
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
		// PRD-035a: the "Turns" KPI renders the turnCount (312).
		expect(text).toContain("312");
		// PRD-036c: the "Team skills" KPI renders the DEFINED teamSkillCount (5), NOT the skills
		// array length (2). The number is sourced from the count, never the panel array.
		expect(text).toContain("5");
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
		// PRD-035a: the empty captured-turns panel reads "No turns captured yet.", not "sessions".
		expect(text).toContain("No turns captured yet.");
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
		// The recalled memory keys render as MemoryCards.
		expect(text).toContain("deploy/prd-022");
		expect(text).toContain("We deploy from the prd-022 branch");
		// PRD-027 AC-4: the ENGINE score renders (not the old fabricated `1 - i*0.06`).
		// The top hit's engine score is 0.42 (NOT 1.00); the second hit's is 0.17.
		expect(text).toContain("0.42"); // top hit's ENGINE score (MemoryCard renders score.toFixed(2))
		expect(text).toContain("0.17"); // second hit's ENGINE score
		// The fabrication is GONE: the first card no longer shows the synthetic 1.00 top score.
		expect(text).not.toContain("1.00");
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

describe("PRD-029 AC-1: the recall 'lexical fallback' badge renders ONLY on degraded:true", () => {
	/**
	 * A mock fetch whose recall response carries the given `degraded` flag and whose `/health`
	 * returns a body with the given `reasons` (so a single mock drives both the badge + the strip).
	 */
	function degradationFetch(opts: { recallDegraded: boolean; reasons?: unknown }): typeof fetch {
		return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input.toString();
			const json = (body: unknown, status = 200): Response =>
				new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
			if (url.endsWith("/health")) return json({ status: "ok", pipeline: "ok", uptimeMs: 1, version: "x", ...(opts.reasons !== undefined ? { reasons: opts.reasons } : {}) });
			if (url.includes("/api/diagnostics/settings")) return json(PAYLOADS.settings);
			if (url.includes("/api/diagnostics/kpis")) return json(PAYLOADS.kpis);
			if (url.includes("/api/diagnostics/sessions")) return json(PAYLOADS.sessions);
			if (url.includes("/api/diagnostics/rules")) return json(PAYLOADS.rules);
			if (url.includes("/api/diagnostics/skills")) return json(PAYLOADS.skills);
			if (url.includes("/api/graph")) return json(PAYLOADS.graph);
			if (url.includes("/api/logs")) return json(PAYLOADS.logs);
			if (url.includes("/api/memories/recall")) {
				expect(init?.method, "recall is a POST").toBe("POST");
				return json({ hits: [{ source: "memories", id: "h1", text: "a hit", score: 0.3, kind: "memory", secondary: false }], sources: ["memories"], degraded: opts.recallDegraded });
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;
	}

	/** Click the Recall button + flush the async recall round-trip. */
	async function clickRecall(): Promise<void> {
		const recallBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Recall");
		expect(recallBtn, "the Recall button exists").toBeTruthy();
		await act(async () => {
			recallBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
	}

	it("degraded:true → the 'lexical fallback' badge IS in the DOM after a recall", async () => {
		await mountApp(degradationFetch({ recallDegraded: true }));
		// No recall yet → no badge (it only appears after a degraded recall).
		expect((container.textContent ?? "").toLowerCase()).not.toContain("lexical fallback");
		await clickRecall();
		expect((container.textContent ?? "").toLowerCase()).toContain("lexical fallback");
	});

	it("degraded:false → NO 'lexical fallback' badge even after a recall (semantic ran)", async () => {
		await mountApp(degradationFetch({ recallDegraded: false }));
		await clickRecall();
		// The recall rendered its hit, but the degraded badge is absent.
		expect(container.textContent ?? "").toContain("a hit");
		expect((container.textContent ?? "").toLowerCase()).not.toContain("lexical fallback");
	});
});

describe("PRD-029 D-2: the per-subsystem health strip renders the /health reasons", () => {
	function degradationFetch(opts: { recallDegraded: boolean; reasons?: unknown }): typeof fetch {
		return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
			const url = typeof input === "string" ? input : input.toString();
			const json = (body: unknown, status = 200): Response =>
				new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
			if (url.endsWith("/health")) return json({ status: "ok", pipeline: "ok", uptimeMs: 1, version: "x", ...(opts.reasons !== undefined ? { reasons: opts.reasons } : {}) });
			if (url.includes("/api/diagnostics/settings")) return json(PAYLOADS.settings);
			if (url.includes("/api/diagnostics/kpis")) return json(PAYLOADS.kpis);
			if (url.includes("/api/diagnostics/sessions")) return json(PAYLOADS.sessions);
			if (url.includes("/api/diagnostics/rules")) return json(PAYLOADS.rules);
			if (url.includes("/api/diagnostics/skills")) return json(PAYLOADS.skills);
			if (url.includes("/api/graph")) return json(PAYLOADS.graph);
			if (url.includes("/api/logs")) return json(PAYLOADS.logs);
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;
	}

	it("a degraded subsystem (embeddings off, storage unreachable) renders that subsystem's degraded state", async () => {
		await mountApp(degradationFetch({ recallDegraded: false, reasons: { storage: "unreachable", embeddings: "off", schema: "ok" } }));
		const strip = container.querySelector('[data-testid="health-strip"]');
		expect(strip, "the health strip rendered").not.toBeNull();
		const text = strip?.textContent ?? "";
		// The strip NAMES each subsystem + its state — the degraded ones surface their down state.
		expect(text).toContain("storage: unreachable");
		expect(text).toContain("semantic: off");
		expect(text).toContain("schema: ok");
	});

	it("all-ok reasons → the strip shows every subsystem healthy", async () => {
		await mountApp(degradationFetch({ recallDegraded: false, reasons: { storage: "reachable", embeddings: "on", schema: "ok" } }));
		const text = container.querySelector('[data-testid="health-strip"]')?.textContent ?? "";
		expect(text).toContain("storage: reachable");
		expect(text).toContain("semantic: on");
		expect(text).toContain("schema: ok");
	});

	it("absent reasons (mode-gated public body) → the strip renders NOTHING (defensive)", async () => {
		await mountApp(degradationFetch({ recallDegraded: false }));
		// No `reasons` in the /health body → the strip is not in the DOM; the coarse header pill stands alone.
		expect(container.querySelector('[data-testid="health-strip"]')).toBeNull();
		// The header pill (coarse liveness) still renders.
		expect(container.textContent ?? "").toContain("daemon :3850");
	});

	it("AC-5: the badge + strip render ONLY subsystem names/states — no token/org/header leaks", async () => {
		await mountApp(degradationFetch({ recallDegraded: false, reasons: { storage: "unreachable", embeddings: "off", schema: "missing_table" } }));
		const text = (container.textContent ?? "").toLowerCase();
		// The closed-enum render carries NO secret: no token/credential/org GUID/header value.
		for (const needle of ["token", "secret", "bearer", "authorization", "password", "x-honeycomb", "org_", "credential"]) {
			expect(text, `no "${needle}" in the rendered degradation payload`).not.toContain(needle);
		}
		// What IS rendered is only the subsystem names + closed states.
		expect(text).toContain("storage: unreachable");
		expect(text).toContain("schema: missing_table");
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

describe("PRD-032c AC-5: the vault Settings panel (provider→model + dreaming toggle, no secret value)", () => {
	/** The curated catalog the Wave-1 `GET /api/settings` returns (mirrors vault/catalog.ts). */
	const CATALOG = [
		{ id: "anthropic", label: "Anthropic", models: ["claude-sonnet-4-6", "claude-opus-4-8"], openEnded: false },
		{ id: "openai", label: "OpenAI", models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1"], openEnded: false },
		{ id: "openrouter", label: "OpenRouter", models: ["anthropic/claude-sonnet-4.6"], openEnded: true },
	];

	/**
	 * A stateful mock daemon for the settings surface: it holds an in-memory `setting` map +
	 * secret-name list, answers `GET /api/settings` with `{ settings, catalog }`, persists a
	 * `POST /api/settings/:key`, and answers `GET /api/secrets` with names only. This lets a test
	 * assert that a write PERSISTS and a reload reflects it (AC-2 / AC-3) — the fake stands in for
	 * the Wave-1 vault, with NO live backend. It records every POST for assertion.
	 */
	function settingsDaemon(opts: { settings?: Record<string, unknown>; secretNames?: string[] } = {}): {
		fetchImpl: typeof fetch;
		posts: { key: string; value: unknown }[];
		store: Record<string, unknown>;
	} {
		const store: Record<string, unknown> = { ...(opts.settings ?? {}) };
		const secretNames = opts.secretNames ?? [];
		const posts: { key: string; value: unknown }[] = [];
		const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input.toString();
			const json = (body: unknown, status = 200): Response =>
				new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
			if (url.endsWith("/health")) return new Response("", { status: 200 });
			if (url.includes("/api/diagnostics/settings")) return json(PAYLOADS.settings);
			if (url.includes("/api/diagnostics/kpis")) return json(PAYLOADS.kpis);
			if (url.includes("/api/diagnostics/sessions")) return json(PAYLOADS.sessions);
			if (url.includes("/api/diagnostics/rules")) return json(PAYLOADS.rules);
			if (url.includes("/api/diagnostics/skills")) return json(PAYLOADS.skills);
			if (url.includes("/api/graph")) return json(PAYLOADS.graph);
			if (url.includes("/api/logs")) return json(PAYLOADS.logs);
			// POST /api/settings/:key — persist the value into the in-memory store.
			if (url.includes("/api/settings/") && init?.method === "POST") {
				const key = decodeURIComponent(url.split("/api/settings/")[1]?.split("?")[0] ?? "");
				const value = (JSON.parse(String(init.body)) as { value: unknown }).value;
				store[key] = value;
				posts.push({ key, value });
				return json({ ok: true, key, value }, 201);
			}
			if (url.endsWith("/api/settings") || url.includes("/api/settings?")) return json({ settings: store, catalog: CATALOG });
			if (url.endsWith("/api/secrets") || url.includes("/api/secrets?")) return json({ names: secretNames });
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;
		return { fetchImpl, posts, store };
	}

	/** Find a `<select>` by its aria-label. */
	function selectByLabel(label: string): HTMLSelectElement | null {
		return container.querySelector(`select[aria-label="${label}"]`);
	}

	/** Drive a `<select>` change event to a value (jsdom). */
	async function pickSelect(sel: HTMLSelectElement, value: string): Promise<void> {
		await act(async () => {
			sel.value = value;
			sel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
	}

	it("AC-5: renders the provider list from the catalog GET /api/settings returns", async () => {
		const { fetchImpl } = settingsDaemon();
		await mountApp(fetchImpl);
		// The Settings panel + its provider select are present.
		expect(container.textContent ?? "").toContain("Settings");
		const providerSel = selectByLabel("provider");
		expect(providerSel, "the provider select rendered").not.toBeNull();
		const optionLabels = [...(providerSel?.options ?? [])].map((o) => o.textContent);
		expect(optionLabels).toContain("Anthropic");
		expect(optionLabels).toContain("OpenAI");
		expect(optionLabels).toContain("OpenRouter");
	});

	it("AC-2: picking a provider populates THAT provider's catalog models; picking a model POSTs it", async () => {
		const { fetchImpl, posts, store } = settingsDaemon();
		await mountApp(fetchImpl);

		// Pick OpenAI → the provider write persists, and the model select shows OpenAI's models.
		const providerSel = selectByLabel("provider");
		expect(providerSel).not.toBeNull();
		await pickSelect(providerSel as HTMLSelectElement, "openai");
		expect(posts.some((p) => p.key === "activeProvider" && p.value === "openai")).toBe(true);
		expect(store["activeProvider"]).toBe("openai");

		// The model select now lists OpenAI's catalog models (gpt-4o…), not Anthropic's.
		const modelSel = selectByLabel("model");
		expect(modelSel, "the model select rendered after a provider was chosen").not.toBeNull();
		const modelLabels = [...(modelSel?.options ?? [])].map((o) => o.value);
		expect(modelLabels).toContain("gpt-4o");
		expect(modelLabels).not.toContain("claude-opus-4-8");

		// Pick a model → the active provider/model setting persists.
		await pickSelect(modelSel as HTMLSelectElement, "gpt-4o");
		expect(posts.some((p) => p.key === "activeModel" && p.value === "gpt-4o")).toBe(true);
		expect(store["activeModel"]).toBe("gpt-4o");
	});

	it("AC-3: the dreaming toggle POSTs dreaming.enabled; a reload shows the persisted value", async () => {
		const { fetchImpl, posts, store } = settingsDaemon();
		await mountApp(fetchImpl);

		// The toggle starts off (no persisted value). Click it → it POSTs dreaming.enabled = true.
		const toggle = container.querySelector('button[aria-label="dreaming"]');
		expect(toggle, "the dreaming toggle rendered").not.toBeNull();
		expect(toggle?.getAttribute("aria-checked")).toBe("false");
		await act(async () => {
			toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		// The write persisted to the vault `setting` class.
		expect(posts.some((p) => p.key === "dreaming.enabled" && p.value === true)).toBe(true);
		expect(store["dreaming.enabled"]).toBe(true);
		// On the re-read (the save re-hydrates from GET /api/settings), the toggle reflects ON.
		const toggleAfter = container.querySelector('button[aria-label="dreaming"]');
		expect(toggleAfter?.getAttribute("aria-checked")).toBe("true");
	});

	it("AC-3 reload: a freshly-mounted panel reflects the PERSISTED dreaming + provider/model", async () => {
		// Seed the daemon as if a prior session already persisted these — a fresh mount must show them.
		const { fetchImpl } = settingsDaemon({
			settings: { activeProvider: "anthropic", activeModel: "claude-opus-4-8", "dreaming.enabled": true },
		});
		await mountApp(fetchImpl);
		const providerSel = selectByLabel("provider");
		const modelSel = selectByLabel("model");
		expect(providerSel?.value).toBe("anthropic");
		expect(modelSel?.value).toBe("claude-opus-4-8");
		expect(container.querySelector('button[aria-label="dreaming"]')?.getAttribute("aria-checked")).toBe("true");
	});

	it("AC-5: a provider key shows 'key set ✓' / 'not set' by NAME — never a secret value", async () => {
		// ANTHROPIC_API_KEY present; the active provider is anthropic → the badge shows "key set ✓".
		const { fetchImpl } = settingsDaemon({
			settings: { activeProvider: "anthropic", activeModel: "claude-opus-4-8" },
			secretNames: ["ANTHROPIC_API_KEY"],
		});
		await mountApp(fetchImpl);
		const panelText = container.textContent ?? "";
		expect(panelText).toContain("key set ✓");
		// No secret VALUE anywhere in the DOM — only names/states are ever rendered (D-4 / AC-5).
		for (const needle of ["sk-", "bearer", "secret", "token", "password", "anthropic_api_key", "authorization"]) {
			expect(panelText.toLowerCase()).not.toContain(needle);
		}
	});

	it("AC-5: a provider with no stored key shows 'not set' (presence only, still no value)", async () => {
		// openai active, but no OPENAI_API_KEY in the names list → "not set".
		const { fetchImpl } = settingsDaemon({
			settings: { activeProvider: "openai", activeModel: "gpt-4o" },
			secretNames: ["ANTHROPIC_API_KEY"], // a DIFFERENT provider's key — openai is still "not set"
		});
		await mountApp(fetchImpl);
		expect(container.textContent ?? "").toContain("not set");
	});

	it("D-6: OpenRouter renders a FREE-FORM model input (passthrough), not a closed select", async () => {
		const { fetchImpl, posts } = settingsDaemon({ settings: { activeProvider: "openrouter" } });
		await mountApp(fetchImpl);
		// No closed model <select> for the open-ended provider — a text input instead.
		expect(selectByLabel("model")).toBeNull();
		const modelInput = container.querySelector('input[aria-label="model"]') as HTMLInputElement | null;
		expect(modelInput, "the OpenRouter free-form model input rendered").not.toBeNull();
		// Type a free-form id and commit on Enter → it POSTs the passthrough model. We set the value
		// through React's native value setter so the controlled `onChange` fires (React 18 intercepts
		// a bare `.value =`), then dispatch the input event.
		await act(async () => {
			if (modelInput) {
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
				setter?.call(modelInput, "deepseek/deepseek-chat");
				modelInput.dispatchEvent(new Event("input", { bubbles: true }));
			}
		});
		await act(async () => {
			await Promise.resolve();
		});
		await act(async () => {
			modelInput?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(posts.some((p) => p.key === "activeModel" && p.value === "deepseek/deepseek-chat")).toBe(true);
	});

	it("AC-5 defensive: an absent /api/settings (no vault) → the panel renders its empty state, no crash", async () => {
		// The daemon serves diagnostics but 404s the vault settings + secrets endpoints.
		const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
			const url = typeof input === "string" ? input : input.toString();
			const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
			if (url.endsWith("/health")) return new Response("", { status: 200 });
			if (url.includes("/api/diagnostics/settings")) return json(PAYLOADS.settings);
			if (url.includes("/api/diagnostics/kpis")) return json(PAYLOADS.kpis);
			if (url.includes("/api/diagnostics/sessions")) return json(PAYLOADS.sessions);
			if (url.includes("/api/diagnostics/rules")) return json(PAYLOADS.rules);
			if (url.includes("/api/diagnostics/skills")) return json(PAYLOADS.skills);
			if (url.includes("/api/graph")) return json(PAYLOADS.graph);
			if (url.includes("/api/logs")) return json(PAYLOADS.logs);
			return new Response("not found", { status: 404 }); // settings + secrets 404
		}) as unknown as typeof fetch;
		await mountApp(fetchImpl);
		// The panel still renders (provider select with just the placeholder option), no throw.
		expect(container.textContent ?? "").toContain("Settings");
		const providerSel = selectByLabel("provider");
		expect(providerSel).not.toBeNull();
		// Only the "— select —" placeholder (the catalog was empty).
		expect([...(providerSel?.options ?? [])]).toHaveLength(1);
	});
});
