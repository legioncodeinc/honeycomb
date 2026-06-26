// @vitest-environment jsdom
/**
 * PRD-059c / PRD-059d — the PROJECTS page DOM suite (c-AC-1 / c-AC-2 / c-AC-3 / c-AC-4 / c-AC-5 / d-AC-1).
 *
 * Mounts the REAL {@link ProjectsPage} (inside a {@link ScopeProvider} so Open can re-scope) against a
 * MOCKED `WireClient` and proves:
 *   c-AC-1 — every actively-sourced (locally-bound) project is listed with its name + state cells.
 *   c-AC-2 — the `__unsorted__` inbox is shown DISTINCTLY (its own row), separate from active projects.
 *   c-AC-3 — the top-right "+ Add" menu offers New folder (the 059b picker) and Import existing (059d).
 *   c-AC-4 — Unbind drives the folder picker → `wire.unbindProject({ path })`, then re-lists.
 *   c-AC-5 — Open re-scopes via the scope context (the selected project lands in the dashboard scope).
 *   d-AC-1 — the import modal lists registry projects with NO local binding (`scopeProjects({unbound})`).
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectsPage } from "../../../src/dashboard/web/pages/projects.js";
import { ScopeProvider, SCOPE_STORAGE_KEY } from "../../../src/dashboard/web/scope-context.js";
import type { PageProps } from "../../../src/dashboard/web/page-frame.js";
import type { BindAckWire, BrowseBodyWire, ScopeProjectWire, UnbindAckWire, WireClient } from "../../../src/dashboard/web/wire.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function browse(over: Partial<BrowseBodyWire> = {}): BrowseBodyWire {
	return { path: "/home/me/api", root: "/home/me", parent: "/home/me", children: [], ...over };
}

/** A mock wire. `scopeProjects` honors the `unbound` filter so the import-list test is deterministic. */
function mockWire(opts: {
	all?: ScopeProjectWire[];
	scopeProjects?: ReturnType<typeof vi.fn>;
	unbindProject?: ReturnType<typeof vi.fn>;
	bindExistingProject?: ReturnType<typeof vi.fn>;
} = {}): WireClient {
	const all = opts.all ?? [
		{ projectId: "api", name: "API", boundLocally: true },
		{ projectId: "web", name: "Web", boundLocally: true },
		{ projectId: "__unsorted__", name: "unsorted", boundLocally: false },
		{ projectId: "cloudonly", name: "Cloud Only", boundLocally: false },
	];
	const scopeProjects =
		opts.scopeProjects ??
		vi.fn(async (o?: { unbound?: boolean }) => (o?.unbound === true ? all.filter((p) => !p.boundLocally) : all));
	return {
		scopeProjects,
		scopeOrgs: vi.fn(async () => [{ id: "acme", name: "Acme" }]),
		scopeWorkspaces: vi.fn(async () => ({ workspaces: [{ id: "w", name: "W" }], org: "acme", reminted: false })),
		switchOrg: vi.fn(),
		switchWorkspace: vi.fn(),
		fsBrowse: vi.fn(async () => browse()),
		bindProject: vi.fn(async (): Promise<BindAckWire> => ({ bound: true, path: "/home/me/api", projectId: "api" })),
		bindExistingProject: opts.bindExistingProject ?? vi.fn(async (): Promise<BindAckWire> => ({ bound: true, path: "/home/me/api", projectId: "cloudonly" })),
		unbindProject: opts.unbindProject ?? vi.fn(async (): Promise<UnbindAckWire> => ({ unbound: true, path: "/home/me/api" })),
	} as unknown as WireClient;
}

function pageProps(wire: WireClient): PageProps {
	return { wire, daemonUp: true, assetBase: "assets", pollinating: false };
}

let container: HTMLDivElement;
let root: Root | undefined;

function installLocalStorageStub(): Map<string, string> {
	const store = new Map<string, string>();
	const stub: Storage = {
		get length() {
			return store.size;
		},
		clear: () => store.clear(),
		getItem: (k: string) => (store.has(k) ? store.get(k) ?? null : null),
		key: (i: number) => [...store.keys()][i] ?? null,
		removeItem: (k: string) => store.delete(k),
		setItem: (k: string, v: string) => void store.set(k, String(v)),
	};
	Object.defineProperty(globalThis, "localStorage", { value: stub, configurable: true, writable: true });
	return store;
}

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	installLocalStorageStub();
});

afterEach(() => {
	if (root !== undefined) act(() => root.unmount());
	root = undefined;
	container.remove();
	vi.restoreAllMocks();
});

async function flush(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 12; i += 1) await Promise.resolve();
	});
}

async function mount(wire: WireClient): Promise<void> {
	await act(async () => {
		root = createRoot(container);
		root.render(
			<ScopeProvider wire={wire}>
				<ProjectsPage {...pageProps(wire)} />
			</ScopeProvider>,
		);
	});
	await flush();
}

function click(testId: string): void {
	const el = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
	if (el === null) throw new Error(`element ${testId} not found`);
	act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("PRD-059c the Projects page lists active projects + the inbox (c-AC-1 / c-AC-2)", () => {
	it("lists every locally-bound project with state cells, and the inbox distinctly", async () => {
		const wire = mockWire();
		await mount(wire);
		const rows = [...container.querySelectorAll('[data-testid="project-row"]')];
		// Only the two boundLocally non-inbox projects are ACTIVE rows.
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.getAttribute("data-project-id")).sort()).toEqual(["api", "web"]);
		// c-AC-2: the inbox is its own distinct row, NOT an active project row.
		expect(container.querySelector('[data-testid="inbox-row"]'), "the inbox row renders distinctly").not.toBeNull();
		expect(container.textContent ?? "").toContain("__unsorted__");
	});

	it("renders an honest empty state when no project is locally bound", async () => {
		const wire = mockWire({ all: [{ projectId: "__unsorted__", name: "unsorted", boundLocally: false }] });
		await mount(wire);
		expect(container.querySelector('[data-testid="projects-empty"]'), "the empty state renders").not.toBeNull();
		expect(container.querySelectorAll('[data-testid="project-row"]')).toHaveLength(0);
	});
});

describe("PRD-059c the + Add menu (c-AC-3)", () => {
	it("opens a menu with New folder and Import existing", async () => {
		const wire = mockWire();
		await mount(wire);
		click("add-menu-toggle");
		await flush();
		expect(container.querySelector('[data-testid="add-menu"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="add-new"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="add-import"]')).not.toBeNull();
	});

	it("New folder reveals the 059b folder picker inline", async () => {
		const wire = mockWire();
		await mount(wire);
		click("add-menu-toggle");
		await flush();
		click("add-new");
		await flush();
		expect(container.querySelector('[data-testid="folder-picker"]'), "the picker renders for the new-folder flow").not.toBeNull();
	});
});

describe("PRD-059d the import modal lists registry-only projects (d-AC-1)", () => {
	it("Import existing opens the modal listing projects with NO local binding", async () => {
		const scopeProjects = vi.fn(async (o?: { unbound?: boolean }) =>
			o?.unbound === true
				? [{ projectId: "cloudonly", name: "Cloud Only", boundLocally: false }]
				: [{ projectId: "api", name: "API", boundLocally: true }],
		);
		const wire = mockWire({ scopeProjects });
		await mount(wire);
		click("add-menu-toggle");
		await flush();
		click("add-import");
		await flush();
		expect(container.querySelector('[data-testid="import-modal"]')).not.toBeNull();
		// d-AC-1: the import list requested the unbound (importable) set.
		expect(scopeProjects).toHaveBeenCalledWith({ unbound: true });
		const importRows = [...container.querySelectorAll('[data-testid="import-project"]')];
		expect(importRows.map((r) => r.getAttribute("data-project-id"))).toEqual(["cloudonly"]);
	});
});

describe("PRD-059c Open re-scopes the dashboard (c-AC-5)", () => {
	it("clicking Open persists the project into the dashboard scope (viewer-side)", async () => {
		const wire = mockWire();
		await mount(wire);
		const openBtn = container.querySelector('[data-project-id="api"] [data-testid="project-open"]') as HTMLElement;
		await act(async () => openBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await flush();
		// The scope context persists the selection to localStorage (viewer-side, 49e-AC-4).
		const raw = localStorage.getItem(SCOPE_STORAGE_KEY);
		expect(JSON.parse(raw ?? "{}").project).toBe("api");
	});
});

describe("PRD-059c Unbind removes the local binding (c-AC-4)", () => {
	it("Unbind → pick a folder → confirm POSTs unbindProject and re-lists", async () => {
		const unbindProject = vi.fn(async (): Promise<UnbindAckWire> => ({ unbound: true, path: "/home/me/api" }));
		const wire = mockWire({ unbindProject });
		await mount(wire);
		// Open the per-row unbind panel.
		const unbindBtn = container.querySelector('[data-project-id="api"] [data-testid="project-unbind"]') as HTMLElement;
		await act(async () => unbindBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await flush();
		// Select the browsed folder (FolderSelect's "use this folder").
		const useBtn = container.querySelector('[data-project-id="api"] [data-testid="folderselect-use"]') as HTMLElement;
		await act(async () => useBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await flush();
		const confirmBtn = container.querySelector('[data-project-id="api"] [data-testid="project-unbind-confirm"]') as HTMLElement;
		await act(async () => confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await flush();
		expect(unbindProject).toHaveBeenCalledWith({ path: "/home/me/api" });
	});
});
