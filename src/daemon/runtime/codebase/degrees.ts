/**
 * Node-degree annotation — PRD-014b Wave 2 (FR-6 / b-AC-5).
 *
 * `annotateNodeDegrees` sets `fan_in`, `fan_out`, and `is_entrypoint` on every node from
 * the COMPLETE RESOLVED edge set — so it runs AFTER `resolveLinks` (degrees must reflect
 * cross-file reality, not the placeholder edges). These three live in the VOLATILE
 * `NodeObservation` block, so they are EXCLUDED from `computeSnapshotSha256` (D-6) — a
 * degree is derived, post-resolution, and would otherwise break content-dedup.
 *
 *   - `fanOut` = the number of resolved edges LEAVING the node (its `source`).
 *   - `fanIn`  = the number of resolved edges ARRIVING at the node (its `target`).
 *   - `isEntrypoint` = `exported && fanIn === 0` (FR-6): an exported symbol nothing in
 *     this graph calls/imports/extends — a public surface or a dead-code candidate (the
 *     014d caveat: incoming-0 is not PROOF of dead code, only a candidate).
 *
 * Only edges to/from REAL nodes count: an `imports` edge still pointing at an
 * `external:<specifier>` (a bare npm module we could not ground) has no node to credit,
 * so it does not inflate any node's fan-in. Pure — returns a new snapshot with the same
 * STABLE fields and a freshly-computed `observation` per node.
 */

import { type GraphNode, isExternalTarget, type Snapshot } from "./contracts.js";

/**
 * Annotate `fanIn` / `fanOut` / `isEntrypoint` on every node from the resolved links
 * (FR-6 / b-AC-5). Counts only edges incident to real nodes (an `external:` target has
 * no node). Mutates ONLY the VOLATILE `observation` — STABLE identity is untouched, so
 * the snapshot hash is unaffected.
 */
export function annotateNodeDegrees(snapshot: Snapshot): Snapshot {
	const fanIn = new Map<string, number>();
	const fanOut = new Map<string, number>();
	const nodeIds = new Set(snapshot.nodes.map((n) => n.id));

	for (const link of snapshot.links) {
		// Source is always a real node (a symbol/file in this graph). Target may still be
		// an `external:` placeholder (an unresolvable import) → it credits no node's fan-in.
		if (nodeIds.has(link.source)) {
			fanOut.set(link.source, (fanOut.get(link.source) ?? 0) + 1);
		}
		if (!isExternalTarget(link.target) && nodeIds.has(link.target)) {
			fanIn.set(link.target, (fanIn.get(link.target) ?? 0) + 1);
		}
	}

	const nodes = snapshot.nodes.map((node) => annotate(node, fanIn.get(node.id) ?? 0, fanOut.get(node.id) ?? 0));
	return { ...snapshot, nodes };
}

/** Set the three derived degree fields in a node's VOLATILE observation (a new node object). */
function annotate(node: GraphNode, fanIn: number, fanOut: number): GraphNode {
	return {
		...node,
		observation: {
			...node.observation,
			fanIn,
			fanOut,
			isEntrypoint: node.exported === true && fanIn === 0,
		},
	};
}
