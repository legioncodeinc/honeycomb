// @vitest-environment jsdom
/**
 * PRD-037a — the left-nav Sidebar suite (037a AC-1..AC-7).
 *
 * Mounts the real `<Sidebar>` into jsdom and asserts: the brand chrome (mark + wordmark + identity);
 * the seven nav items in registry order; EXACTLY one active item for a route (and the highlight moves);
 * `onNavigate(route)` fires with the item's route and the sidebar does NOT mutate location.hash itself;
 * the daemon-health pill renders the live up/down state; and the collapsed rail keeps the highlight +
 * the health dot. Pure DOM — no network.
 */

import { act } from "react";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ROUTES } from "../../../src/dashboard/web/registry.js";
import { Sidebar, type SidebarProps } from "../../../src/dashboard/web/sidebar.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	window.location.hash = "";
	container = document.createElement("div");
	document.body.appendChild(container);
});

afterEach(() => {
	if (root !== undefined) act(() => root.unmount());
	container.remove();
	window.location.hash = "";
	vi.restoreAllMocks();
});

/** Mount the Sidebar with sensible defaults, overridable per test. */
function mountSidebar(overrides: Partial<SidebarProps> = {}): { onNavigate: ReturnType<typeof vi.fn>; onToggleCollapsed: ReturnType<typeof vi.fn> } {
	const onNavigate = vi.fn();
	const onToggleCollapsed = vi.fn();
	const props: SidebarProps = {
		entries: ROUTES,
		activeRoute: "/",
		onNavigate,
		daemonUp: true,
		identity: "Activeloop · deeplake-core",
		assetBase: "/dashboard",
		collapsed: false,
		onToggleCollapsed,
		...overrides,
	};
	act(() => {
		root = createRoot(container);
		root.render(<Sidebar {...props} />);
	});
	return { onNavigate, onToggleCollapsed };
}

describe("037a AC-1: brand chrome — mark + wordmark + org/workspace sub-line", () => {
	it("renders the mark img, the honeycomb wordmark, and the identity sub-line", () => {
		mountSidebar();
		const img = container.querySelector("img");
		expect(img?.getAttribute("src")).toBe("/dashboard/honeycomb-mark.svg");
		const text = container.textContent ?? "";
		expect(text).toContain("honeycomb");
		expect(text).toContain("Activeloop · deeplake-core");
	});
});

describe("037a AC-2: all seven nav items render from the registry in order", () => {
	it("renders Dashboard…Settings, each with a label, in registry order", () => {
		mountSidebar();
		const items = [...container.querySelectorAll("[data-route]")];
		expect(items.map((el) => el.getAttribute("data-route"))).toEqual(["/", "/harnesses", "/memories", "/graph", "/sync", "/logs", "/settings"]);
		const text = container.textContent ?? "";
		for (const label of ["Dashboard", "Harnesses", "Memories", "Graph", "Sync", "Logs", "Settings"]) {
			expect(text).toContain(label);
		}
	});
});

describe("037a AC-3: exactly one active item, and the highlight moves with the route", () => {
	it("highlights only the active route's item", () => {
		mountSidebar({ activeRoute: "/graph" });
		const active = [...container.querySelectorAll('[data-active="true"]')];
		expect(active).toHaveLength(1);
		expect(active[0]?.getAttribute("data-route")).toBe("/graph");
	});

	it("an unknown route highlights Dashboard (the fallback) — still exactly one", () => {
		mountSidebar({ activeRoute: "/nope" });
		const active = [...container.querySelectorAll('[data-active="true"]')];
		expect(active).toHaveLength(1);
		expect(active[0]?.getAttribute("data-route")).toBe("/");
	});

	it("a deep sub-route highlights its top-level parent", () => {
		mountSidebar({ activeRoute: "/harnesses/claude-code" });
		const active = [...container.querySelectorAll('[data-active="true"]')];
		expect(active).toHaveLength(1);
		expect(active[0]?.getAttribute("data-route")).toBe("/harnesses");
	});
});

describe("037a AC-4: clicking a nav item calls onNavigate(route) and changes nothing else", () => {
	it("fires onNavigate with the item's route and does NOT mutate location.hash", () => {
		const { onNavigate } = mountSidebar();
		const hashBefore = window.location.hash;
		const graphItem = container.querySelector('[data-route="/graph"]');
		act(() => {
			graphItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(onNavigate).toHaveBeenCalledTimes(1);
		expect(onNavigate).toHaveBeenCalledWith("/graph");
		// The sidebar itself never touches the hash — that is 037b's job (kept testable).
		expect(window.location.hash).toBe(hashBefore);
	});
});

describe("037a AC-5: the daemon-health pill renders the live up/down state", () => {
	it("shows 'daemon :3850' + the verified dot when up", () => {
		mountSidebar({ daemonUp: true });
		const pill = container.querySelector('[data-testid="daemon-health-pill"]');
		expect(pill, "the pill rendered in the footer").not.toBeNull();
		expect(pill?.textContent).toContain("daemon :3850");
	});

	it("shows 'offline' when down", () => {
		mountSidebar({ daemonUp: false });
		const pill = container.querySelector('[data-testid="daemon-health-pill"]');
		expect(pill?.textContent).toContain("offline");
	});
});

describe("037a AC-6: collapsed rail keeps the highlight + the health dot, hides labels", () => {
	it("collapsed → labels hidden, but the active item + the pill (dot) survive", () => {
		mountSidebar({ collapsed: true, activeRoute: "/logs" });
		// Labels are not rendered in the rail (icon-only) — the Logs label text is gone.
		expect(container.textContent ?? "").not.toContain("Dashboard");
		expect(container.textContent ?? "").not.toContain("daemon :3850"); // label hidden, dot remains
		// The active item still highlights (exactly one) and the pill is still present.
		const active = [...container.querySelectorAll('[data-active="true"]')];
		expect(active).toHaveLength(1);
		expect(active[0]?.getAttribute("data-route")).toBe("/logs");
		expect(container.querySelector('[data-testid="daemon-health-pill"]')).not.toBeNull();
		// The nav is marked collapsed.
		expect(container.querySelector('[data-collapsed="true"]')).not.toBeNull();
	});

	it("the collapse toggle calls onToggleCollapsed", () => {
		const { onToggleCollapsed } = mountSidebar();
		const toggle = [...container.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "").includes("collapse"));
		expect(toggle, "the collapse toggle rendered").toBeTruthy();
		act(() => {
			toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
	});
});

describe("037a AC-7 / D-9: the sidebar carries no token/secret", () => {
	it("renders no secret-looking strings in its DOM", () => {
		mountSidebar({ daemonUp: false });
		const text = (container.textContent ?? "").toLowerCase();
		for (const needle of ["token", "secret", "bearer", "authorization", "password", "x-honeycomb", "org_", "credential"]) {
			expect(text, `no "${needle}" in the sidebar`).not.toContain(needle);
		}
	});
});
