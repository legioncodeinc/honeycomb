/**
 * Canonical serialization + content hash — PRD-014b Wave 2 (FR-8 / FR-9 / b-AC-2 /
 * index AC-1 — the DETERMINISM guarantee).
 *
 * `computeSnapshotSha256` hashes ONLY the STABLE fields of a {@link Snapshot}
 * (`directed`, `multigraph`, `graph`, `nodes`, `links`) and EXCLUDES every VOLATILE
 * `observation` block — both the snapshot-level one AND each node's. So two builds of
 * byte-identical source content, on different worktrees / branches / at different times,
 * yield the SAME hash → one stored row (the dedup contract, D-6).
 *
 * Two disciplines make it deterministic:
 *   1. STABLE ORDER (`buildSnapshot`): nodes sorted by `id`, links sorted by
 *      `(source, target, relation, ord)`. Discovery/walk order must never leak into the
 *      hash — node ids are already line-free (Wave-1), so a moved unrelated symbol does
 *      not perturb identity, but the LIST order must be normalized too.
 *   2. CANONICAL JSON (`canonicalJSON`): object keys sorted at EVERY nesting level, no
 *      inserted whitespace. Two structurally-equal objects serialize to identical bytes
 *      regardless of key insertion order.
 *
 * The hash input is built by `stableProjection`: it strips `observation` from the
 * snapshot and from each node, leaving only STABLE content, then `canonicalJSON`-encodes
 * that and sha256s the UTF-8 bytes.
 */

import { createHash } from "node:crypto";

import { type GraphNode, type Snapshot, type SnapshotLink } from "./contracts.js";

/**
 * Produce the FINAL snapshot from a resolved one (FR-8): nodes sorted by `id`, links
 * sorted by `(source, target, relation, ord)`. Pure — returns a new snapshot with the
 * same fields in canonical list order. The `observation` block is carried through
 * untouched (it is excluded only at HASH time, not dropped from the stored snapshot).
 */
export function buildSnapshot(snapshot: Snapshot): Snapshot {
	const nodes = [...snapshot.nodes].sort(compareNodes);
	const links = [...snapshot.links].sort(compareLinks);
	return { ...snapshot, nodes, links };
}

/** Sort nodes by their STABLE `id` (a total order — ids are unique per node). */
function compareNodes(a: GraphNode, b: GraphNode): number {
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Sort links by `(source, target, relation, ord)` (FR-8) — a total order over the multigraph. */
function compareLinks(a: SnapshotLink, b: SnapshotLink): number {
	if (a.source !== b.source) return a.source < b.source ? -1 : 1;
	if (a.target !== b.target) return a.target < b.target ? -1 : 1;
	if (a.relation !== b.relation) return a.relation < b.relation ? -1 : 1;
	const ao = a.ord ?? -1;
	const bo = b.ord ?? -1;
	if (ao !== bo) return ao < bo ? -1 : 1;
	// Final tiebreak on the edge id so the order is fully determined even for identical
	// (source,target,relation,ord) — keeps the sort STABLE and reproducible.
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The STABLE projection of a snapshot — what the hash sees (FR-9). Strips the snapshot-
 * level `observation` and EACH node's `observation`, leaving `directed`/`multigraph`/
 * `graph`/`nodes`(stable fields)/`links`. Edges have no volatile fields so links pass
 * through whole.
 *
 * Nodes and links are RE-SORTED here (the same canonical order as `buildSnapshot`) so the
 * hash is order-INDEPENDENT — a caller that passes an unsorted snapshot (e.g. 014c's
 * pull-revalidation deserializing a stored payload) still gets the canonical hash. The
 * hash never depends on the input list order, only on content.
 */
function stableProjection(snapshot: Snapshot): unknown {
	return {
		directed: snapshot.directed,
		multigraph: snapshot.multigraph,
		graph: snapshot.graph,
		nodes: [...snapshot.nodes].sort(compareNodes).map(stableNode),
		links: [...snapshot.links].sort(compareLinks),
	};
}

/** A node's STABLE fields only — `observation` (lines + degrees) excluded (D-6). */
function stableNode(node: GraphNode): Record<string, unknown> {
	const out: Record<string, unknown> = {
		id: node.id,
		kind: node.kind,
		name: node.name,
		sourceFile: node.sourceFile,
		language: node.language,
	};
	if (node.symbolKind !== undefined) out.symbolKind = node.symbolKind;
	if (node.exported !== undefined) out.exported = node.exported;
	return out;
}

/**
 * Canonical JSON (FR-8): object keys sorted at every nesting level, arrays in their
 * given order, no inserted whitespace. Two structurally-equal values produce identical
 * bytes. Used as the hash input and as the on-disk canonical form.
 */
export function canonicalJSON(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

/** Recursively sort object keys (arrays keep order, primitives pass through). */
function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value !== null && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(obj).sort()) {
			const v = obj[key];
			if (v === undefined) continue; // a missing optional must not perturb the bytes.
			sorted[key] = sortValue(v);
		}
		return sorted;
	}
	return value;
}

/**
 * The canonical content hash of a snapshot (FR-9 / b-AC-2). sha256 of the canonical-JSON
 * STABLE projection — `observation` blocks EXCLUDED. Identical content anywhere →
 * identical hash. This is the entire determinism guarantee (index AC-1).
 */
export function computeSnapshotSha256(snapshot: Snapshot): string {
	const canonical = canonicalJSON(stableProjection(snapshot));
	return createHash("sha256").update(canonical, "utf8").digest("hex");
}
