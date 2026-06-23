// @vitest-environment jsdom
/**
 * PRD-041a (full-page codebase graph) + PRD-041b (memory-graph toggle) — the Graph page DOM suite.
 *
 * Mounts the REAL {@link GraphPage} into jsdom against a MOCKED wire client and asserts the ACs through
 * the rendered DOM, plus the pure helpers the page is built from:
 *   - a-AC-1: a built `GraphView` (arbitrary-id nodes/edges) renders ALL N nodes + M edges (no skip),
 *     reusing the shared pure `layout(...)`.
 *   - a-AC-2: pan/zoom changes the SVG viewBox; fit/reset re-frames; bounded zoom is clamped.
 *   - a-AC-3: clicking a node opens the side detail panel with id/label/kind + neighbors split by
 *     relation/direction + the cross-file-`calls` caveat; clearing works.
 *   - a-AC-4: kind filters come from the snapshot's REAL kinds; toggling hides nodes + incident edges +
 *     updates counts; arbitrary-string ids render.
 *   - a-AC-5: search by id/label focuses + selects the match.
 *   - a-AC-6: built:false → the full-page `honeycomb graph build` empty state.
 *   - b-AC-3/b-AC-4: the Codebase ↔ Memory toggle swaps the source; the memory graph renders on the
 *     SAME canvas; an empty memory graph shows the honest "no memory graph yet" state.
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
import type { PageProps } from "../../../src/dashboard/web/page-frame.js";
import type { GraphWire, WireClient } from "../../../src/dashboard/web/wire.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A built codebase graph whose ids are ARBITRARY real-world strings (file paths + a symbol) — NOT any
 * legacy hardcoded ids — with `imports` and `calls` edges so the relation/direction split has data.
 */
const CODEBASE_GRAPH: GraphWire = {
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

/** A built memory graph (entities + a dependency edge) — the SAME GraphView shape, ontology kinds. */
const MEMORY_GRAPH: GraphWire = {
	built: true,
	nodes: [
		{ id: "e1", label: "Alex", kind: "entity" },
		{ id: "e2", label: "Honeycomb", kind: "entity" },
	],
	edges: [{ from: "e1", to: "e2", kind: "depends_on" }],
};

const EMPTY: GraphWire = { built: false, nodes: [], edges: [] };

/**
 * A mock wire client returning the given codebase + memory graphs. `graph()` returns whatever the test's
 * `codebaseRef` currently holds (so a test can flip the source from `EMPTY` to a built graph to simulate a
 * build re-hydrate); `buildGraph` is a vi.fn the test overrides per-case.
 */
function mockWire(codebase: GraphWire, memory: GraphWire, buildGraph?: () => Promise<{ built: boolean; nodeCount: number; edgeCount: number; fileCount: number }>): WireClient {
	return {
		kpis: vi.fn(),
		sessions: vi.fn(),
		settings: vi.fn(),
		rules: vi.fn(),
		skills: vi.fn(),
		graph: vi.fn(async () => codebase),
		memoryGraph: vi.fn(async () => memory),
		recall: vi.fn(),
		logs: vi.fn(async () => []),
		harnesses: vi.fn(),
		health: vi.fn(),
		pollinate: vi.fn(),
		buildGraph: buildGraph ? vi.fn(buildGraph) : vi.fn(async () => ({ built: false, nodeCount: 0, edgeCount: 0, fileCount: 0 })),
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

/** Mount the page and flush the usePoll fetch-on-mount microtask so state settles. */
async function mountPage(wire: WireClient): Promise<void> {
	await act(async () => {
		root = createRoot(container);
		root.render(<GraphPage {...pageProps(wire)} />);
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

describe("PRD-041a pure helpers (layout reuse + filter/search/viewbox)", () => {
	it("distinctKinds returns the snapshot's real kinds in first-seen order (a-AC-4 — not hardcoded)", () => {
		expect(distinctKinds(CODEBASE_GRAPH)).toEqual(["file", "function"]);
		expect(distinctKinds(MEMORY_GRAPH)).toEqual(["entity"]);
		expect(distinctKinds(EMPTY)).toEqual([]);
	});

	it("applyKindFilter hides a kind's nodes AND edges incident only to hidden nodes (a-AC-4)", () => {
		const filtered = applyKindFilter(CODEBASE_GRAPH, new Set(["function"]));
		// fetchGraphView (the only `function`) is dropped; both `calls` edges into it are dropped too.
		expect(filtered.nodes.map((n) => n.id)).not.toContain("fetchGraphView");
		expect(filtered.nodes).toHaveLength(3);
		expect(filtered.edges).toHaveLength(1); // only server.ts→api.ts (imports) survives
		expect(filtered.edges[0]?.kind).toBe("imports");
		// No hidden kinds → the graph is returned unchanged.
		expect(applyKindFilter(CODEBASE_GRAPH, new Set())).toBe(CODEBASE_GRAPH);
	});

	it("findNode locates by id OR label, case-insensitive substring; empty query → null (a-AC-5)", () => {
		expect(findNode(CODEBASE_GRAPH, "SERVER")).toBe("src/daemon/server.ts"); // label match, case-insensitive
		expect(findNode(CODEBASE_GRAPH, "dashboard/api")).toBe("src/daemon/runtime/dashboard/api.ts"); // id substring
		expect(findNode(CODEBASE_GRAPH, "")).toBeNull();
		expect(findNode(CODEBASE_GRAPH, "   ")).toBeNull();
		expect(findNode(CODEBASE_GRAPH, "no-such-node")).toBeNull();
	});

	it("viewBoxFor reflects scale (zoom shows less) + translate (pan) — deterministic (a-AC-2)", () => {
		// Identity: the whole base box (1600×1000) from the origin.
		expect(viewBoxFor({ scale: 1, tx: 0, ty: 0 })).toBe("0 0 1600 1000");
		// 2× zoom shows half the box; a pan translates the origin.
		expect(viewBoxFor({ scale: 2, tx: 100, ty: 50 })).toBe("100 50 800 500");
	});

	it("splitNeighbors splits by direction AND relation; works for memory relations too (a-AC-3 / b-AC-3)", () => {
		const api = splitNeighbors("src/daemon/runtime/dashboard/api.ts", CODEBASE_GRAPH.edges);
		// incoming: server.ts via `imports`; outgoing: fetchGraphView via `calls`.
		expect(api.incoming).toEqual([{ kind: "imports", ids: ["src/daemon/server.ts"] }]);
		expect(api.outgoing).toEqual([{ kind: "calls", ids: ["fetchGraphView"] }]);
		// The memory graph's `depends_on` relation splits with NO special-casing.
		const e1 = splitNeighbors("e1", MEMORY_GRAPH.edges);
		expect(e1.outgoing).toEqual([{ kind: "depends_on", ids: ["e2"] }]);
		expect(e1.incoming).toEqual([]);
	});
});

// ── Render-all (a-AC-1) ─────────────────────────────────────────────────────────

describe("PRD-041a: the page renders the FULL graph (every node + every edge)", () => {
	it("a-AC-1 draws all N nodes and all M edges of the built GraphView (arbitrary ids, no skip)", async () => {
		await mountPage(mockWire(CODEBASE_GRAPH, EMPTY));
		expect(container.querySelectorAll('g[role="button"]')).toHaveLength(CODEBASE_GRAPH.nodes.length);
		expect(container.querySelectorAll("line")).toHaveLength(CODEBASE_GRAPH.edges.length);
		// One node-fill circle per node (no selection → no extra ring circle).
		expect(container.querySelectorAll("circle")).toHaveLength(CODEBASE_GRAPH.nodes.length);
		// Arbitrary-id labels render as text.
		expect(container.textContent ?? "").toContain("server.ts");
		expect(container.textContent ?? "").toContain("fetchGraphView()");
		// The eyebrow reflects the live counts + the active source.
		expect(container.textContent ?? "").toContain("codebase · 4 nodes · 3 edges");
	});
});

// ── Pan / zoom / fit (a-AC-2) ────────────────────────────────────────────────────

describe("PRD-041a: pan + bounded zoom + fit/reset (a-AC-2)", () => {
	it("a wheel zoom changes the canvas viewBox; fit resets it", async () => {
		await mountPage(mockWire(CODEBASE_GRAPH, EMPTY));
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
		await mountPage(mockWire(CODEBASE_GRAPH, EMPTY));
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

// ── Click → detail (a-AC-3) ─────────────────────────────────────────────────────

describe("PRD-041a: click-to-select → detail panel with split neighbors + caveat (a-AC-3)", () => {
	it("clicking a node opens the panel with id/label/kind + outgoing/incoming relations + the caveat", async () => {
		await mountPage(mockWire(CODEBASE_GRAPH, EMPTY));
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
		// The honest cross-file-calls caveat is shown.
		expect(container.querySelector('[data-testid="calls-caveat"]')?.textContent).toContain("not proof of dead code");
	});

	it("a-AC-3 clearing the selection (re-click) removes the detail panel", async () => {
		await mountPage(mockWire(CODEBASE_GRAPH, EMPTY));
		clickNode("server.ts");
		expect(container.querySelector('[data-testid="graph-detail-panel"]')).not.toBeNull();
		clickNode("server.ts");
		expect(container.querySelector('[data-testid="graph-detail-panel"]')).toBeNull();
	});
});

// ── Kind filters (a-AC-4) ────────────────────────────────────────────────────────

describe("PRD-041a: kind filters from real kinds; toggle hides nodes + edges + updates counts (a-AC-4)", () => {
	it("renders a toggle per REAL kind and toggling a kind off removes its nodes + incident edges", async () => {
		await mountPage(mockWire(CODEBASE_GRAPH, EMPTY));
		// Toggles for the real distinct kinds only (file, function) — no hardcoded class/etc.
		expect(container.querySelector('[data-testid="kind-toggle-file"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="kind-toggle-function"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="kind-toggle-class"]')).toBeNull();

		// Hide `function` → fetchGraphView + its 2 `calls` edges vanish; counts update in the eyebrow.
		const fnToggle = container.querySelector('[data-testid="kind-toggle-function"]') as HTMLButtonElement;
		act(() => fnToggle.click());
		expect(container.querySelectorAll('g[role="button"]')).toHaveLength(3); // 4 − 1
		expect(container.querySelectorAll("line")).toHaveLength(1); // 3 − 2 calls
		expect(container.textContent ?? "").toContain("codebase · 3 nodes · 1 edges");
	});
});

// ── Search (a-AC-5) ──────────────────────────────────────────────────────────────

describe("PRD-041a: search focuses + selects the matching node (a-AC-5)", () => {
	it("typing a query selects the matching node (its detail panel opens)", async () => {
		await mountPage(mockWire(CODEBASE_GRAPH, EMPTY));
		typeSearch("panels");
		// panels.tsx is selected → its detail panel is shown.
		const panel = container.querySelector('[data-testid="graph-detail-panel"]');
		expect(panel).not.toBeNull();
		expect(panel?.textContent).toContain("src/dashboard/web/panels.tsx");
	});
});

// ── Empty state (a-AC-6) ─────────────────────────────────────────────────────────

describe("PRD-041a: built:false → the full-page empty state with a working Build graph button (a-AC-6)", () => {
	it("renders the Build graph button (not a dead CLI prompt), not an error or a blank canvas", async () => {
		await mountPage(mockWire(EMPTY, EMPTY));
		expect(container.querySelector('[data-testid="graph-empty-state"]')).not.toBeNull();
		expect(container.textContent ?? "").toContain("No graph built for this workspace.");
		// The empty state now offers a real Build graph BUTTON (replacing the old `honeycomb graph build` hint).
		const buildBtn = container.querySelector('[data-testid="build-graph-button"]');
		expect(buildBtn, "the Build graph button is present").not.toBeNull();
		expect(buildBtn?.textContent).toBe("Build graph");
		// No canvas in the empty state; no dead CLI prompt shown by default (it only appears on failure).
		expect(container.querySelector('[data-testid="graph-canvas"]')).toBeNull();
		expect(container.textContent ?? "").not.toContain("honeycomb graph build");
	});

	it("the memory-source empty state shows NO build button (no build command exists for it)", async () => {
		const wire = mockWire(EMPTY, EMPTY);
		await mountPage(wire);
		const toMem = container.querySelector('[data-testid="source-memory"]') as HTMLButtonElement;
		await act(async () => {
			toMem.click();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(container.querySelector('[data-testid="graph-empty-state"]')).not.toBeNull();
		expect(container.textContent ?? "").toContain("No memory graph yet for this workspace.");
		// The memory empty state stays UNCHANGED — no build button, no CLI hint.
		expect(container.querySelector('[data-testid="build-graph-button"]')).toBeNull();
	});
});

// ── Build graph button behavior (the new wired build) ─────────────────────────────

describe("PRD-041a: the Build graph button triggers the daemon build and re-hydrates on success", () => {
	it("clicking Build graph calls wire.buildGraph() once (even on a double-click) and shows the in-flight label", async () => {
		// graph() returns EMPTY first (empty state), then the built graph after a successful build — so the
		// re-hydrate swaps the empty state for the drawn graph.
		let built = false;
		const wire = mockWire(EMPTY, EMPTY);
		(wire.graph as ReturnType<typeof vi.fn>).mockImplementation(async () => (built ? CODEBASE_GRAPH : EMPTY));
		let resolveBuild: (v: { built: boolean; nodeCount: number; edgeCount: number; fileCount: number }) => void = () => {};
		(wire.buildGraph as ReturnType<typeof vi.fn>).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveBuild = resolve;
				}),
		);
		await mountPage(wire);

		const btn = container.querySelector('[data-testid="build-graph-button"]') as HTMLButtonElement;
		// Double-click rapidly — the synchronous re-entry guard must fire exactly one POST.
		await act(async () => {
			btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		// In-flight label + disabled, and buildGraph called exactly once despite two clicks.
		expect(container.querySelector('[data-testid="build-graph-button"]')?.textContent).toBe("Building…");
		expect(wire.buildGraph).toHaveBeenCalledTimes(1);

		// Resolve the build successfully → the page re-hydrates and the graph (not the empty state) renders.
		built = true;
		await act(async () => {
			resolveBuild({ built: true, nodeCount: 4, edgeCount: 3, fileCount: 3 });
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(container.querySelector('[data-testid="graph-empty-state"]')).toBeNull();
		expect(container.querySelector('[data-testid="graph-canvas"]')).not.toBeNull();
		expect(container.textContent ?? "").toContain("server.ts");
	});

	it("a { built: false } ack shows the inline error + keeps the CLI hint, and the empty state stays", async () => {
		const wire = mockWire(EMPTY, EMPTY, async () => ({ built: false, nodeCount: 0, edgeCount: 0, fileCount: 0 }));
		await mountPage(wire);
		const btn = container.querySelector('[data-testid="build-graph-button"]') as HTMLButtonElement;
		await act(async () => {
			btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await Promise.resolve();
			await Promise.resolve();
		});
		// The empty state is still shown (no build happened) with an honest error + the CLI hint for power users.
		expect(container.querySelector('[data-testid="graph-empty-state"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="build-graph-error"]')).not.toBeNull();
		expect(container.textContent ?? "").toContain("honeycomb graph build");
		// The button returns to its idle label (not a forever spinner).
		expect(container.querySelector('[data-testid="build-graph-button"]')?.textContent).toBe("Build graph");
	});
});

// ── 041b: the Codebase ↔ Memory toggle ───────────────────────────────────────────

describe("PRD-041b: the Codebase ↔ Memory toggle swaps the source on the SAME canvas", () => {
	it("b-AC-3 switching to Memory fetches the memory endpoint and renders it; back restores codebase", async () => {
		const wire = mockWire(CODEBASE_GRAPH, MEMORY_GRAPH);
		await mountPage(wire);
		// Start on codebase: server.ts is drawn.
		expect(container.textContent ?? "").toContain("server.ts");

		// Switch to Memory.
		const toMem = container.querySelector('[data-testid="source-memory"]') as HTMLButtonElement;
		await act(async () => {
			toMem.click();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(wire.memoryGraph).toHaveBeenCalled();
		// The memory graph renders on the SAME canvas (entity nodes drawn, eyebrow says memory).
		expect(container.querySelectorAll('g[role="button"]')).toHaveLength(MEMORY_GRAPH.nodes.length);
		expect(container.textContent ?? "").toContain("Alex");
		expect(container.textContent ?? "").toContain("memory · 2 nodes · 1 edges");

		// A memory node's detail panel shows the `depends_on` relation (no special-casing).
		clickNode("Alex");
		expect(container.querySelector('[data-testid="detail-outgoing"]')?.textContent).toContain("depends_on");

		// Switch back to Codebase → the codebase graph is restored.
		const toCode = container.querySelector('[data-testid="source-codebase"]') as HTMLButtonElement;
		await act(async () => {
			toCode.click();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(container.textContent ?? "").toContain("server.ts");
		expect(container.textContent ?? "").toContain("codebase · 4 nodes · 3 edges");
	});

	it("b-AC-4 an empty memory graph shows the honest 'no memory graph yet' state (no faked graph, no fake command)", async () => {
		const wire = mockWire(CODEBASE_GRAPH, EMPTY);
		await mountPage(wire);
		const toMem = container.querySelector('[data-testid="source-memory"]') as HTMLButtonElement;
		await act(async () => {
			toMem.click();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(container.querySelector('[data-testid="graph-empty-state"]')).not.toBeNull();
		expect(container.textContent ?? "").toContain("No memory graph yet for this workspace.");
		// It must NOT invent a build command that does not exist (OQ-6) — no `honeycomb` graph command here.
		expect(container.textContent ?? "").not.toContain("honeycomb graph build");
		expect(container.querySelector('[data-testid="graph-canvas"]')).toBeNull();
	});
});
