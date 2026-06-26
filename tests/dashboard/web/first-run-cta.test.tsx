// @vitest-environment jsdom
/**
 * PRD-059b — the FIRST-RUN "pick a folder to start" CTA DOM suite (b-AC-1 / b-AC-4 / M-AC-2).
 *
 * Mounts the REAL {@link FirstRunBindCTA} against a MOCKED `WireClient` and proves:
 *   b-AC-1 — the CTA renders the "No active projects? Pick a folder to start" prompt with instruction.
 *   b-AC-4 — picking + binding a folder routes the dashboard to the Projects page (the `navigate` spy
 *            is called with the Projects route).
 *
 * The Shell-level gating (zero bound projects → the CTA is the primary Dashboard content) is exercised
 * by the app shell suite (app.test.tsx feeds a bound project so the page renders; the absence of a bound
 * project flips the gate). This suite proves the CTA component's own contract in isolation.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FirstRunBindCTA } from "../../../src/dashboard/web/needs-project.js";
import { PROJECTS_ROUTE } from "../../../src/dashboard/web/registry.js";
import type { BindAckWire, BrowseBodyWire, WireClient } from "../../../src/dashboard/web/wire.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function browse(over: Partial<BrowseBodyWire> = {}): BrowseBodyWire {
	return { path: "/home/me/repo", root: "/home/me", parent: "/home/me", children: [], ...over };
}

function mockWire(): WireClient {
	return {
		fsBrowse: vi.fn(async () => browse()),
		bindProject: vi.fn(async (): Promise<BindAckWire> => ({ bound: true, path: "/home/me/repo", projectId: "repo" })),
	} as unknown as WireClient;
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

async function flush(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 10; i += 1) await Promise.resolve();
	});
}

async function mount(wire: WireClient, navigate: (r: string) => void): Promise<void> {
	await act(async () => {
		root = createRoot(container);
		root.render(<FirstRunBindCTA wire={wire} navigate={navigate} />);
	});
	await flush();
}

function click(testId: string): void {
	const el = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
	if (el === null) throw new Error(`element ${testId} not found`);
	act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("PRD-059b the first-run CTA (b-AC-1)", () => {
	it("renders the 'No active projects? Pick a folder to start' prompt with instruction", async () => {
		await mount(mockWire(), vi.fn());
		const cta = container.querySelector('[data-testid="first-run-bind"]');
		expect(cta, "the first-run CTA renders").not.toBeNull();
		const text = cta?.textContent ?? "";
		expect(text).toContain("No active projects?");
		expect(text).toContain("Pick a folder to start");
		expect(container.querySelector('[data-testid="first-run-pick"]'), "the pick button is present").not.toBeNull();
	});

	it("clicking the pick button reveals the daemon-served folder picker", async () => {
		await mount(mockWire(), vi.fn());
		click("first-run-pick");
		await flush();
		expect(container.querySelector('[data-testid="folder-picker"]'), "the picker is revealed").not.toBeNull();
	});
});

describe("PRD-059b a successful bind advances to the Projects page (b-AC-4)", () => {
	it("picking + binding a folder navigates to the Projects route", async () => {
		const navigate = vi.fn();
		const wire = mockWire();
		await mount(wire, navigate);
		click("first-run-pick");
		await flush();
		// Select the browsed folder, then bind.
		click("select-current");
		await flush();
		click("picker-bind");
		await flush();
		expect(wire.bindProject).toHaveBeenCalled();
		expect(navigate).toHaveBeenCalledWith(PROJECTS_ROUTE);
	});
});
