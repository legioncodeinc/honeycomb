// @vitest-environment jsdom
/**
 * PRD-038 — the zoned Dashboard HOME DOM suite.
 *
 * Mounts the REAL {@link DashboardPage} into jsdom against a MOCKED wire client and asserts the
 * three-area reorganization end-to-end:
 *   - 038a-AC-1/AC-2: three labeled area landmarks (`kpi-band`, `recall-area`, `harness-area`) present
 *     and ordered; the four headline KPIs (Memories, Turns, Est. savings, Team skills) are children of
 *     the `kpi-band` — "Turns", never "Sessions".
 *   - 038b-AC-1..AC-4: the recall bar + results live in `recall-area`; a query POSTs `/api/memories/recall`
 *     via `wire.recall` and renders MemoryCards; the empty state shows on zero hits; the PRD-029
 *     lexical-fallback badge shows on `degraded:true` and is absent on `degraded:false` (both branches).
 *   - 038c-AC-1/AC-2/AC-3: the harness strip lives in `harness-area`; chips + per-harness KPI tiles render
 *     ONLY for INSTALLED harnesses from a mocked `wire.harnesses()` (varying the payload changes which
 *     tiles appear — dynamic, no hardcoded list); a short-tail stream renders from a mocked `wire.logs`.
 *   - AC-8: no secret/token appears anywhere in the rendered home.
 *
 * Driven through a hand-rolled mock `WireClient` (only the page's data dependencies), so the suite is
 * fast and isolated; the real wire's zod boundary is exercised by the shell suite (`app.test.tsx`).
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardPage } from "../../../src/dashboard/web/pages/dashboard.js";
import type { PageProps } from "../../../src/dashboard/web/page-frame.js";
import type { HarnessStatusWire, KpisWire, LogRecordWire, RecalledMemory, WireClient } from "../../../src/dashboard/web/wire.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KPIS: KpisWire = { memoryCount: 1284, sessionCount: 312, turnCount: 312, estimatedSavings: 2400000, teamSkillCount: 5 };

/** A capability stub (only what nothing on the home reads — the strip uses name/installed/active/etc). */
const CAP = { name: "", runtimePath: "", contextChannel: "", hostCli: { bin: "", args: [] }, lifecycleEvents: [] } as const;

/** A harness row builder (the home strip reads name/installed/active/lastSeen/turnsCaptured). */
function harness(name: string, installed: boolean, active: boolean, turnsCaptured: number, lastSeen: string | null): HarnessStatusWire {
	return { name, installed, active, lastSeen, turnsCaptured, runtimePath: "legacy", capabilities: { ...CAP, name } };
}

/** A mock wire returning the given harness fixture + recall result + log feed; everything else zeroed. */
function mockWire(opts: {
	harnesses?: HarnessStatusWire[];
	recall?: { memories: RecalledMemory[]; degraded: boolean };
	logs?: LogRecordWire[];
} = {}): WireClient {
	const recall = opts.recall ?? { memories: [], degraded: false };
	return {
		kpis: vi.fn(async () => KPIS),
		sessions: vi.fn(async () => []),
		settings: vi.fn(),
		rules: vi.fn(async () => []),
		skills: vi.fn(async () => []),
		graph: vi.fn(async () => ({ built: false, nodes: [], edges: [] })),
		recall: vi.fn(async () => recall),
		logs: vi.fn(async () => opts.logs ?? []),
		harnesses: vi.fn(async () => opts.harnesses ?? []),
		health: vi.fn(async () => ({ up: true, reasons: null })),
		dream: vi.fn(),
		vaultSettings: vi.fn(async () => ({ settings: {}, catalog: [] })),
		setSetting: vi.fn(),
		secretNames: vi.fn(async () => []),
	} as unknown as WireClient;
}

function pageProps(wire: WireClient): PageProps {
	return { wire, daemonUp: true, assetBase: "assets", dreaming: false };
}

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
});

afterEach(() => {
	if (root !== undefined) act(() => root.unmount());
	root = undefined;
	container.remove();
	vi.restoreAllMocks();
});

/** Mount the page and flush the async hydrate/poll microtasks so state settles. */
async function mountPage(wire: WireClient): Promise<void> {
	await act(async () => {
		root = createRoot(container);
		root.render(<DashboardPage {...pageProps(wire)} />);
	});
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("038a: three named area landmarks, ordered, with the KPI band at the top", () => {
	it("renders kpi-band → recall-area → harness-area in that vertical order", async () => {
		await mountPage(mockWire());
		const areas = [...container.querySelectorAll("[data-area]")].map((el) => el.getAttribute("data-area"));
		expect(areas).toEqual(["kpi-band", "recall-area", "harness-area"]);
		// Each area is an addressable landmark with an aria-label.
		for (const a of ["kpi-band", "recall-area", "harness-area"]) {
			const el = container.querySelector(`[data-area="${a}"]`);
			expect(el, `area ${a} present`).not.toBeNull();
			expect(el?.getAttribute("aria-label"), `area ${a} labelled`).toBeTruthy();
		}
	});

	it("the four headline KPIs are children of the kpi-band — Turns, never Sessions", async () => {
		await mountPage(mockWire());
		const band = container.querySelector('[data-area="kpi-band"]');
		expect(band).not.toBeNull();
		const text = band?.textContent ?? "";
		for (const label of ["Memories", "Turns", "Est. savings", "Team skills"]) {
			expect(text, `${label} in band`).toContain(label);
		}
		expect(text).not.toContain("Sessions");
		// The corrected values surface (035a turnCount 312, 035b savings 2,400,000, 036c team skills 5).
		expect(text).toContain("1,284");
		expect(text).toContain("312");
		expect(text).toContain("2,400,000");
		expect(text).toContain("5");
		// The KPI band still uses the existing .kpirow grid rhythm.
		expect(band?.querySelector(".kpirow")).not.toBeNull();
	});
});

describe("038b: recall lives in the center recall-area and works end-to-end", () => {
	it("the recall bar is a child of recall-area", async () => {
		await mountPage(mockWire());
		const area = container.querySelector('[data-area="recall-area"]');
		const recallBtn = [...(area?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Recall");
		expect(recallBtn, "Recall button under recall-area").toBeTruthy();
	});

	it("submitting a query POSTs via wire.recall and renders the hits as MemoryCards in the area", async () => {
		const memories: RecalledMemory[] = [
			{ memoryKey: "deploy/prd-022", snippet: "We deploy from the prd-022 branch.", source: "memories", score: 0.42, scope: "team", verified: true, kind: "memory", secondary: false },
		];
		const wire = mockWire({ recall: { memories, degraded: false } });
		await mountPage(wire);
		const recallBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Recall");
		await act(async () => recallBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(wire.recall).toHaveBeenCalled();
		const area = container.querySelector('[data-area="recall-area"]');
		const text = area?.textContent ?? "";
		expect(text).toContain("deploy/prd-022");
		expect(text).toContain("0.42");
	});

	it("renders the empty-state line when a recall returns zero hits", async () => {
		const wire = mockWire({ recall: { memories: [], degraded: false } });
		await mountPage(wire);
		const recallBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Recall");
		await act(async () => recallBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(container.textContent ?? "").toContain("No memories matched that query.");
	});

	it("shows the PRD-029 lexical-fallback badge on degraded:true and HIDES it on degraded:false", async () => {
		// degraded:true → badge present.
		const degraded = mockWire({ recall: { memories: [], degraded: true } });
		await mountPage(degraded);
		let btn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Recall");
		await act(async () => btn?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(container.textContent ?? "").toContain("lexical fallback");
		act(() => root?.unmount());
		root = undefined;

		// degraded:false → no badge.
		const ok = mockWire({ recall: { memories: [], degraded: false } });
		await mountPage(ok);
		btn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Recall");
		await act(async () => btn?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(container.textContent ?? "").not.toContain("lexical fallback");
	});
});

describe("038c: the harness strip renders dynamically from wire.harnesses() — installed only", () => {
	it("renders a chip + a KPI tile ONLY for installed harnesses; uninstalled render neither", async () => {
		const fixture = [
			harness("claude-code", true, true, 7, new Date().toISOString()),
			harness("cursor", true, false, 0, null),
			harness("codex", false, false, 0, null), // not installed → no chip/tile
			harness("hermes", false, false, 0, null), // not installed → no chip/tile
		];
		await mountPage(mockWire({ harnesses: fixture }));
		const area = container.querySelector('[data-area="harness-area"]');
		expect(area).not.toBeNull();
		// Chips + tiles for the two installed harnesses…
		expect(area?.querySelector('[data-testid="harness-chip-claude-code"]')).not.toBeNull();
		expect(area?.querySelector('[data-testid="harness-chip-cursor"]')).not.toBeNull();
		expect(area?.querySelector('[data-testid="harness-tile-claude-code"]')).not.toBeNull();
		expect(area?.querySelector('[data-testid="harness-tile-cursor"]')).not.toBeNull();
		// …and NONE for the uninstalled ones.
		expect(area?.querySelector('[data-testid="harness-chip-codex"]')).toBeNull();
		expect(area?.querySelector('[data-testid="harness-tile-codex"]')).toBeNull();
		expect(area?.querySelector('[data-testid="harness-chip-hermes"]')).toBeNull();
		expect(area?.querySelector('[data-testid="harness-tile-hermes"]')).toBeNull();
		// The installed turns-captured value surfaces on the tile.
		expect(area?.querySelector('[data-testid="harness-tile-claude-code"]')?.textContent).toContain("7");
	});

	it("a DIFFERENT installed set yields a DIFFERENT set of tiles (dynamic, no hardcoded list)", async () => {
		// Only codex installed this time — the previous fixture's harnesses must NOT appear.
		await mountPage(mockWire({ harnesses: [harness("codex", true, true, 99, new Date().toISOString())] }));
		const tiles = [...container.querySelectorAll('[data-testid^="harness-tile-"]')].map((el) => el.getAttribute("data-harness"));
		expect(tiles).toEqual(["codex"]);
		expect(container.querySelector('[data-testid="harness-tile-claude-code"]')).toBeNull();
	});

	it("renders the empty wired-in state when nothing is installed", async () => {
		await mountPage(mockWire({ harnesses: [harness("pi", false, false, 0, null)] }));
		const area = container.querySelector('[data-area="harness-area"]');
		expect(area?.textContent ?? "").toContain("No harnesses wired in yet.");
		expect(area?.querySelectorAll('[data-testid^="harness-tile-"]')).toHaveLength(0);
	});

	it("renders the short-tail live stream from a mocked wire.logs", async () => {
		const logs: LogRecordWire[] = [
			{ time: "2026-06-20T14:32:08.000Z", method: "GET", path: "/api/diagnostics/kpis", status: 200 },
		];
		await mountPage(mockWire({ harnesses: [harness("claude-code", true, true, 1, new Date().toISOString())], logs }));
		const area = container.querySelector('[data-area="harness-area"]');
		const text = area?.textContent ?? "";
		expect(text).toContain("/api/diagnostics/kpis");
		expect(text).toContain("GET");
	});
});

describe("AC-8: no secret/token leaks into the zoned home", () => {
	it("no token/secret/bearer/authorization/password appears anywhere on the page", async () => {
		const memories: RecalledMemory[] = [
			{ memoryKey: "m1", snippet: "a recalled snippet", source: "memories", score: 0.5, scope: "team", verified: true, kind: "memory", secondary: false },
		];
		const logs: LogRecordWire[] = [{ time: "2026-06-20T14:32:08.000Z", method: "GET", path: "/api/logs", status: 200 }];
		const wire = mockWire({
			harnesses: [harness("claude-code", true, true, 7, new Date().toISOString())],
			recall: { memories, degraded: true },
			logs,
		});
		await mountPage(wire);
		const recallBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Recall");
		await act(async () => recallBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		const text = (container.textContent ?? "").toLowerCase();
		for (const needle of ["token", "secret", "bearer", "authorization", "password"]) {
			expect(text).not.toContain(needle);
		}
	});
});
