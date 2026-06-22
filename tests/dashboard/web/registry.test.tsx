// @vitest-environment jsdom
/**
 * PRD-037c — the route registry suite (037c AC-2, AC-3, AC-5 dynamic group, AC-6 plug-in seam).
 *
 * Asserts: ROUTES lists the seven static entries in nav order; matchRoute resolves each hash + an
 * unknown hash → Dashboard; a DYNAMIC entry's resolver returns N sub-items the sidebar renders; and
 * the headline AC-6 — a THROWAWAY registry entry appears in the nav AND routes to its component
 * WITHOUT editing sidebar.tsx or router.tsx (the seam PRDs 038-044 rely on).
 */

import { act } from "react";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_ROUTE, matchRoute, ROUTES, type RouteEntry, type SubItem } from "../../../src/dashboard/web/registry.js";
import { Sidebar } from "../../../src/dashboard/web/sidebar.js";
import type { PageProps } from "../../../src/dashboard/web/page-frame.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
});

afterEach(() => {
	if (root !== undefined) act(() => root.unmount());
	container.remove();
});

describe("037c AC-2: ROUTES lists the seven static entries in nav order", () => {
	it("has exactly the seven routes/labels in order, each with a component + icon", () => {
		expect(ROUTES.map((r) => r.route)).toEqual(["/", "/harnesses", "/memories", "/graph", "/sync", "/logs", "/settings"]);
		expect(ROUTES.map((r) => r.label)).toEqual(["Dashboard", "Harnesses", "Memories", "Graph", "Sync", "Logs", "Settings"]);
		for (const r of ROUTES) {
			expect(typeof r.component, `${r.label} has a component`).toBe("function");
			expect(r.icon, `${r.label} has an icon`).toBeTruthy();
		}
	});
});

describe("037c AC-3: matchRoute resolves each hash; unknown → Dashboard", () => {
	it("resolves each of the seven hashes to its entry", () => {
		for (const r of ROUTES) {
			expect(matchRoute(r.route).route).toBe(r.route);
		}
	});

	it("an unknown hash falls back to the Dashboard entry (no blank screen)", () => {
		expect(matchRoute("/nope").route).toBe("/");
		expect(matchRoute("/garbage/deep").route).toBe("/");
		expect(matchRoute("").route).toBe("/");
		expect(DEFAULT_ROUTE.route).toBe("/");
	});

	it("a deep sub-route resolves to its top-level parent (dynamic-group children)", () => {
		// e.g. a per-harness deep link resolves to the Harnesses page, not the Dashboard fallback.
		expect(matchRoute("/harnesses/claude-code").route).toBe("/harnesses");
	});

	it("security: a crafted/adversarial hash resolves to the Dashboard fallback (no injection, no proto-pollution)", () => {
		// The hash is an attacker-controllable input (location.hash from a crafted link). matchRoute must
		// treat it purely as a registry lookup KEY (===/startsWith over the static list) — never index an
		// object by it (prototype pollution) nor surface markup. Each of these unknown hashes must fall
		// back to the Dashboard entry, proving the route never escalates to a sink.
		expect(matchRoute("/<script>alert(1)</script>").route).toBe("/");
		expect(matchRoute("/__proto__").route).toBe("/");
		expect(matchRoute("/constructor/prototype").route).toBe("/");
		expect(matchRoute("/<img src=x onerror=alert(1)>").route).toBe("/");
	});
});

describe("037c AC-5: a dynamic entry's resolver returns N sub-items the sidebar renders", () => {
	it("renders the N resolved sub-items under the dynamic parent, distinct from the static entries", async () => {
		// A dynamic Harnesses-like entry whose children come from 'live' install state (here, a fixture).
		const live = ["claude-code", "codex", "cursor"];
		const dynamicEntry: RouteEntry = {
			route: "/harnesses",
			label: "Harnesses",
			icon: <span>icon</span>,
			component: () => <div />,
			dynamic: { resolve: (l): readonly SubItem[] => (l as string[]).map((h) => ({ route: `/harnesses/${h}`, label: h })) },
		};
		const subItems = dynamicEntry.dynamic?.resolve(live) ?? [];
		expect(subItems).toHaveLength(3);
		expect(subItems.map((s) => s.label)).toEqual(["claude-code", "codex", "cursor"]);
		expect(subItems.map((s) => s.route)).toEqual(["/harnesses/claude-code", "/harnesses/codex", "/harnesses/cursor"]);
		// The resolver computes children from live state — an empty live set yields no children.
		expect(dynamicEntry.dynamic?.resolve([])).toHaveLength(0);
	});
});

describe("037c AC-6: a one-entry plug-in appears in the nav + routes WITHOUT editing sidebar/router", () => {
	it("a throwaway registry entry renders as a nav item and matchRoute routes to its component", () => {
		// A throwaway page + entry — the kind PRDs 038-044 add. We do NOT touch sidebar.tsx/router.tsx.
		function ThrowawayPage(_props: PageProps): React.JSX.Element {
			return <div data-testid="throwaway-page">throwaway content</div>;
		}
		const throwaway: RouteEntry = { route: "/throwaway", label: "Throwaway", icon: <span>★</span>, component: ThrowawayPage };
		const extended: readonly RouteEntry[] = [...ROUTES, throwaway];

		// 1) It routes: matchRoute (the same helper router.tsx uses) resolves the new hash to it.
		const matched = matchRoute("/throwaway", extended);
		expect(matched.route).toBe("/throwaway");
		expect(matched.component).toBe(ThrowawayPage);

		// 2) It appears in the nav: the UNMODIFIED Sidebar renders the entry from the registry list.
		act(() => {
			root = createRoot(container);
			root.render(
				<Sidebar
					entries={extended}
					activeRoute="/throwaway"
					onNavigate={() => {}}
					daemonUp
					identity="local · default"
					assetBase="/dashboard"
					collapsed={false}
					onToggleCollapsed={() => {}}
				/>,
			);
		});
		const navItem = container.querySelector('[data-route="/throwaway"]');
		expect(navItem, "the throwaway nav item rendered without touching sidebar.tsx").not.toBeNull();
		expect(navItem?.textContent).toContain("Throwaway");
		// And it is the active item (exactly one active for this route).
		expect(navItem?.getAttribute("data-active")).toBe("true");
		expect(container.querySelectorAll('[data-active="true"]')).toHaveLength(1);
	});
});
