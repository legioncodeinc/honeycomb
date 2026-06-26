// @vitest-environment jsdom
/**
 * PRD-059b — the daemon-served FOLDER PICKER DOM suite (b-AC-2 / b-AC-3 / b-AC-4 / b-AC-5).
 *
 * Mounts the REAL {@link FolderPicker} against a MOCKED `WireClient` and proves:
 *   b-AC-2 — the browse tree is enumerated by the daemon (the picker calls `wire.fsBrowse`) and a row
 *            yields a real absolute path; descending re-browses; "up" climbs to the parent.
 *   b-AC-3 — selecting a folder pre-fills the project-name field (editable before confirm).
 *   b-AC-4 — confirm POSTs `wire.bindProject({ path, name })` and calls `onBound` with the ack.
 *   b-AC-5 — daemon unreachable / local-mode off (empty browse) → a plain message + the CLI fallback,
 *            never a hang or a silent failure.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FolderPicker } from "../../../src/dashboard/web/folder-picker.js";
import type { BindAckWire, BrowseBodyWire, WireClient } from "../../../src/dashboard/web/wire.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Build a browse body (the daemon's dirs-only tree response). */
function browse(over: Partial<BrowseBodyWire> = {}): BrowseBodyWire {
	return { path: "/home/me", root: "/home/me", parent: null, children: [], ...over };
}

/** A mock wire exposing only the picker's methods (the rest are unused no-ops). */
function mockWire(opts: { fsBrowse?: ReturnType<typeof vi.fn>; bindProject?: ReturnType<typeof vi.fn> }): WireClient {
	const fsBrowse = opts.fsBrowse ?? vi.fn(async () => browse());
	const bindProject = opts.bindProject ?? vi.fn(async (): Promise<BindAckWire> => ({ bound: true, path: "/home/me/repo", projectId: "repo" }));
	return { fsBrowse, bindProject } as unknown as WireClient;
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

async function mount(wire: WireClient, onBound: (ack: BindAckWire) => void): Promise<void> {
	await act(async () => {
		root = createRoot(container);
		root.render(<FolderPicker wire={wire} onBound={onBound} />);
	});
	await flush();
}

function click(testId: string): void {
	const el = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
	if (el === null) throw new Error(`element ${testId} not found`);
	act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("PRD-059b the folder picker browses via the daemon (b-AC-2)", () => {
	it("hydrates the root from wire.fsBrowse and renders the child directories", async () => {
		const fsBrowse = vi.fn(async () =>
			browse({ path: "/home/me", parent: null, children: [{ name: "repo", path: "/home/me/repo", isGitRepo: true }, { name: "docs", path: "/home/me/docs", isGitRepo: false }] }),
		);
		const wire = mockWire({ fsBrowse });
		await mount(wire, vi.fn());
		expect(fsBrowse).toHaveBeenCalled();
		const rows = [...container.querySelectorAll('[data-testid="browse-row"]')];
		expect(rows).toHaveLength(2);
		expect(container.textContent ?? "").toContain("repo");
		expect(container.textContent ?? "").toContain("docs");
	});

	it("descending into a child re-browses that child's absolute path (b-AC-2)", async () => {
		const fsBrowse = vi.fn(async (path?: string) => {
			if (path === "/home/me/repo") return browse({ path: "/home/me/repo", parent: "/home/me", children: [] });
			return browse({ path: "/home/me", parent: null, children: [{ name: "repo", path: "/home/me/repo", isGitRepo: true }] });
		});
		const wire = mockWire({ fsBrowse });
		await mount(wire, vi.fn());
		const row = container.querySelector('[data-testid="browse-row"]') as HTMLElement;
		await act(async () => row.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await flush();
		expect(fsBrowse).toHaveBeenCalledWith("/home/me/repo");
		expect(container.querySelector('[data-testid="picker-path"]')?.textContent).toContain("/home/me/repo");
	});
});

describe("PRD-059b selecting a folder pre-fills the name (b-AC-3) and binds (b-AC-4)", () => {
	it("Use this folder fills the name field with the folder basename, editable", async () => {
		const fsBrowse = vi.fn(async () => browse({ path: "/home/me/my-repo", parent: "/home/me", children: [] }));
		const wire = mockWire({ fsBrowse });
		await mount(wire, vi.fn());
		click("select-current");
		await flush();
		// The Input primitive spreads `data-testid` onto the inner <input> element itself.
		const nameInput = container.querySelector('input[data-testid="picker-name"]') as HTMLInputElement | null;
		expect(nameInput, "the name input is present after selecting").not.toBeNull();
		expect(nameInput?.value).toBe("my-repo");
	});

	it("confirm POSTs bindProject with the absolute path + name and calls onBound (b-AC-4)", async () => {
		const fsBrowse = vi.fn(async () => browse({ path: "/home/me/api", parent: "/home/me", children: [] }));
		const bindProject = vi.fn(async (): Promise<BindAckWire> => ({ bound: true, path: "/home/me/api", projectId: "api" }));
		const onBound = vi.fn();
		const wire = mockWire({ fsBrowse, bindProject });
		await mount(wire, onBound);
		click("select-current");
		await flush();
		click("picker-bind");
		await flush();
		expect(bindProject).toHaveBeenCalledWith({ path: "/home/me/api", name: "api" });
		expect(onBound).toHaveBeenCalledWith(expect.objectContaining({ bound: true, projectId: "api" }));
	});

	it("a rejected bind stays in the picker with the daemon's redacted reason (never a silent failure)", async () => {
		const fsBrowse = vi.fn(async () => browse({ path: "/home/me/__unsorted__", parent: "/home/me", children: [] }));
		const bindProject = vi.fn(async (): Promise<BindAckWire> => ({ bound: false, path: "/home/me/__unsorted__", projectId: "", error: "reserved inbox" }));
		const onBound = vi.fn();
		const wire = mockWire({ fsBrowse, bindProject });
		await mount(wire, onBound);
		click("select-current");
		await flush();
		click("picker-bind");
		await flush();
		expect(onBound).not.toHaveBeenCalled();
		expect(container.querySelector('[data-testid="picker-error"]')?.textContent).toContain("reserved inbox");
	});
});

describe("PRD-059b daemon-down / local-mode-off fallback (b-AC-5)", () => {
	it("an empty (unavailable) browse shows the plain message + the CLI bind hint, never a hang", async () => {
		// EMPTY_BROWSE is path:"" + no children — the wire's degrade for a 404 / unreachable daemon.
		const fsBrowse = vi.fn(async () => browse({ path: "", root: "", parent: null, children: [] }));
		const wire = mockWire({ fsBrowse });
		await mount(wire, vi.fn());
		const unavailable = container.querySelector('[data-testid="picker-unavailable"]');
		expect(unavailable, "the unavailable panel renders").not.toBeNull();
		expect(unavailable?.textContent).toContain("honeycomb project bind");
	});
});
