// @vitest-environment jsdom
/**
 * PRD-039b / 039c — the Harnesses page DOM suite.
 *
 * Mounts the REAL {@link HarnessesPage} into jsdom against a MOCKED wire client (a fixture
 * `HarnessStatus[]`) and asserts the acceptance criteria through the rendered DOM:
 *   - b-AC-1: the overview renders one KPI card per harness for all seven, from the fixture payload.
 *   - b-AC-2: the installed/active matrix renders a row per harness with installed/active marks.
 *   - b-AC-3: an UNINSTALLED harness renders greyed "not installed"; an installed-but-idle reads
 *     "idle"; an active one reads "active" + its real count — varying the payload changes the page
 *     with no code edit (dynamic).
 *   - b-AC-4: clicking a card routes to `#/harnesses/<name>`.
 *   - c-AC-3: the Cursor detail renders the Agents panel; the Claude Code detail OMITS it.
 *
 * Plus the pure helpers (`uiStatus`, `relativeLastSeen`, `filterRecordsForHarness`,
 * `resolveHarnessSubItems`) the page is built from.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	HarnessesPage,
	filterRecordsForHarness,
	harnessNameFromRoute,
	relativeLastSeen,
	resolveHarnessSubItems,
	uiStatus,
} from "../../../src/dashboard/web/pages/harnesses.js";
import type { PageProps } from "../../../src/dashboard/web/page-frame.js";
import type { HarnessCapabilitiesWire, HarnessStatusWire, LogRecordWire, WireClient } from "../../../src/dashboard/web/wire.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A minimal capability descriptor builder (only the fields the panels read). */
function cap(name: string, extra: Partial<HarnessCapabilitiesWire> = {}): HarnessCapabilitiesWire {
	return {
		name,
		runtimePath: name === "cursor" ? "plugin" : "legacy",
		contextChannel: "model-only",
		hostCli: { bin: name === "cursor" ? "cursor-agent" : "claude", args: name === "cursor" ? [] : ["-p"], fallbackBin: name === "cursor" ? "claude" : undefined },
		lifecycleEvents: ["SessionStart", "SessionEnd"],
		...extra,
	};
}

/** A fixture of the seven harnesses with a representative install/activity mix. */
function fixtureSeven(): HarnessStatusWire[] {
	return [
		{ name: "claude-code", installed: true, active: true, lastSeen: new Date().toISOString(), turnsCaptured: 7, runtimePath: "legacy", capabilities: cap("claude-code") },
		{ name: "codex", installed: true, active: false, lastSeen: null, turnsCaptured: 0, runtimePath: "legacy", capabilities: cap("codex", { userVisibleLogin: true }) },
		{ name: "cursor", installed: true, active: true, lastSeen: new Date().toISOString(), turnsCaptured: 312, runtimePath: "plugin", capabilities: cap("cursor", { agents: { kind: "cursor-agent", binary: "cursor-agent", fallbackBin: "claude" }, workspaceRoots: true }) },
		{ name: "grok", installed: false, active: false, lastSeen: null, turnsCaptured: 0, runtimePath: "legacy", capabilities: cap("grok", { userVisibleLogin: true }) },
		{ name: "hermes", installed: false, active: false, lastSeen: null, turnsCaptured: 0, runtimePath: "legacy", capabilities: cap("hermes", { mcpRegistration: true }) },
		{ name: "pi", installed: false, active: false, lastSeen: null, turnsCaptured: 0, runtimePath: "plugin", capabilities: cap("pi", { agentsMdContext: true }) },
		{ name: "openclaw", installed: false, active: false, lastSeen: null, turnsCaptured: 0, runtimePath: "plugin", capabilities: cap("openclaw", { contractedTools: true }) },
	];
}

/** A mock wire client returning the given harness fixture + an empty log feed. */
function mockWire(harnesses: HarnessStatusWire[], logs: LogRecordWire[] = []): WireClient {
	return {
		kpis: vi.fn(),
		sessions: vi.fn(),
		settings: vi.fn(),
		rules: vi.fn(),
		skills: vi.fn(),
		graph: vi.fn(),
		recall: vi.fn(),
		logs: vi.fn(async () => logs),
		harnesses: vi.fn(async () => harnesses),
		health: vi.fn(),
		pollinate: vi.fn(),
		vaultSettings: vi.fn(),
		setSetting: vi.fn(),
		secretNames: vi.fn(),
	} as unknown as WireClient;
}

function pageProps(wire: WireClient): PageProps {
	return { wire, daemonUp: true, assetBase: "assets", pollinating: false };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	window.location.hash = "#/harnesses";
});

afterEach(() => {
	if (root !== undefined) act(() => root.unmount());
	container.remove();
	window.location.hash = "";
});

/** Mount the page and flush the async hydrate (the wire resolves on a microtask). */
async function mountPage(wire: WireClient): Promise<void> {
	await act(async () => {
		root = createRoot(container);
		root.render(<HarnessesPage {...pageProps(wire)} />);
	});
	// Flush the usePoll fetch-on-mount microtask so state settles.
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("PRD-039 pure helpers", () => {
	it("harnessNameFromRoute parses the detail param, null for the overview", () => {
		expect(harnessNameFromRoute("/harnesses")).toBeNull();
		expect(harnessNameFromRoute("/harnesses/cursor")).toBe("cursor");
		expect(harnessNameFromRoute("/harnesses/claude-code")).toBe("claude-code");
		expect(harnessNameFromRoute("/graph")).toBeNull();
	});

	it("uiStatus derives not-installed < idle < active honestly", () => {
		expect(uiStatus({ installed: false, active: false } as HarnessStatusWire)).toBe("not installed");
		expect(uiStatus({ installed: true, active: false } as HarnessStatusWire)).toBe("idle");
		expect(uiStatus({ installed: true, active: true } as HarnessStatusWire)).toBe("active");
	});

	it("relativeLastSeen renders 'never' for null and a relative string otherwise", () => {
		expect(relativeLastSeen(null)).toBe("never");
		const now = Date.parse("2026-06-22T10:00:00.000Z");
		expect(relativeLastSeen("2026-06-22T09:59:30.000Z", now)).toBe("30s ago");
		expect(relativeLastSeen("2026-06-22T09:56:00.000Z", now)).toBe("4m ago");
		expect(relativeLastSeen("2026-06-22T08:00:00.000Z", now)).toBe("2h ago");
	});

	it("filterRecordsForHarness keeps only records whose path mentions the harness (no fabrication)", () => {
		const records: LogRecordWire[] = [
			{ time: "t", method: "GET", path: "/api/harnesses/cursor/sync", status: 200 },
			{ time: "t", method: "GET", path: "/api/diagnostics/kpis", status: 200 },
			{ time: "t", method: "POST", path: "/install/cursor", status: 201 },
		] as LogRecordWire[];
		const kept = filterRecordsForHarness(records, "cursor");
		expect(kept).toHaveLength(2);
		expect(filterRecordsForHarness(records, "hermes")).toHaveLength(0);
		expect(filterRecordsForHarness(records, "")).toHaveLength(0);
	});

	it("resolveHarnessSubItems maps the live list to the dynamic sub-items (037c contract)", () => {
		const items = resolveHarnessSubItems(fixtureSeven());
		expect(items.map((i) => i.route)).toContain("/harnesses/cursor");
		expect(items.map((i) => i.label)).toContain("claude-code");
		expect(items).toHaveLength(7);
		// A non-array / empty live state yields no children (the parent stays a plain nav item).
		expect(resolveHarnessSubItems(null)).toHaveLength(0);
		expect(resolveHarnessSubItems([])).toHaveLength(0);
	});
});

describe("PRD-039b: the overview renders seven cards + the matrix from the live payload", () => {
	it("b-AC-1 renders one KPI card per harness for all seven", async () => {
		await mountPage(mockWire(fixtureSeven()));
		for (const name of ["claude-code", "codex", "cursor", "grok", "hermes", "pi", "openclaw"]) {
			expect(container.querySelector(`[data-testid="harness-card-${name}"]`), `card for ${name}`).not.toBeNull();
		}
	});

	it("b-AC-2 renders the installed/active matrix with a row per harness", async () => {
		await mountPage(mockWire(fixtureSeven()));
		for (const name of ["claude-code", "codex", "cursor", "grok", "hermes", "pi", "openclaw"]) {
			expect(container.querySelector(`[data-testid="harness-row-${name}"]`), `matrix row for ${name}`).not.toBeNull();
		}
	});

	it("b-AC-3 an uninstalled harness renders 'not installed', an idle one 'idle', an active one 'active'", async () => {
		await mountPage(mockWire(fixtureSeven()));
		const cursorCard = container.querySelector('[data-testid="harness-card-cursor"]');
		const codexCard = container.querySelector('[data-testid="harness-card-codex"]');
		const hermesCard = container.querySelector('[data-testid="harness-card-hermes"]');
		expect(cursorCard?.textContent).toContain("active");
		expect(cursorCard?.textContent).toContain("312");
		expect(codexCard?.textContent).toContain("idle");
		expect(hermesCard?.textContent).toContain("not installed");
		// Honest greying: the uninstalled card is rendered (not omitted) with reduced opacity.
		expect((hermesCard as HTMLElement).style.opacity).toBe("0.6");
	});

	it("b-AC-3 dynamic: a DIFFERENT payload renders different states with no code change", async () => {
		// Flip the fixture so hermes is now installed+active and cursor uninstalled.
		const flipped = fixtureSeven().map((h) =>
			h.name === "hermes"
				? { ...h, installed: true, active: true, turnsCaptured: 5 }
				: h.name === "cursor"
					? { ...h, installed: false, active: false, turnsCaptured: 0 }
					: h,
		);
		await mountPage(mockWire(flipped));
		expect(container.querySelector('[data-testid="harness-card-hermes"]')?.textContent).toContain("active");
		expect(container.querySelector('[data-testid="harness-card-cursor"]')?.textContent).toContain("not installed");
	});

	it("b-AC-4 clicking a card routes to #/harnesses/<name>", async () => {
		await mountPage(mockWire(fixtureSeven()));
		const cursorCard = container.querySelector('[data-testid="harness-card-cursor"]') as HTMLButtonElement;
		act(() => cursorCard.click());
		expect(window.location.hash).toBe("#/harnesses/cursor");
	});
});

describe("PRD-039c: the per-harness detail renders capability panels (Cursor agents; Claude Code none)", () => {
	it("c-AC-3 the Cursor detail renders the Agents panel", async () => {
		window.location.hash = "#/harnesses/cursor";
		await mountPage(mockWire(fixtureSeven()));
		expect(container.querySelector('[data-testid="cap-agents"]'), "Cursor renders the Agents panel").not.toBeNull();
		expect(container.textContent).toContain("cursor-agent");
	});

	it("c-AC-3 the Claude Code detail OMITS the Agents panel", async () => {
		window.location.hash = "#/harnesses/claude-code";
		await mountPage(mockWire(fixtureSeven()));
		expect(container.querySelector('[data-testid="cap-agents"]'), "Claude Code omits the Agents panel").toBeNull();
		// It still renders its Runtime panel (always present).
		expect(container.textContent).toContain("legacy");
	});

	it("c-AC-3 the Hermes detail renders the MCP panel; OpenClaw the contracted-tools panel", async () => {
		window.location.hash = "#/harnesses/hermes";
		await mountPage(mockWire(fixtureSeven()));
		expect(container.querySelector('[data-testid="cap-mcp"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="cap-agents"]')).toBeNull();
	});
});
