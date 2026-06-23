// @vitest-environment jsdom
/**
 * PRD-035c — the {@link GraphCanvas} render + interactivity suite.
 *
 * The old `GraphCanvas` positioned nodes from a HARDCODED `NODE_POS` map keyed on six fixed ids
 * (`daemon`/`capture`/…). Real snapshot ids are file paths / symbols, which never matched, so
 * every node + edge was skipped and the canvas rendered blank despite an "N nodes · M edges"
 * header. This suite mounts the REAL `GraphCanvas` into jsdom with a fake BUILT `GraphWire` whose
 * ids are ARBITRARY strings (file paths + symbols, NOT the legacy keys) and asserts:
 *   - all N nodes render (N `<circle>` marks for the node fills) and all M edges render (M `<line>`s);
 *   - the eyebrow "N nodes · M edges" equals the drawn counts (AC-1 / AC-2 / AC-6);
 *   - clicking a node selects it and surfaces a detail block with its id / kind / label + the
 *     neighbor labels matching the snapshot edges (AC-3);
 *   - clicking the selected node again / clicking the canvas clears the selection (AC-4);
 *   - the `built: false` branch still renders the `honeycomb graph build` prompt (AC-5).
 *
 * The pure {@link layout} / {@link neighborsOf} helpers are unit-asserted directly too (FR-8) so the
 * deterministic placement PRD-041 reuses is locked down without a DOM.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { layout, neighborsOf } from "../../../src/dashboard/web/graph-layout.js";
import { GraphCanvas } from "../../../src/dashboard/web/panels.js";
import type { BuildGraphAck, GraphWire, WireClient } from "../../../src/dashboard/web/wire.js";

// React 18's act() environment flag — silences the "not wrapped in act(...)" warning.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A built graph whose node ids are ARBITRARY real-world strings (file paths + a symbol) — NOT the
 * six legacy `NODE_POS` keys — so the suite proves the computed layout draws arbitrary ids (AC-2).
 * Edges connect them so neighbor assertions have something to match.
 */
const BUILT_GRAPH: GraphWire = {
	built: true,
	nodes: [
		{ id: "src/daemon/server.ts", label: "server.ts", kind: "file" },
		{ id: "src/daemon/runtime/dashboard/api.ts", label: "api.ts", kind: "file" },
		{ id: "fetchGraphView", label: "fetchGraphView()", kind: "function" },
		{ id: "src/dashboard/web/panels.tsx", label: "panels.tsx", kind: "file" },
	],
	edges: [
		{ from: "src/daemon/server.ts", to: "src/daemon/runtime/dashboard/api.ts", kind: "imports" },
		{ from: "src/daemon/runtime/dashboard/api.ts", to: "fetchGraphView", kind: "defines" },
		{ from: "src/dashboard/web/panels.tsx", to: "fetchGraphView", kind: "calls" },
	],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

/** Mount the canvas with the given graph, flushing the initial render. */
function mount(graph: GraphWire, pollinating = false): void {
	act(() => {
		root = createRoot(container);
		root.render(<GraphCanvas graph={graph} pollinating={pollinating} />);
	});
}

/** Mount the canvas with a threaded wire + onBuilt (the production home-page wiring). */
function mountWithWire(graph: GraphWire, wire: WireClient, onBuilt: () => void | Promise<void>): void {
	act(() => {
		root = createRoot(container);
		root.render(<GraphCanvas graph={graph} pollinating={false} wire={wire} onBuilt={onBuilt} />);
	});
}

/** A minimal mock wire whose only used method is buildGraph (the panel's empty state needs just that). */
function buildWire(ack: BuildGraphAck): WireClient {
	return { buildGraph: vi.fn(async () => ack) } as unknown as WireClient;
}

/** Click the node `<g role="button">` whose aria-label matches the node's label. */
function clickNode(label: string): void {
	const g = [...container.querySelectorAll('g[role="button"]')].find((el) => el.getAttribute("aria-label") === `node ${label}`);
	expect(g, `node group for "${label}"`).toBeDefined();
	act(() => {
		g?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

/** Click the bare SVG canvas (the empty-area clear target). */
function clickCanvas(): void {
	const svg = container.querySelector("svg");
	act(() => {
		svg?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

describe("GraphCanvas render (built graph, arbitrary ids)", () => {
	it("draws every node and every edge for an arbitrary-id snapshot (AC-1 / AC-2)", () => {
		mount(BUILT_GRAPH);
		// One <line> per edge (3) and one node-fill <circle> per node (4). No node is selected, so
		// there is no extra highlight-ring circle — circle count equals node count exactly.
		expect(container.querySelectorAll("line")).toHaveLength(BUILT_GRAPH.edges.length);
		expect(container.querySelectorAll("circle")).toHaveLength(BUILT_GRAPH.nodes.length);
		// Every node group is present and labelled with the real (non-legacy) label.
		expect(container.querySelectorAll('g[role="button"]')).toHaveLength(BUILT_GRAPH.nodes.length);
		expect(container.textContent ?? "").toContain("server.ts");
		expect(container.textContent ?? "").toContain("fetchGraphView()");
	});

	it("the eyebrow 'N nodes · M edges' equals the drawn counts (AC-6)", () => {
		mount(BUILT_GRAPH);
		expect(container.textContent ?? "").toContain("4 nodes · 3 edges");
	});
});

describe("GraphCanvas interactivity (select / detail / clear)", () => {
	it("clicking a node surfaces its id, kind, label, and neighbors (AC-3)", () => {
		mount(BUILT_GRAPH);
		expect(container.querySelector('[data-testid="graph-node-detail"]')).toBeNull();

		clickNode("api.ts");
		const detail = container.querySelector('[data-testid="graph-node-detail"]');
		expect(detail).not.toBeNull();
		const text = detail?.textContent ?? "";
		// id + label + kind all present.
		expect(text).toContain("src/daemon/runtime/dashboard/api.ts");
		expect(text).toContain("api.ts");
		expect(text).toContain("file");
		// Neighbors of api.ts: server.ts (from→api.ts) and fetchGraphView (api.ts→from). Listed by label.
		expect(text).toContain("server.ts");
		expect(text).toContain("fetchGraphView()");
		// panels.tsx is NOT a neighbor of api.ts (no edge between them).
		expect(text).not.toContain("panels.tsx");
	});

	it("re-clicking the selected node clears the selection (AC-4)", () => {
		mount(BUILT_GRAPH);
		clickNode("api.ts");
		expect(container.querySelector('[data-testid="graph-node-detail"]')).not.toBeNull();
		clickNode("api.ts");
		expect(container.querySelector('[data-testid="graph-node-detail"]')).toBeNull();
	});

	it("clicking empty canvas clears the selection (AC-4)", () => {
		mount(BUILT_GRAPH);
		clickNode("server.ts");
		expect(container.querySelector('[data-testid="graph-node-detail"]')).not.toBeNull();
		clickCanvas();
		expect(container.querySelector('[data-testid="graph-node-detail"]')).toBeNull();
	});

	it("a selected node draws an extra highlight ring (AC / FR-6)", () => {
		mount(BUILT_GRAPH);
		const before = container.querySelectorAll("circle").length;
		clickNode("server.ts");
		// The highlight ring adds one circle on top of the node-fill circles.
		expect(container.querySelectorAll("circle").length).toBe(before + 1);
	});
});

describe("GraphCanvas empty state (built: false)", () => {
	it("with a wire threaded, renders the working Build graph button (not the dead CLI prompt)", () => {
		mountWithWire({ built: false, nodes: [], edges: [] }, buildWire({ built: false, nodeCount: 0, edgeCount: 0, fileCount: 0 }), () => {});
		expect(container.textContent ?? "").toContain("No graph built for this workspace.");
		const btn = container.querySelector('[data-testid="build-graph-button"]');
		expect(btn, "the Build graph button is present").not.toBeNull();
		expect(btn?.textContent).toBe("Build graph");
		// No canvas / node groups in the empty state.
		expect(container.querySelector('g[role="button"]')).toBeNull();
	});

	it("clicking Build graph posts once (double-click guarded) and re-hydrates via onBuilt on success", async () => {
		const onBuilt = vi.fn();
		const wire = buildWire({ built: true, nodeCount: 4, edgeCount: 3, fileCount: 3 });
		mountWithWire({ built: false, nodes: [], edges: [] }, wire, onBuilt);
		const btn = container.querySelector('[data-testid="build-graph-button"]') as HTMLButtonElement;
		await act(async () => {
			btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		// Exactly one POST despite the double-click; onBuilt fired to re-hydrate the panel's graph.
		expect(wire.buildGraph).toHaveBeenCalledTimes(1);
		expect(onBuilt).toHaveBeenCalledTimes(1);
	});

	it("a failed build keeps the empty state, shows the inline error + the CLI hint for power users", async () => {
		const onBuilt = vi.fn();
		const wire = buildWire({ built: false, nodeCount: 0, edgeCount: 0, fileCount: 0 });
		mountWithWire({ built: false, nodes: [], edges: [] }, wire, onBuilt);
		const btn = container.querySelector('[data-testid="build-graph-button"]') as HTMLButtonElement;
		await act(async () => {
			btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(onBuilt).not.toHaveBeenCalled();
		expect(container.querySelector('[data-testid="build-graph-error"]')).not.toBeNull();
		expect(container.textContent ?? "").toContain("honeycomb graph build");
	});

	it("without a wire (defensive direct mount), falls back to the CLI prompt unchanged (AC-5)", () => {
		mount({ built: false, nodes: [], edges: [] });
		expect(container.textContent ?? "").toContain("honeycomb graph build");
		expect(container.textContent ?? "").toContain("No graph built for this workspace.");
		// No canvas / node groups in the empty state.
		expect(container.querySelector("svg")).toBeNull();
		expect(container.querySelectorAll('g[role="button"]')).toHaveLength(0);
	});
});

describe("layout()/neighborsOf() pure helpers (FR-8 — PRD-041 reuse)", () => {
	const box = { width: 540, height: 200 };

	it("returns a deterministic position for every node, all inside the viewBox", () => {
		const pos = layout(BUILT_GRAPH.nodes, BUILT_GRAPH.edges, box);
		expect(pos.size).toBe(BUILT_GRAPH.nodes.length);
		for (const node of BUILT_GRAPH.nodes) {
			const p = pos.get(node.id);
			expect(p, node.id).toBeDefined();
			expect(p?.x).toBeGreaterThanOrEqual(0);
			expect(p?.x).toBeLessThanOrEqual(box.width);
			expect(p?.y).toBeGreaterThanOrEqual(0);
			expect(p?.y).toBeLessThanOrEqual(box.height);
		}
		// Deterministic: the same input yields identical coordinates.
		const again = layout(BUILT_GRAPH.nodes, BUILT_GRAPH.edges, box);
		expect([...again.entries()]).toEqual([...pos.entries()]);
	});

	it("centers the first node and rings the rest", () => {
		const pos = layout(BUILT_GRAPH.nodes, BUILT_GRAPH.edges, box);
		expect(pos.get("src/daemon/server.ts")).toEqual({ x: 270, y: 100 });
	});

	it("a single node is centered", () => {
		const pos = layout([{ id: "only", label: "only", kind: "file" }], [], box);
		expect(pos.get("only")).toEqual({ x: 270, y: 100 });
	});

	it("an empty graph yields an empty map", () => {
		expect(layout([], [], box).size).toBe(0);
	});

	it("neighborsOf finds both directions and de-dupes", () => {
		expect(neighborsOf("fetchGraphView", BUILT_GRAPH.edges)).toEqual([
			"src/daemon/runtime/dashboard/api.ts",
			"src/dashboard/web/panels.tsx",
		]);
		expect(neighborsOf("src/daemon/server.ts", BUILT_GRAPH.edges)).toEqual(["src/daemon/runtime/dashboard/api.ts"]);
		expect(neighborsOf("absent", BUILT_GRAPH.edges)).toEqual([]);
	});
});
