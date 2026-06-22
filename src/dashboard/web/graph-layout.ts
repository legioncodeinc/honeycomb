/**
 * The codebase-graph LAYOUT — PRD-035c (D-1, FR-2, FR-8).
 *
 * A pure, deterministic node-placement function shared by the dashboard mini-widget
 * ({@link import("./panels.js").GraphCanvas}) and, later, the PRD-041 full-page graph. It
 * replaces the old hardcoded `NODE_POS` map (which keyed on six fixed ids like `daemon`/`recall`
 * that REAL snapshot ids — file paths / symbols — never matched, so every node was skipped and
 * the canvas rendered blank). Here every node gets a computed position, so an arbitrary-id
 * snapshot draws every node and edge.
 *
 * Determinism is the contract: the placement is a pure function of (node order, count, viewBox)
 * with NO randomness, NO animation loop, and NO time/Date input — so a render is stable and a
 * unit test can assert exact coordinates (PRD-035c AC-7 / OQ-1). The shape is the radial/grid
 * placement OQ-1 settled on: one node is centered, the rest sit on a ring around it, ordered by
 * their index in the input array.
 */

/** A graph node as the wire ships it — id + display label + kind (drives fill color). */
export interface LayoutNode {
	readonly id: string;
	readonly label: string;
	readonly kind: string;
}

/** A graph edge as the wire ships it — endpoint ids + a kind. */
export interface LayoutEdge {
	readonly from: string;
	readonly to: string;
	readonly kind: string;
}

/** A computed 2-D position inside the canvas viewBox. */
export interface Point {
	readonly x: number;
	readonly y: number;
}

/** The canvas box the layout fits inside (origin is `0,0`; width/height are the SVG viewBox extent). */
export interface ViewBox {
	readonly width: number;
	readonly height: number;
}

/** Inset (px) kept clear on every edge so node marks + labels never clip the canvas border. */
const PADDING = 28;

/**
 * Compute a deterministic position for every node, keyed on its index in `nodes` (D-1, FR-2).
 *
 * Placement (radial, stable):
 *   - 0 nodes → an empty map.
 *   - 1 node  → centered.
 *   - 2+ nodes → the FIRST node is centered; the remaining `n-1` sit evenly on a ring around it,
 *     starting at the top (−90°) and going clockwise. The ring radius is the largest circle that
 *     fits inside the padded box, so marks never clip.
 *
 * The result is a `Map<id, Point>` so the caller looks a position up by node id (and an edge looks
 * up its two endpoints). A later node with a duplicate id would overwrite an earlier one in the
 * map; real snapshots have unique ids (file paths / symbols), so this is a non-issue in practice
 * and keeps the function total. The `edges` argument is accepted for signature stability with a
 * future force-directed variant (PRD-041) but is not consulted by this deterministic placement.
 *
 * @param nodes   the graph nodes, in render order (the order fixes each node's slot).
 * @param _edges  the graph edges (unused by the deterministic radial placement; kept for the
 *                shared signature PRD-041 reuses).
 * @param viewBox the canvas extent the positions must fit inside.
 * @returns a map from node id to its computed `{x, y}` position.
 */
export function layout(
	nodes: readonly LayoutNode[],
	_edges: readonly LayoutEdge[],
	viewBox: ViewBox,
): Map<string, Point> {
	const positions = new Map<string, Point>();
	const n = nodes.length;
	if (n === 0) return positions;

	const cx = viewBox.width / 2;
	const cy = viewBox.height / 2;

	// One node → dead center.
	if (n === 1) {
		const only = nodes[0];
		if (only !== undefined) positions.set(only.id, { x: cx, y: cy });
		return positions;
	}

	// Center the first node; ring the rest. The radius is the largest that fits the padded box.
	const radius = Math.max(0, Math.min(cx, cy) - PADDING);
	const ringCount = n - 1;
	for (let i = 0; i < n; i++) {
		const node = nodes[i];
		if (node === undefined) continue;
		if (i === 0) {
			positions.set(node.id, { x: cx, y: cy });
			continue;
		}
		// Ring slot (i-1) of `ringCount`, starting at the top (−90°) and stepping clockwise.
		const angle = -Math.PI / 2 + (2 * Math.PI * (i - 1)) / ringCount;
		positions.set(node.id, {
			x: cx + radius * Math.cos(angle),
			y: cy + radius * Math.sin(angle),
		});
	}
	return positions;
}

/**
 * The neighbor ids of `id` in `edges` (D-3, FR-5): every node reachable by an edge with `id` on
 * either end (`from === id` OR `to === id`). Self-loops and an id absent from the edge set yield an
 * empty list. The result is de-duplicated and preserves first-seen edge order so the detail surface
 * lists neighbors stably. Pure — no DOM, no state — so it is unit-assertable alongside {@link layout}.
 *
 * @param id    the selected node's id.
 * @param edges the graph edges.
 * @returns the de-duplicated neighbor ids, in first-seen order.
 */
export function neighborsOf(id: string, edges: readonly LayoutEdge[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const e of edges) {
		let other: string | null = null;
		if (e.from === id && e.to !== id) other = e.to;
		else if (e.to === id && e.from !== id) other = e.from;
		if (other !== null && !seen.has(other)) {
			seen.add(other);
			out.push(other);
		}
	}
	return out;
}
