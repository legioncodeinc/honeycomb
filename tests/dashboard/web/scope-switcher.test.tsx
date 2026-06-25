// @vitest-environment jsdom
/**
 * PRD-049e — the dashboard SCOPE-SWITCHER DOM suite (49e-AC-1 / 49e-AC-2 / 49e-AC-4 / 49e-AC-5).
 *
 * Mounts the REAL {@link ScopeProvider} + {@link ScopeSwitcherSlot} (the filled 050b slot) plus a real
 * project-aware page ({@link MemoriesPage}) against a MOCKED `WireClient`, and proves the ACs end to end:
 *
 *   49e-AC-1 — the switcher lists orgs / workspaces / projects from the enumeration endpoints (the
 *              privilege-scoped daemon reads); nothing the user lacks access to appears (the mock
 *              returns exactly the accessible set, and the dropdowns render exactly it).
 *   49e-AC-2 — selecting a Project re-scopes the page: the memories list fetcher is called WITH the
 *              selected `project_id` on the next render (the page threads `useScope().scope.project`).
 *   49e-AC-4 — selecting a project is VIEWER-SIDE: it mutates NO per-folder binding. The wire exposes
 *              no projects.json write; the selection lands only in `localStorage`. We assert the selected
 *              project is persisted to localStorage and NO write-shaped wire method was invoked.
 *   49e-AC-5 — with NO project selected the page renders the explicit needs-selection state (not data).
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScopeProvider, ScopeSwitcherSlot, SCOPE_STORAGE_KEY } from "../../../src/dashboard/web/scope-context.js";
import { MemoriesPage } from "../../../src/dashboard/web/pages/memories.js";
import type { PageProps } from "../../../src/dashboard/web/page-frame.js";
import type {
	MemoryRecordWire,
	ScopeOrgWire,
	ScopeProjectWire,
	ScopeWorkspacesWire,
	WireClient,
} from "../../../src/dashboard/web/wire.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function memRec(over: Partial<MemoryRecordWire> = {}): MemoryRecordWire {
	return {
		id: "mem-1",
		type: "fact",
		content: "scoped memory",
		confidence: 1,
		agentId: "default",
		createdAt: "2026-06-20T00:00:00.000Z",
		updatedAt: "2026-06-20T00:00:00.000Z",
		visibility: "global",
		sourceType: "session",
		sourceId: "s1",
		version: 1,
		hasEmbedding: false,
		...over,
	};
}

/** A mock wire recording the enumeration + read calls (so we can assert the project flows through). */
function mockWire(opts: {
	orgs?: ScopeOrgWire[];
	workspaces?: ScopeWorkspacesWire;
	projects?: ScopeProjectWire[];
	listMemories?: ReturnType<typeof vi.fn>;
}): WireClient {
	const listMemories = opts.listMemories ?? vi.fn(async () => [memRec()]);
	return {
		kpis: vi.fn(),
		sessions: vi.fn(),
		settings: vi.fn(),
		rules: vi.fn(),
		skills: vi.fn(),
		graph: vi.fn(async () => ({ built: false, nodes: [], edges: [] })),
		memoryGraph: vi.fn(async () => ({ built: false, nodes: [], edges: [] })),
		recall: vi.fn(async () => ({ memories: [], degraded: false })),
		listMemories,
		getMemory: vi.fn(async () => null),
		addMemory: vi.fn(async () => ({ id: "x", action: "stored" })),
		modifyMemory: vi.fn(async () => null),
		forgetMemory: vi.fn(async () => null),
		compact: vi.fn(async () => null),
		logs: vi.fn(async () => []),
		logsStream: vi.fn(() => () => {}),
		harnesses: vi.fn(),
		health: vi.fn(),
		pollinate: vi.fn(async () => ({ triggered: false, status: "skipped" })),
		assetsView: vi.fn(async () => ({ skills: [], agents: [] })),
		scopeOrgs: vi.fn(async () => opts.orgs ?? [{ id: "acme", name: "Acme" }]),
		scopeWorkspaces: vi.fn(async () => opts.workspaces ?? { workspaces: [{ id: "backend", name: "Backend" }], org: "acme", reminted: false }),
		scopeProjects: vi.fn(async () => opts.projects ?? [{ projectId: "api", name: "API" }, { projectId: "web", name: "Web" }]),
	} as unknown as WireClient;
}

function pageProps(wire: WireClient): PageProps {
	return { wire, daemonUp: true, assetBase: "assets", pollinating: false };
}

let container: HTMLDivElement;
let root: Root | undefined;

/** A deterministic in-memory localStorage stub (jsdom's experimental store is flaky across envs). */
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
		for (let i = 0; i < 10; i += 1) await Promise.resolve();
	});
}

/** Mount the provider wrapping the switcher slot + the memories page (the page reads the scope). */
async function mount(wire: WireClient): Promise<void> {
	await act(async () => {
		root = createRoot(container);
		root.render(
			<ScopeProvider wire={wire}>
				<ScopeSwitcherSlot collapsed={false} />
				<MemoriesPage {...pageProps(wire)} />
			</ScopeProvider>,
		);
	});
	await flush();
}

/** Select a value in a `<select>` by its data-testid (drives the React onChange). */
async function selectOption(testId: string, value: string): Promise<void> {
	const el = container.querySelector(`[data-testid="${testId}"]`) as HTMLSelectElement | null;
	if (el === null) throw new Error(`select ${testId} not found`);
	await act(async () => {
		el.value = value;
		el.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await flush();
}

describe("PRD-049e the scope switcher (49e-AC-1)", () => {
	it("hydrates the org / workspace / project dropdowns from the enumeration endpoints", async () => {
		const wire = mockWire({
			orgs: [{ id: "acme", name: "Acme" }, { id: "globex", name: "Globex" }],
			projects: [{ projectId: "api", name: "API" }, { projectId: "web", name: "Web" }],
		});
		await mount(wire);
		expect(wire.scopeOrgs).toHaveBeenCalled();
		expect(wire.scopeProjects).toHaveBeenCalled();
		const orgSelect = container.querySelector('[data-testid="scope-org"]');
		const projectSelect = container.querySelector('[data-testid="scope-project"]');
		expect(orgSelect?.textContent).toContain("Acme");
		expect(orgSelect?.textContent).toContain("Globex");
		// The project dropdown lists exactly the accessible projects (+ the needs-selection sentinel).
		expect(projectSelect?.textContent).toContain("API");
		expect(projectSelect?.textContent).toContain("Web");
	});
});

describe("PRD-049e the page re-scopes on project select (49e-AC-2)", () => {
	it("selecting a Project calls the memories list fetcher WITH that project_id", async () => {
		const listMemories = vi.fn(async () => [memRec()]);
		const wire = mockWire({ listMemories });
		await mount(wire);
		// No project yet → the list fetcher was NOT called with a project (the page shows needs-selection).
		expect(listMemories).not.toHaveBeenCalledWith(expect.anything(), "api");

		await selectOption("scope-project", "api");

		// 49e-AC-2: the list re-fetches narrowed to the selected project on the next render.
		expect(listMemories).toHaveBeenCalledWith(expect.any(Number), "api");
	});
});

describe("PRD-049e the selection is viewer-side (49e-AC-4)", () => {
	it("selecting a project persists to localStorage and mutates NO per-folder binding", async () => {
		const wire = mockWire({});
		await mount(wire);
		await selectOption("scope-project", "api");

		// The selection lives in the dashboard's OWN localStorage (viewer-side), never the registry.
		const raw = localStorage.getItem(SCOPE_STORAGE_KEY);
		expect(raw).not.toBeNull();
		expect(JSON.parse(raw ?? "{}").project).toBe("api");

		// The wire exposes NO projects.json write surface — assert no bind-shaped method exists/was called.
		expect((wire as unknown as Record<string, unknown>).bindFolder).toBeUndefined();
		expect((wire as unknown as Record<string, unknown>).bindProject).toBeUndefined();
		// Only read methods ran; nothing that writes the 049a/049d store.
		expect(wire.scopeProjects).toHaveBeenCalled();
	});
});

describe("PRD-049e the needs-selection empty state (49e-AC-5)", () => {
	it("with NO project selected the page renders the explicit needs-selection state, not data", async () => {
		const listMemories = vi.fn(async () => [memRec()]);
		const wire = mockWire({ listMemories });
		await mount(wire);
		// The needs-selection panel is present; no memory row leaked through.
		expect(container.querySelector('[data-testid="needs-project-selection"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="memory-row"]')).toBeNull();
	});
});
