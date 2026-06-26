// @vitest-environment jsdom
/**
 * IRD-122 — the dashboard SCOPE-SWITCHER PERSISTENCE DOM suite (122-AC-1 / 122-AC-3 / 122-AC-4).
 *
 * Mounts the REAL {@link ScopeProvider} + {@link ScopeSwitcherSlot} against a MOCKED `WireClient` and
 * proves the switcher is now HONEST instead of viewer-only:
 *   122-AC-1 — selecting an org/workspace calls the daemon persist routes (`switchOrg`/`switchWorkspace`),
 *              so the change is saved to credentials.json (not a localStorage-only no-op).
 *   122-AC-3 — the project dropdown is explicitly labeled a VIEW FILTER (it cannot set capture scope).
 *   122-AC-4 — every switch surfaces feedback — a persisted org/workspace, a project view filter, or a
 *              failure — so no switcher change is ever a silent no-op.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScopeProvider, ScopeSwitcherSlot } from "../../../src/dashboard/web/scope-context.js";
import type { OrgSwitchAckWire, WorkspaceSwitchAckWire, WireClient } from "../../../src/dashboard/web/wire.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A mock wire whose org/workspace switches PERSIST (the daemon ack), recording the calls. */
function mockWire(opts: {
	switchOrg?: ReturnType<typeof vi.fn>;
	switchWorkspace?: ReturnType<typeof vi.fn>;
} = {}): WireClient {
	return {
		scopeOrgs: vi.fn(async () => [{ id: "acme", name: "Acme" }, { id: "globex", name: "Globex" }]),
		scopeWorkspaces: vi.fn(async () => ({ workspaces: [{ id: "backend", name: "Backend" }, { id: "frontend", name: "Frontend" }], org: "acme", reminted: false })),
		scopeProjects: vi.fn(async () => [{ projectId: "api", name: "API", boundLocally: true }]),
		switchOrg: opts.switchOrg ?? vi.fn(async (org: string): Promise<OrgSwitchAckWire> => ({ switched: true, org, orgName: org === "globex" ? "Globex" : "Acme", reminted: true })),
		switchWorkspace: opts.switchWorkspace ?? vi.fn(async (workspace: string): Promise<WorkspaceSwitchAckWire> => ({ switched: true, workspace })),
	} as unknown as WireClient;
}

let container: HTMLDivElement;
let root: Root | undefined;

function installLocalStorageStub(): void {
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
				<ScopeSwitcherSlot collapsed={false} />
			</ScopeProvider>,
		);
	});
	await flush();
}

async function selectOption(testId: string, value: string): Promise<void> {
	const el = container.querySelector(`[data-testid="${testId}"]`) as HTMLSelectElement | null;
	if (el === null) throw new Error(`select ${testId} not found`);
	await act(async () => {
		el.value = value;
		el.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await flush();
}

describe("IRD-122 the org switch PERSISTS via the daemon (122-AC-1 / 122-AC-2)", () => {
	it("selecting an org calls wire.switchOrg (the daemon re-mint + save), not a localStorage-only no-op", async () => {
		const switchOrg = vi.fn(async (org: string): Promise<OrgSwitchAckWire> => ({ switched: true, org, orgName: "Globex", reminted: true }));
		const wire = mockWire({ switchOrg });
		await mount(wire);
		await selectOption("scope-org", "globex");
		expect(switchOrg).toHaveBeenCalledWith("globex");
		// 122-AC-4: the persisted switch surfaces feedback (the re-mint outcome), never a silent no-op.
		const feedback = container.querySelector('[data-testid="switch-feedback"]');
		expect(feedback?.getAttribute("data-kind")).toBe("persisted");
		expect(feedback?.textContent ?? "").toContain("Globex");
	});

	it("a FAILED org switch surfaces an error and does not silently change the view", async () => {
		const switchOrg = vi.fn(async (): Promise<OrgSwitchAckWire> => ({ switched: false, org: "", reminted: false, error: "not_logged_in" }));
		const wire = mockWire({ switchOrg });
		await mount(wire);
		await selectOption("scope-org", "globex");
		const feedback = container.querySelector('[data-testid="switch-feedback"]');
		expect(feedback?.getAttribute("data-kind")).toBe("error");
		expect(feedback?.textContent ?? "").toContain("could not switch");
	});
});

describe("IRD-122 the workspace switch PERSISTS via the daemon (122-AC-1)", () => {
	it("selecting a workspace calls wire.switchWorkspace and surfaces persisted feedback", async () => {
		const switchWorkspace = vi.fn(async (workspace: string): Promise<WorkspaceSwitchAckWire> => ({ switched: true, workspace }));
		const wire = mockWire({ switchWorkspace });
		await mount(wire);
		await selectOption("scope-workspace", "frontend");
		expect(switchWorkspace).toHaveBeenCalledWith("frontend");
		expect(container.querySelector('[data-testid="switch-feedback"]')?.getAttribute("data-kind")).toBe("persisted");
	});
});

describe("IRD-122 the project dropdown is a VIEW FILTER (122-AC-3 / 122-AC-4)", () => {
	it("the project control is labeled a view filter with an explanatory hint", async () => {
		const wire = mockWire();
		await mount(wire);
		// The label calls it a view filter; the hint explains capture is folder/binding-driven.
		expect(container.textContent ?? "").toContain("view filter");
		const hint = container.querySelector('[data-testid="project-view-hint"]');
		expect(hint?.textContent ?? "").toContain("bind a folder");
	});

	it("selecting a project surfaces 'view filter' feedback (not persisted), never a silent no-op", async () => {
		const wire = mockWire();
		await mount(wire);
		await selectOption("scope-project", "api");
		const feedback = container.querySelector('[data-testid="switch-feedback"]');
		expect(feedback?.getAttribute("data-kind")).toBe("view");
	});
});
