// @vitest-environment jsdom
/**
 * PRD-041 (the full-page graph) — the Memory Graph page DOM suite.
 *
 * The page is MEMORY-ONLY (the codebase view + the Codebase↔Memory toggle + the "Build graph" button
 * were removed; the daemon still auto-builds the codebase graph in the background). This suite mounts the
 * REAL {@link GraphPage} into jsdom against a MOCKED wire client whose `memoryGraph()` feeds the page,
 * and asserts the surviving behavior through the rendered DOM, plus the pure helpers:
 *   - renders ALL N nodes + M edges of the built graph (no skip), reusing the shared pure `layout(...)`.
 *   - pan/zoom changes the SVG viewBox; fit/reset re-frames; bounded zoom is clamped.
 *   - clicking a node opens the side detail panel with id/label/kind + neighbors split by
 *     relation/direction; clearing works.
 *   - kind filters come from the snapshot's REAL kinds; toggling hides nodes + incident edges + counts.
 *   - search by id/label focuses + selects the match.
 *   - built:false → the honest "no memory graph yet" empty state (no faked graph, no build command).
 *   - no project selected → the needs-selection state (never another scope's graph).
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	GraphPage,
	applyKindFilter,
	distinctKinds,
	findNode,
	viewBoxFor,
} from "../../../src/dashboard/web/pages/graph.js";
import { splitNeighbors } from "../../../src/dashboard/web/graph-layout.js";
import { ScopeContext, type ScopeContextValue } from "../../../src/dashboard/web/scope-context.js";
import type { PageProps } from "../../../src/dashboard/web/page-frame.js";
import type { GraphWire, WireClient } from "../../../src/dashboard/web/wire.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A built graph whose ids are ARBITRARY real-world strings (file paths + a symbol) with two kinds and
 * `imports`/`calls` edges so the relation/direction split + kind filter have data. (The page is
 * memory-only now, but the canvas machinery is source-agnostic — this is the fixture `memoryGraph()`
 * returns.)
 */
const GRAPH: GraphWire = {
	built: true,
	nodes: [
		{ id: "src/daemon/server.ts", label: "server.ts", kind: "file" },
		{ id: "src/daemon/runtime/dashboard/api.ts", label: "api.ts", kind: "file" },
		{ id: "fetchGraphView", label: "fetchGraphView()", kind: "function" },
		{ id: "src/dashboard/web/panels.tsx", label: "panels.tsx", kind: "file" },
	],
	edges: [
		{ from: "src/daemon/server.ts", to: "src/daemon/runtime/dashboard/api.ts", kind: "imports" },
		{ from: "src/daemon/runtime/dashboard/api.ts", to: "fetchGraphView", kind: "calls" },
		{ from: "src/dashboard/web/panels.tsx", to: "fetchGraphView", kind: "calls" },
	],
};

/** A built memory graph (entities + a dependency edge) — exercises ontology relation kinds in the split. */
const MEMORY_GRAPH: GraphWire = {
	built: true,
	nodes: [
		{ id: "e1", label: "Alex", kind: "entity" },
		{ id: "e2", label: "Honeycomb", kind: "entity" },
	],
	edges: [{ from: "e1", to: "e2", kind: "depends_on" }],
};

const EMPTY: GraphWire = { built: false, nodes: [], edges: [] };

/** A built graph the daemon TRUNCATED: the shipped nodes are few, but `meta` reports the full snapshot size. */
const TRUNCATED_GRAPH: GraphWire = {
	built: true,
	nodes: GRAPH.nodes,
	edges: GRAPH.edges,
	meta: { totalNodes: 2000, totalEdges: 1500, shownNodes: 4, shownEdges: 3, truncated: true },
};

/**
 * A mock wire client whose `memoryGraph()` returns the given graph (the page's only source now). The
 * retired `graph()`/`buildGraph()` are kept as inert stubs so the WireClient shape is satisfied — the
 * page no longer calls them.
 */
function mockWire(memory: GraphWire): WireClient {
	return {
		kpis: vi.fn(),
		sessions: vi.fn(),
		settings: vi.fn(),
		rules: vi.fn(),
		skills: vi.fn(),
		graph: vi.fn(async () => EMPTY),
		memoryGraph: vi.fn(async () => memory),
		recall: vi.fn(),
		logs: vi.fn(async () => []),
		harnesses: vi.fn(),
		health: vi.fn(),
		pollinate: vi.fn(),
		buildGraph: vi.fn(async () => ({ built: false, nodeCount: 0, edgeCount: 0, fileCount: 0 })),
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
	window.location.hash = "#/graph";
});

afterEach(() => {
	if (root !== undefined) act(() => root.unmount());
	container.remove();
	window.location.hash = "";
});

/** A scope with an ACTIVE project — PRD-049e (the page renders the needs-selection state without one). */
const SCOPE_WITH_PROJECT: ScopeContextValue = {
	scope: { org: "acme", workspace: "backend", project: "api" },
	setScope: () => {},
};

/** A scope with NO active project — the page renders the needs-selection state. */
const SCOPE_NO_PROJECT: ScopeContextValue = {
	scope: { org: "acme", workspace: "backend" },
	setScope: () => {},
};

/** Mount the page (with the given scope) and flush the fetch-on-mount microtask so state settles. */
async function mountPage(wire: WireClient, scopeValue: ScopeContextValue = SCOPE_WITH_PROJECT): Promise<void> {
	await act(async () => {
		root = createRoot(container);
		root.render(
			<ScopeContext.Provider value={scopeValue}>
				<GraphPage {...pageProps(wire)} />
			</ScopeContext.Provider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

/** Click the node `<g role="button">` whose aria-label matches the node's label. */
function clickNode(label: string): void {
	const g = [...container.querySelectorAll('g[role="button"]')].find((el) => el.getAttribute("aria-label") === `node ${label}`);
	expect(g, `node group for "${label}"`).toBeDefined();
	act(() => g?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

/** Type into the search input (fires onChange). */
function typeSearch(value: string): void {
	const input = container.querySelector('[data-testid="graph-search"]') as HTMLInputElement;
	act(() => {
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe("PRD-041 pure helpers (layout reuse + filter/search/viewbox)", () => {
	it("distinctKinds returns the snapshot's real kinds in first-seen order (not hardcoded)", () => {
		expect(distinctKinds(GRAPH)).toEqual(["file", "function"]);
		expect(distinctKinds(MEMORY_GRAPH)).toEqual(["entity"]);
		expect(distinctKinds(EMPTY)).toEqual([]);
	});

	it("applyKindFilter hides a kind's nodes AND edges incident only to hidden nodes", () => {
		const filtered = applyKindFilter(GRAPH, new Set(["function"]));
		// fetchGraphView (the only `function`) is dropped; both `calls` edges into it are dropped too.
		expect(filtered.nodes.map((n) => n.id)).not.toContain("fetchGraphView");
		expect(filtered.nodes).toHaveLength(3);
		expect(filtered.edges).toHaveLength(1); // only server.ts→api.ts (imports) survives
		expect(filtered.edges[0]?.kind).toBe("imports");
		// No hidden kinds → the graph is returned unchanged.
		expect(applyKindFilter(GRAPH, new Set())).toBe(GRAPH);
	});

	it("findNode locates by id OR label, case-insensitive substring; empty query → null", () => {
		expect(findNode(GRAPH, "SERVER")).toBe("src/daemon/server.ts"); // label match, case-insensitive
		expect(findNode(GRAPH, "dashboard/api")).toBe("src/daemon/runtime/dashboard/api.ts"); // id substring
		expect(findNode(GRAPH, "")).toBeNull();
		expect(findNode(GRAPH, "   ")).toBeNull();
		expect(findNode(GRAPH, "no-such-node")).toBeNull();
	});

	it("viewBoxFor reflects scale (zoom shows less) + translate (pan) — deterministic", () => {
		// Identity: the whole base box (1600×1000) from the origin.
		expect(viewBoxFor({ scale: 1, tx: 0, ty: 0 })).toBe("0 0 1600 1000");
		// 2× zoom shows half the box; a pan translates the origin.
		expect(viewBoxFor({ scale: 2, tx: 100, ty: 50 })).toBe("100 50 800 500");
	});

	it("splitNeighbors splits by direction AND relation; works for memory relations (no special-casing)", () => {
		const api = splitNeighbors("src/daemon/runtime/dashboard/api.ts", GRAPH.edges);
		// incoming: server.ts via `imports`; outgoing: fetchGraphView via `calls`.
		expect(api.incoming).toEqual([{ kind: "imports", ids: ["src/daemon/server.ts"] }]);
		expect(api.outgoing).toEqual([{ kind: "calls", ids: ["fetchGraphView"] }]);
		// The memory graph's `depends_on` relation splits with NO special-casing.
		const e1 = splitNeighbors("e1", MEMORY_GRAPH.edges);
		expect(e1.outgoing).toEqual([{ kind: "depends_on", ids: ["e2"] }]);
		expect(e1.incoming).toEqual([]);
	});
});

// ── Render-all ──────────────────────────────────────────────────────────────────

describe("the page renders the FULL memory graph (every node + every edge)", () => {
	it("draws all N nodes and all M edges of the built graph (arbitrary ids, no skip)", async () => {
		await mountPage(mockWire(GRAPH));
		expect(container.querySelectorAll('g[role="button"]')).toHaveLength(GRAPH.nodes.length);
		expect(container.querySelectorAll("line")).toHaveLength(GRAPH.edges.length);
		// One node-fill circle per node (no selection → no extra ring circle).
		expect(container.querySelectorAll("circle")).toHaveLength(GRAPH.nodes.length);
		// Arbitrary-id labels render as text.
		expect(container.textContent ?? "").toContain("server.ts");
		expect(container.textContent ?? "").toContain("fetchGraphView()");
		// The eyebrow reflects the live counts (no source prefix).
		expect(container.textContent ?? "").toContain("4 nodes · 3 edges");
	});

	it("fetches the memory endpoint, never the retired codebase graph endpoint", async () => {
		const wire = mockWire(MEMORY_GRAPH);
		await mountPage(wire);
		expect(wire.memoryGraph).toHaveBeenCalled();
		expect(wire.graph).not.toHaveBeenCalled();
		expect(container.textContent ?? "").toContain("Alex");
	});
});

// ── Truncation notice (the graph memory cap) ─────────────────────────────────────

describe("graph memory cap: the truncation notice reports the daemon meta counts, not post-filter counts", () => {
	it("shows 'shownNodes of totalNodes' from meta, and a kind filter does NOT change those numbers", async () => {
		await mountPage(mockWire(TRUNCATED_GRAPH));
		const notice = container.querySelector('[data-testid="graph-truncation-notice"]');
		expect(notice).not.toBeNull();
		// Sourced from graph.meta (4 of 2,000), NOT the rendered node count.
		expect(notice?.textContent).toContain("4 most-connected of 2,000");

		// Hiding a kind shrinks the RENDERED set, but the daemon-cap counts in the banner must not move.
		const fnToggle = container.querySelector('[data-testid="kind-toggle-function"]') as HTMLButtonElement;
		act(() => fnToggle.click());
		expect(container.querySelector('[data-testid="graph-truncation-notice"]')?.textContent).toContain("4 most-connected of 2,000");
	});

	it("does NOT show the notice for an untruncated graph (meta.truncated=false / no meta)", async () => {
		await mountPage(mockWire(GRAPH));
		expect(container.querySelector('[data-testid="graph-truncation-notice"]')).toBeNull();
	});

	it("shows the CLIENT-cap message when the fetched graph exceeds the render cap with NO daemon meta", async () => {
		// > MAX_RENDER_NODES (1500) nodes and no `meta` → serverTruncated=false, capped=true → the fallback
		// "Rendering is capped at …" branch (the client-only render backstop).
		const huge: GraphWire = {
			built: true,
			nodes: Array.from({ length: 1600 }, (_, i) => ({ id: `n${i}`, label: `n${i}`, kind: "entity" })),
			edges: [],
		};
		await mountPage(mockWire(huge));
		const notice = container.querySelector('[data-testid="graph-truncation-notice"]');
		expect(notice).not.toBeNull();
		expect(notice?.textContent).toContain("Rendering is capped at 1,500 nodes");
		// It must NOT borrow the daemon "most-connected of M" phrasing (there is no meta here).
		expect(notice?.textContent).not.toContain("most-connected of");
	});
});

// ── Pan / zoom / fit ─────────────────────────────────────────────────────────────

describe("pan + bounded zoom + fit/reset", () => {
	it("a wheel zoom changes the canvas viewBox; fit resets it", async () => {
		await mountPage(mockWire(GRAPH));
		const svg = container.querySelector('[data-testid="graph-canvas"]') as SVGSVGElement;
		const initial = svg.getAttribute("viewBox");
		expect(initial).toBe("0 0 1600 1000");

		// Zoom in via the toolbar button → the viewBox should shrink (shows less of the base box).
		const zoomIn = container.querySelector('[aria-label="zoom in"]') as HTMLButtonElement;
		act(() => zoomIn.click());
		const zoomed = (container.querySelector('[data-testid="graph-canvas"]') as SVGSVGElement).getAttribute("viewBox");
		expect(zoomed).not.toBe(initial);

		// Fit re-frames to the whole base box.
		const fit = container.querySelector('[data-testid="fit-view"]') as HTMLButtonElement;
		act(() => fit.click());
		expect((container.querySelector('[data-testid="graph-canvas"]') as SVGSVGElement).getAttribute("viewBox")).toBe("0 0 1600 1000");
	});

	it("zoom is bounded — repeated zoom-out never inverts/blows up the viewBox", async () => {
		await mountPage(mockWire(GRAPH));
		const zoomOut = container.querySelector('[aria-label="zoom out"]') as HTMLButtonElement;
		for (let i = 0; i < 20; i++) act(() => zoomOut.click());
		const vb = (container.querySelector('[data-testid="graph-canvas"]') as SVGSVGElement).getAttribute("viewBox") ?? "";
		const [, , w, h] = vb.split(" ").map(Number);
		// At MIN_ZOOM 0.25 the visible box is 1600/0.25 = 6400 × 4000 — bounded, finite, positive.
		expect(w).toBe(6400);
		expect(h).toBe(4000);
		expect(Number.isFinite(w) && w > 0).toBe(true);
	});
});

// ── Click → detail ───────────────────────────────────────────────────────────────

describe("click-to-select → detail panel with split neighbors", () => {
	it("clicking a node opens the panel with id/label/kind + outgoing/incoming relations", async () => {
		await mountPage(mockWire(GRAPH));
		expect(container.querySelector('[data-testid="graph-detail-panel"]')).toBeNull();

		clickNode("api.ts");
		const panel = container.querySelector('[data-testid="graph-detail-panel"]');
		expect(panel).not.toBeNull();
		const text = panel?.textContent ?? "";
		expect(text).toContain("src/daemon/runtime/dashboard/api.ts"); // id
		expect(text).toContain("api.ts"); // label
		expect(text).toContain("file"); // kind
		// Outgoing `calls` → fetchGraphView; incoming `imports` ← server.ts (split by direction+relation).
		expect(container.querySelector('[data-testid="detail-outgoing"]')?.textContent).toContain("fetchGraphView()");
		expect(container.querySelector('[data-testid="detail-incoming"]')?.textContent).toContain("server.ts");
	});

	it("clearing the selection (re-click) removes the detail panel", async () => {
		await mountPage(mockWire(GRAPH));
		clickNode("server.ts");
		expect(container.querySelector('[data-testid="graph-detail-panel"]')).not.toBeNull();
		clickNode("server.ts");
		expect(container.querySelector('[data-testid="graph-detail-panel"]')).toBeNull();
	});
});

// ── Kind filters ─────────────────────────────────────────────────────────────────

describe("kind filters from real kinds; toggle hides nodes + edges + updates counts", () => {
	it("renders a toggle per REAL kind and toggling a kind off removes its nodes + incident edges", async () => {
		await mountPage(mockWire(GRAPH));
		// Toggles for the real distinct kinds only (file, function) — no hardcoded class/etc.
		expect(container.querySelector('[data-testid="kind-toggle-file"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="kind-toggle-function"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="kind-toggle-class"]')).toBeNull();

		// Hide `function` → fetchGraphView + its 2 `calls` edges vanish; counts update in the eyebrow.
		const fnToggle = container.querySelector('[data-testid="kind-toggle-function"]') as HTMLButtonElement;
		act(() => fnToggle.click());
		expect(container.querySelectorAll('g[role="button"]')).toHaveLength(3); // 4 − 1
		expect(container.querySelectorAll("line")).toHaveLength(1); // 3 − 2 calls
		expect(container.textContent ?? "").toContain("3 nodes · 1 edges");
	});
});

// ── Search ───────────────────────────────────────────────────────────────────────

describe("search focuses + selects the matching node", () => {
	it("typing a query selects the matching node (its detail panel opens)", async () => {
		await mountPage(mockWire(GRAPH));
		typeSearch("panels");
		// panels.tsx is selected → its detail panel is shown.
		const panel = container.querySelector('[data-testid="graph-detail-panel"]');
		expect(panel).not.toBeNull();
		expect(panel?.textContent).toContain("src/dashboard/web/panels.tsx");
	});
});

// ── Empty state + needs-selection ──────────────────────────────────────────────────

describe("the honest empty + needs-selection states (no codebase view, no build command)", () => {
	it("built:false → the 'no memory graph yet' state with NO build button and no canvas", async () => {
		await mountPage(mockWire(EMPTY));
		expect(container.querySelector('[data-testid="graph-empty-state"]')).not.toBeNull();
		expect(container.textContent ?? "").toContain("No memory graph yet for this workspace.");
		// The retired codebase "Build graph" button must NOT appear, nor a dead CLI hint.
		expect(container.querySelector('[data-testid="build-graph-button"]')).toBeNull();
		expect(container.querySelector('[data-testid="source-codebase"]')).toBeNull();
		expect(container.querySelector('[data-testid="source-memory"]')).toBeNull();
		expect(container.textContent ?? "").not.toContain("honeycomb graph build");
		expect(container.querySelector('[data-testid="graph-canvas"]')).toBeNull();
	});

	it("no project selected → the needs-selection state, and the memory endpoint is NOT fetched", async () => {
		const wire = mockWire(GRAPH);
		await mountPage(wire, SCOPE_NO_PROJECT);
		expect(container.querySelector('[data-testid="needs-project-selection"]')).not.toBeNull();
		expect(container.textContent ?? "").toContain("memory graph");
		expect(wire.memoryGraph).not.toHaveBeenCalled();
		expect(container.querySelector('[data-testid="graph-canvas"]')).toBeNull();
	});
});
