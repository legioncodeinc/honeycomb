/**
 * The read-only `graph/` query surface — PRD-014d Wave 2 (FR-1..FR-11 / d-AC-1..6).
 *
 * `handleGraphVfs(path, snapshot)` renders a `graph/...` virtual-filesystem path into
 * plain text, ON THE FLY, from a LOADED LOCAL {@link Snapshot}. It is the READ half of
 * the codebase graph: an agent reads `graph/find/<pattern>`, `graph/impact/<pattern>`,
 * `graph/neighborhood/<file>`, `graph/show/<handle-or-pattern>`, `graph/query/<pattern>`,
 * `graph/layers`, `graph/tour`, `graph/path/<from>/<to>`, or `graph/index.md` and gets
 * back rendered text grounded in the current checkout.
 *
 * ── d-AC-5: ZERO NETWORK (the load-bearing invariant) ───────────────────────────────
 * This module imports ONLY `./contracts.js` (plain interfaces) — no persistence layer, no
 * vector backend, no HTTP client, no filesystem module. It receives an already-loaded
 * snapshot and renders it. PRD-015 owns the VFS MOUNT (it loads the snapshot off disk and
 * hands it here); this renderer never reaches past the in-memory `Snapshot`. The
 * import-boundary invariant test passes because nothing here imports the daemon storage
 * adapter. A renderer that needs the snapshot loaded receives it via the `snapshot`
 * argument (or a load seam the MOUNT injects); it never opens a socket or a file itself.
 *
 * ── Ranking (FR-8) ──────────────────────────────────────────────────────────────────
 * `find/<pattern>` ranks matches: exact label > prefix > id-contains > label-contains,
 * tie-broken by id. On NO substring hit for a single-token pattern, it falls back to a
 * bounded, zero-dependency Levenshtein fuzzy match (FR-9 / d-AC-4) so a one-char typo
 * (`pushSnaphot` → `pushSnapshot`) still finds the node.
 *
 * ── Handles (FR-10 / d-AC-3) ────────────────────────────────────────────────────────
 * `find/` assigns NUMBERED handles (`[1] name  src/a.ts`). They persist per worktree via
 * an injectable {@link HandleStore} (in prod the MOUNT backs it with `.find-handles.json`;
 * in tests an in-memory fake) keyed to the snapshot CONTENT HASH. A follow-up
 * `show/<N>` resolves the handle AND RE-VALIDATES the stored node id against the CURRENT
 * snapshot — if the snapshot changed and the node is gone, the stale handle is refused
 * (never served stale). The store is the ONLY non-pure seam; it is local (a file or
 * memory), never network.
 *
 * ── The honest caveat (FR-11 / d-AC-6) ──────────────────────────────────────────────
 * Cross-file `calls` resolve only for relative named/namespace imports (the 014b
 * high-confidence rule). So an "Incoming (0)" is NOT proof of dead code — every `show/`
 * render of a zero-incoming node carries that caveat, and the `index.md` overview states
 * the limitation up front.
 */

import {
	type EdgeRelation,
	type GraphNode,
	isExternalTarget,
	type Snapshot,
	type SnapshotLink,
} from "./contracts.js";

// ════════════════════════════════════════════════════════════════════════════
// SECTION 1 — The handle store seam (FR-10). The ONLY non-pure dependency, and it
// is LOCAL (a file the MOUNT owns, or memory), never network. Keyed to the snapshot
// content hash so a `show/<N>` re-validates against the SAME snapshot the `find/` ran
// over — a changed snapshot invalidates a stale handle (d-AC-3).
// ════════════════════════════════════════════════════════════════════════════

/**
 * A persisted handle table from a prior `find/` (FR-10). Maps a 1-based handle number to
 * the node id it pointed at, stamped with the `snapshotSha` the `find/` ran over so a
 * later `show/<N>` can detect a stale snapshot and re-validate.
 */
export interface HandleTable {
	/** The `snapshot_sha256` the `find/` that produced these handles ran over. */
	readonly snapshotSha: string;
	/** The substring/fuzzy pattern that produced these handles (for the render header). */
	readonly pattern: string;
	/** 1-based handle number → the node id it resolved to. */
	readonly handles: Readonly<Record<string, string>>;
}

/**
 * The handle persistence seam (FR-10). In production the VFS MOUNT (PRD-015) backs this
 * with `.find-handles.json` per worktree; in tests an in-memory fake. Synchronous +
 * LOCAL — reading/writing a small JSON file, NEVER a network call (preserves d-AC-5).
 * Optional: with NO store, `find/` still renders handles (it just cannot persist them for
 * a follow-up `show/<N>`), and `show/<N>` reports the handle is unavailable.
 */
export interface HandleStore {
	/** Load the last persisted handle table for this worktree, or null if none. */
	read(): HandleTable | null;
	/** Persist the handle table produced by a `find/`. */
	write(table: HandleTable): void;
}

/** A simple in-memory {@link HandleStore} — the default + the test seam. */
export function inMemoryHandleStore(initial?: HandleTable): HandleStore {
	let table: HandleTable | null = initial ?? null;
	return {
		read: () => table,
		write: (t: HandleTable) => {
			table = t;
		},
	};
}

/** Options for {@link handleGraphVfs} (everything is injectable so the renderer stays pure). */
export interface GraphVfsOptions {
	/**
	 * The handle store (FR-10). Defaults to a throwaway in-memory store — pass a persistent
	 * one (the MOUNT's `.find-handles.json`) so a `find/` and a later `show/<N>` share state.
	 */
	readonly handleStore?: HandleStore;
	/**
	 * The snapshot content hash (`snapshot_sha256`) the handles are stamped with. Defaults to
	 * the snapshot's own derived key; the MOUNT may pass the real stored hash.
	 */
	readonly snapshotSha?: string;
	/** Max results a `find/` renders (bounds output on a huge graph — a DoS guardrail). */
	readonly maxResults?: number;
	/** Max edit distance the Levenshtein fallback accepts (FR-9 — bounded). */
	readonly maxFuzzyDistance?: number;
}

const DEFAULT_MAX_RESULTS = 25;
const DEFAULT_MAX_FUZZY_DISTANCE = 2;

/**
 * The honest cross-file-resolution caveat (FR-11 / d-AC-6). Rendered on every `show/` of a
 * zero-incoming node and stated in `index.md`. Cross-file `calls` resolve only for relative
 * named/namespace imports, so "Incoming (0)" is a dead-code CANDIDATE, not proof.
 */
export const DEAD_CODE_CAVEAT =
	"Incoming (0) is not proof of dead code: cross-file calls resolve only for relative named/namespace imports (AST-only, high-confidence). Absence of an incoming edge is a candidate, not proof; cross-check a snapshot that may be stale against edited source.";

// ════════════════════════════════════════════════════════════════════════════
// SECTION 2 — The dispatcher. `handleGraphVfs(path, snapshot)` routes a `graph/...`
// path to a renderer. PURE except the (local) handle store. ZERO network (d-AC-5).
// ════════════════════════════════════════════════════════════════════════════

/**
 * Render a `graph/...` VFS path from a LOADED LOCAL snapshot (FR-1 / d-AC-5). ZERO network:
 * reads only the in-memory {@link Snapshot} (+ the local handle store). The MOUNT (PRD-015)
 * loads the snapshot off disk and calls this; the renderer never opens a socket or file.
 *
 * Recognized paths (a leading `graph/` is optional):
 *   - `index.md`                       overview (FR-2)
 *   - `find/<pattern>`                 ranked substring + handles + fuzzy fallback (FR-3 / d-AC-1)
 *   - `query/<pattern>`                find + 1-hop neighbor expansion (FR-4)
 *   - `show/<handle-or-pattern>`       node detail + grouped edges, re-validated (FR-5 / d-AC-3)
 *   - `impact/<pattern>`               transitive dependents / blast radius (FR-6 / d-AC-2)
 *   - `neighborhood/<file>`            a file's symbols + cross-file neighbors (FR-6 / d-AC-2)
 *   - `layers`                         architectural-subsystem grouping (FR-7)
 *   - `tour`                           a deterministic dependency-ordered walk (FR-7)
 *   - `path/<from>/<to>`               shortest path between two patterns (FR-7)
 *
 * An unknown path returns a short usage listing (never throws).
 */
export function handleGraphVfs(path: string, snapshot: Snapshot, options: GraphVfsOptions = {}): string {
	const { command, remainder } = parsePath(path);
	const sha = options.snapshotSha ?? snapshotKey(snapshot);
	const store = options.handleStore ?? inMemoryHandleStore();

	switch (command) {
		case "":
		case "index":
		case "index.md":
			return renderIndex(snapshot);
		case "find":
			return renderFind(remainder, snapshot, store, sha, options);
		case "query":
			return renderQuery(remainder, snapshot, options);
		case "show":
			return renderShow(remainder, snapshot, store, sha);
		case "impact":
			return renderImpact(remainder, snapshot);
		case "neighborhood":
			// The remainder is a FILE path (it contains slashes) — take it whole.
			return renderNeighborhood(remainder, snapshot);
		case "layers":
			return renderLayers(snapshot);
		case "tour":
			return renderTour(snapshot);
		case "path": {
			// `path/<from>/<to>` — split the remainder on its FIRST slash into two patterns.
			const slash = remainder.indexOf("/");
			const from = slash < 0 ? remainder : remainder.slice(0, slash);
			const to = slash < 0 ? "" : remainder.slice(slash + 1);
			return renderPath(from, to, snapshot);
		}
		default:
			return renderUsage(command);
	}
}

/**
 * Split a `graph/<command>/<remainder>` path into the command and the WHOLE remainder. A
 * leading `graph/`, leading slashes, and a trailing `.md` are stripped. The remainder is
 * kept INTACT (it may itself contain slashes — a file path for `neighborhood/`, two
 * patterns for `path/`); each renderer decides how to split it. URL-decoded.
 */
function parsePath(path: string): { command: string; remainder: string } {
	const cleaned = path.replace(/^\/+/, "").replace(/^graph\//, "").replace(/\.md$/, "");
	const slash = cleaned.indexOf("/");
	if (slash < 0) return { command: cleaned.toLowerCase(), remainder: "" };
	return { command: cleaned.slice(0, slash).toLowerCase(), remainder: decodeURIComponent(cleaned.slice(slash + 1)) };
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 3 — index.md (FR-2). Overview: commit, counts, kind breakdowns, top files,
// and the honest limitation (FR-11).
// ════════════════════════════════════════════════════════════════════════════

function renderIndex(snapshot: Snapshot): string {
	const commit = snapshot.graph.commit ?? "(unknown)";
	const nodeKinds = countBy(snapshot.nodes, (n) => n.kind);
	const symbolKinds = countBy(
		snapshot.nodes.filter((n) => n.kind === "symbol"),
		(n) => n.symbolKind ?? "symbol",
	);
	const edgeKinds = countBy(snapshot.links, (l) => l.relation);
	const topFiles = topFilesBySymbols(snapshot);

	const lines: string[] = [];
	lines.push(`# Codebase graph — ${snapshot.graph.repo ?? "repo"} @ ${commit}`);
	lines.push("");
	lines.push(`Nodes: ${snapshot.nodes.length}  Edges: ${snapshot.links.length}`);
	lines.push(`Node kinds: ${renderCounts(nodeKinds)}`);
	lines.push(`Symbol kinds: ${renderCounts(symbolKinds)}`);
	lines.push(`Edge kinds: ${renderCounts(edgeKinds)}`);
	lines.push("");
	lines.push("Top files by symbol count:");
	for (const [file, count] of topFiles) lines.push(`  ${count}  ${file}`);
	lines.push("");
	lines.push("Limitations:");
	lines.push(`  ${DEAD_CODE_CAVEAT}`);
	return lines.join("\n");
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 4 — find/ (FR-3 / FR-8 / FR-9 / d-AC-1 / d-AC-4). Ranked substring search +
// numbered handles + Levenshtein fuzzy fallback on no substring hit.
// ════════════════════════════════════════════════════════════════════════════

/** A scored search hit (lower rank = better; tie-broken by id). */
interface ScoredHit {
	readonly node: GraphNode;
	readonly rank: number;
	readonly fuzzy: boolean;
	readonly distance?: number;
}

/**
 * Rank a node against a lowercased pattern (FR-8): exact label (0) > prefix (1) >
 * id-contains (2) > label-contains (3). `null` when no substring relation holds (the
 * caller then tries the fuzzy fallback).
 */
function substringRank(node: GraphNode, patternLc: string): number | null {
	const nameLc = node.name.toLowerCase();
	const idLc = node.id.toLowerCase();
	if (nameLc === patternLc) return 0;
	if (nameLc.startsWith(patternLc)) return 1;
	if (idLc.includes(patternLc)) return 2;
	if (nameLc.includes(patternLc)) return 3;
	return null;
}

/** All substring hits ranked (FR-8). Empty when nothing matches (→ fuzzy fallback). */
function substringHits(nodes: readonly GraphNode[], patternLc: string): ScoredHit[] {
	const hits: ScoredHit[] = [];
	for (const node of nodes) {
		const rank = substringRank(node, patternLc);
		if (rank !== null) hits.push({ node, rank, fuzzy: false });
	}
	return sortHits(hits);
}

/**
 * The bounded zero-dependency Levenshtein fuzzy fallback (FR-9 / d-AC-4). Used ONLY when a
 * SINGLE-TOKEN pattern has no substring hit. Ranks by edit distance against the node NAME
 * (a one-char typo wins), bounded by `maxDistance` so a wholly-different token returns
 * nothing.
 */
function fuzzyHits(nodes: readonly GraphNode[], pattern: string, maxDistance: number): ScoredHit[] {
	const patternLc = pattern.toLowerCase();
	const hits: ScoredHit[] = [];
	for (const node of nodes) {
		const distance = levenshtein(node.name.toLowerCase(), patternLc, maxDistance);
		if (distance <= maxDistance) hits.push({ node, rank: 10 + distance, fuzzy: true, distance });
	}
	return sortHits(hits);
}

/** Sort hits by rank, then by node id (FR-8 tiebreak) — a total, deterministic order. */
function sortHits(hits: ScoredHit[]): ScoredHit[] {
	return hits.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
}

/** True when the pattern is a single token (no whitespace) — the fuzzy fallback's precondition (FR-9). */
function isSingleToken(pattern: string): boolean {
	return pattern.trim().length > 0 && !/\s/.test(pattern.trim());
}

function renderFind(
	pattern: string,
	snapshot: Snapshot,
	store: HandleStore,
	sha: string,
	options: GraphVfsOptions,
): string {
	if (pattern.trim() === "") return "find/<pattern>: provide a search pattern.";
	const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
	const maxFuzzy = options.maxFuzzyDistance ?? DEFAULT_MAX_FUZZY_DISTANCE;

	let hits = substringHits(snapshot.nodes, pattern.toLowerCase());
	let usedFuzzy = false;
	// FR-9 / d-AC-4: NO substring hit + a single token → Levenshtein fuzzy fallback.
	if (hits.length === 0 && isSingleToken(pattern)) {
		hits = fuzzyHits(snapshot.nodes, pattern, maxFuzzy);
		usedFuzzy = hits.length > 0;
	}

	const shown = hits.slice(0, maxResults);

	// Persist the numbered handles (FR-10) so a follow-up `show/<N>` resolves the node.
	const handles: Record<string, string> = {};
	shown.forEach((hit, i) => {
		handles[String(i + 1)] = hit.node.id;
	});
	store.write({ snapshotSha: sha, pattern, handles });

	if (shown.length === 0) return `find/${pattern}: no matches (substring or fuzzy within distance ${maxFuzzy}).`;

	const lines: string[] = [];
	lines.push(`find/${pattern}${usedFuzzy ? "  (fuzzy fallback — no substring match)" : ""}`);
	shown.forEach((hit, i) => {
		const tag = hit.fuzzy ? `  ~${hit.distance}` : "";
		lines.push(`[${i + 1}] ${hit.node.name}  ${hit.node.sourceFile}${tag}`);
	});
	if (hits.length > shown.length) lines.push(`… ${hits.length - shown.length} more (refine the pattern).`);
	return lines.join("\n");
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 5 — query/ (FR-4). find results + a 1-hop neighbor expansion of the top
// matches, grouped by relation.
// ════════════════════════════════════════════════════════════════════════════

function renderQuery(pattern: string, snapshot: Snapshot, options: GraphVfsOptions): string {
	if (pattern.trim() === "") return "query/<pattern>: provide a search pattern.";
	const maxFuzzy = options.maxFuzzyDistance ?? DEFAULT_MAX_FUZZY_DISTANCE;
	let hits = substringHits(snapshot.nodes, pattern.toLowerCase());
	if (hits.length === 0 && isSingleToken(pattern)) hits = fuzzyHits(snapshot.nodes, pattern, maxFuzzy);
	const top = hits.slice(0, 5);
	if (top.length === 0) return `query/${pattern}: no matches.`;

	const adj = buildAdjacency(snapshot);
	const lines: string[] = [];
	lines.push(`query/${pattern} — ${top.length} top match(es) + 1-hop neighbors`);
	for (const hit of top) {
		lines.push("");
		lines.push(`${hit.node.name}  ${hit.node.id}`);
		const out = adj.outgoing.get(hit.node.id) ?? [];
		const inc = adj.incoming.get(hit.node.id) ?? [];
		renderGroupedNeighbors(lines, "  → outgoing", out, (l) => l.target);
		renderGroupedNeighbors(lines, "  ← incoming", inc, (l) => l.source);
	}
	return lines.join("\n");
}

/** Render a neighbor set grouped by relation (used by query/ and show/). */
function renderGroupedNeighbors(
	lines: string[],
	header: string,
	links: readonly SnapshotLink[],
	pick: (l: SnapshotLink) => string,
): void {
	if (links.length === 0) return;
	const byRelation = new Map<EdgeRelation, string[]>();
	for (const link of links) {
		const list = byRelation.get(link.relation) ?? [];
		list.push(pick(link));
		byRelation.set(link.relation, list);
	}
	lines.push(`${header}:`);
	for (const relation of [...byRelation.keys()].sort()) {
		const targets = [...new Set(byRelation.get(relation))].sort();
		lines.push(`    ${relation}: ${targets.join(", ")}`);
	}
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 6 — show/ (FR-5 / d-AC-3 / d-AC-6). Full node detail + grouped edges. A
// numbered handle is RE-VALIDATED against the CURRENT snapshot; a pattern is resolved
// to the single best match. A zero-incoming node carries the dead-code caveat.
// ════════════════════════════════════════════════════════════════════════════

function renderShow(arg: string, snapshot: Snapshot, store: HandleStore, sha: string): string {
	if (arg.trim() === "") return "show/<handle-or-pattern>: provide a handle number or a pattern.";

	const node = /^\d+$/.test(arg.trim())
		? resolveHandle(arg.trim(), snapshot, store, sha)
		: resolveBestMatch(arg, snapshot);

	if (typeof node === "string") return node; // an error message (stale handle, no match, …).
	return renderNodeDetail(node, snapshot);
}

/**
 * Resolve a numbered handle from a prior `find/` (FR-5 / d-AC-3) and RE-VALIDATE it against
 * the CURRENT snapshot. The handle resolves to a node ONLY if (a) a handle table exists,
 * (b) it holds that number, and (c) the node id it stored is STILL present in the current
 * snapshot. A snapshot that changed since the `find/` → the stored node is gone → the stale
 * handle is REFUSED, never served. Returns the node, or an error string.
 */
function resolveHandle(handle: string, snapshot: Snapshot, store: HandleStore, sha: string): GraphNode | string {
	const table = store.read();
	if (table === null) return `show/${handle}: no prior find/ handles in this worktree — run find/<pattern> first.`;
	const nodeId = table.handles[handle];
	if (nodeId === undefined) return `show/${handle}: handle ${handle} is not in the last find/ (had ${Object.keys(table.handles).length}).`;

	// RE-VALIDATE against the CURRENT snapshot (d-AC-3): the node must still be live.
	const node = snapshot.nodes.find((n) => n.id === nodeId);
	if (node === undefined) {
		const staleNote = table.snapshotSha === sha ? "" : " (the snapshot changed since that find/)";
		return `show/${handle}: stale handle — node "${nodeId}" is no longer in the current snapshot${staleNote}. Re-run find/${table.pattern}.`;
	}
	return node;
}

/** Resolve a pattern to its single best match (the top-ranked find hit), or an error string. */
function resolveBestMatch(pattern: string, snapshot: Snapshot): GraphNode | string {
	let hits = substringHits(snapshot.nodes, pattern.toLowerCase());
	if (hits.length === 0 && isSingleToken(pattern)) hits = fuzzyHits(snapshot.nodes, pattern, DEFAULT_MAX_FUZZY_DISTANCE);
	if (hits.length === 0) return `show/${pattern}: no node matches.`;
	return hits[0].node;
}

/** Render a node's full detail + incoming/outgoing edges grouped by relation, with the caveat. */
function renderNodeDetail(node: GraphNode, snapshot: Snapshot): string {
	const adj = buildAdjacency(snapshot);
	const out = adj.outgoing.get(node.id) ?? [];
	const inc = (adj.incoming.get(node.id) ?? []).filter((l) => !isExternalTarget(l.target));
	const obs = node.observation;

	const lines: string[] = [];
	lines.push(`# ${node.name}  (${node.kind}${node.symbolKind ? `/${node.symbolKind}` : ""})`);
	lines.push(`id: ${node.id}`);
	lines.push(`file: ${node.sourceFile}  language: ${node.language}`);
	lines.push(`lines: ${obs.startLine}-${obs.endLine}${node.exported ? "  exported" : ""}`);
	lines.push(`degrees: incoming ${inc.length}  outgoing ${out.length}${obs.isEntrypoint ? "  (entrypoint)" : ""}`);
	lines.push("");

	if (inc.length === 0) {
		lines.push(`Incoming (0).`);
		lines.push(DEAD_CODE_CAVEAT); // FR-11 / d-AC-6.
	} else {
		renderGroupedNeighbors(lines, `Incoming (${inc.length})`, inc, (l) => l.source);
	}
	if (out.length === 0) lines.push("Outgoing (0).");
	else renderGroupedNeighbors(lines, `Outgoing (${out.length})`, out, (l) => l.target);
	return lines.join("\n");
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 7 — impact/ (FR-6 / d-AC-2). The TRANSITIVE DEPENDENTS (blast radius): who
// transitively depends on / calls the matching symbol, by walking INCOMING edges.
// ════════════════════════════════════════════════════════════════════════════

function renderImpact(pattern: string, snapshot: Snapshot): string {
	if (pattern.trim() === "") return "impact/<pattern>: provide a symbol pattern.";
	const seeds = substringHits(snapshot.nodes, pattern.toLowerCase());
	if (seeds.length === 0) return `impact/${pattern}: no matching symbol.`;
	const adj = buildAdjacency(snapshot);
	const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n] as const));

	const lines: string[] = [];
	lines.push(`impact/${pattern} — transitive dependents (blast radius, walking incoming edges)`);
	for (const seed of seeds.slice(0, 5)) {
		const dependents = transitiveDependents(seed.node.id, adj);
		lines.push("");
		lines.push(`${seed.node.name}  ${seed.node.id} → ${dependents.size} transitive dependent(s)`);
		const named = [...dependents].map((id) => nodeById.get(id)?.id ?? id).sort();
		for (const id of named) lines.push(`  ${id}`);
		if (dependents.size === 0) lines.push(`  (none resolved — ${DEAD_CODE_CAVEAT})`);
	}
	return lines.join("\n");
}

/**
 * The transitive dependents of a node (d-AC-2 / index AC-4): the set reachable by walking
 * INCOMING edges (callers of callers, importers of importers). BFS over the reverse graph,
 * excluding the seed itself; cycle-safe via a visited set.
 */
function transitiveDependents(seedId: string, adj: Adjacency): Set<string> {
	const seen = new Set<string>();
	const queue: string[] = [seedId];
	while (queue.length > 0) {
		const current = queue.shift() as string;
		for (const link of adj.incoming.get(current) ?? []) {
			if (isExternalTarget(link.target)) continue;
			if (!seen.has(link.source) && link.source !== seedId) {
				seen.add(link.source);
				queue.push(link.source);
			}
		}
	}
	return seen;
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 8 — neighborhood/ (FR-6 / d-AC-2). A file's symbols + their CROSS-FILE
// neighbors (a neighbor whose node lives in a different source file).
// ════════════════════════════════════════════════════════════════════════════

function renderNeighborhood(filePattern: string, snapshot: Snapshot): string {
	if (filePattern.trim() === "") return "neighborhood/<file>: provide a file path or pattern.";
	const file = resolveFile(filePattern, snapshot);
	if (file === null) return `neighborhood/${filePattern}: no matching file in the graph.`;

	const symbols = snapshot.nodes.filter((n) => n.kind === "symbol" && n.sourceFile === file).sort(byId);
	const adj = buildAdjacency(snapshot);
	const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n] as const));

	const lines: string[] = [];
	lines.push(`neighborhood/${file} — ${symbols.length} symbol(s) + cross-file neighbors`);
	for (const sym of symbols) {
		const neighbors = new Set<string>();
		for (const link of adj.outgoing.get(sym.id) ?? []) addCrossFileNeighbor(neighbors, link.target, file, nodeById);
		for (const link of adj.incoming.get(sym.id) ?? []) addCrossFileNeighbor(neighbors, link.source, file, nodeById);
		lines.push("");
		lines.push(`  ${sym.name}  ${sym.id}`);
		if (neighbors.size === 0) lines.push(`    (no cross-file neighbors)`);
		else for (const n of [...neighbors].sort()) lines.push(`    ~ ${n}`);
	}
	return lines.join("\n");
}

/** Add a neighbor id to the set IFF it is a real node in a DIFFERENT source file than `file`. */
function addCrossFileNeighbor(set: Set<string>, neighborId: string, file: string, nodeById: Map<string, GraphNode>): void {
	if (isExternalTarget(neighborId)) return;
	const node = nodeById.get(neighborId);
	if (node !== undefined && node.sourceFile !== file) set.add(neighborId);
}

/** Resolve a file pattern to a concrete file path present in the graph (exact, then substring). */
function resolveFile(pattern: string, snapshot: Snapshot): string | null {
	const files = snapshot.nodes.filter((n) => n.kind === "file").map((n) => n.sourceFile);
	if (files.includes(pattern)) return pattern;
	const lc = pattern.toLowerCase();
	const matches = files.filter((f) => f.toLowerCase().includes(lc)).sort();
	return matches[0] ?? null;
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 9 — layers / tour / path (FR-7). Subsystem grouping, a deterministic
// dependency-ordered walk, and a shortest path between two patterns.
// ════════════════════════════════════════════════════════════════════════════

/** Group files by an architectural-subsystem path heuristic (FR-7) — the first 2 path segments. */
function subsystemOf(sourceFile: string): string {
	const parts = sourceFile.split("/").filter((p) => p !== "");
	if (parts.length <= 1) return "(root)";
	return parts.slice(0, Math.min(2, parts.length - 1)).join("/");
}

function renderLayers(snapshot: Snapshot): string {
	const bySubsystem = new Map<string, Set<string>>();
	for (const node of snapshot.nodes) {
		if (node.kind !== "file") continue;
		const sub = subsystemOf(node.sourceFile);
		const set = bySubsystem.get(sub) ?? new Set<string>();
		set.add(node.sourceFile);
		bySubsystem.set(sub, set);
	}
	const lines: string[] = ["layers — files grouped by subsystem (path heuristic)"];
	for (const sub of [...bySubsystem.keys()].sort()) {
		const files = [...(bySubsystem.get(sub) as Set<string>)].sort();
		lines.push("");
		lines.push(`${sub}  (${files.length})`);
		for (const f of files) lines.push(`  ${f}`);
	}
	return lines.join("\n");
}

/**
 * A deterministic dependency-ordered walk of the file graph (FR-7). Orders files by
 * (incoming file-degree asc, then path) so leaf/entry modules surface first, in a stable
 * order — a reproducible "read the codebase in this order" tour. Deterministic: no
 * randomness, ties broken by path.
 */
function renderTour(snapshot: Snapshot): string {
	const files = snapshot.nodes.filter((n) => n.kind === "file").map((n) => n.sourceFile);
	const fileSet = new Set(files);
	const incoming = new Map<string, number>();
	for (const file of files) incoming.set(file, 0);
	for (const link of snapshot.links) {
		if (link.relation !== "imports") continue;
		const targetFile = fileOf(link.target);
		if (fileSet.has(targetFile)) incoming.set(targetFile, (incoming.get(targetFile) ?? 0) + 1);
	}
	const ordered = [...files].sort((a, b) => {
		const da = incoming.get(a) ?? 0;
		const db = incoming.get(b) ?? 0;
		return da !== db ? da - db : a < b ? -1 : a > b ? 1 : 0;
	});
	const lines: string[] = ["tour — deterministic dependency-ordered walkthrough"];
	ordered.forEach((file, i) => lines.push(`${i + 1}. ${file}  (imported by ${incoming.get(file) ?? 0})`));
	return lines.join("\n");
}

/** Shortest path between two symbol patterns (FR-7) — BFS over the directed graph. */
function renderPath(fromPattern: string, toPattern: string, snapshot: Snapshot): string {
	if (fromPattern.trim() === "" || toPattern.trim() === "") return "path/<from>/<to>: provide two patterns.";
	const from = resolveBestMatch(fromPattern, snapshot);
	const to = resolveBestMatch(toPattern, snapshot);
	if (typeof from === "string") return from;
	if (typeof to === "string") return to;

	const adj = buildAdjacency(snapshot);
	const prev = new Map<string, string>();
	const seen = new Set<string>([from.id]);
	const queue: string[] = [from.id];
	while (queue.length > 0) {
		const current = queue.shift() as string;
		if (current === to.id) break;
		for (const link of adj.outgoing.get(current) ?? []) {
			if (isExternalTarget(link.target) || seen.has(link.target)) continue;
			seen.add(link.target);
			prev.set(link.target, current);
			queue.push(link.target);
		}
	}
	if (from.id !== to.id && !prev.has(to.id)) {
		const src = from.id;
		const dst = to.id;
		return `path/${fromPattern}/${toPattern}: no directed path (${src} → ${dst}).`;
	}
	const chain: string[] = [to.id];
	while (chain[0] !== from.id) chain.unshift(prev.get(chain[0]) as string);
	return [`path/${fromPattern}/${toPattern} — ${chain.length} hop(s)`, ...chain.map((id, i) => `${i + 1}. ${id}`)].join("\n");
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 10 — shared helpers (pure). Adjacency index, counting, id math.
// ════════════════════════════════════════════════════════════════════════════

/** An incoming/outgoing adjacency index over the link set, keyed by node id. */
interface Adjacency {
	readonly outgoing: ReadonlyMap<string, SnapshotLink[]>;
	readonly incoming: ReadonlyMap<string, SnapshotLink[]>;
}

/** Build the adjacency index once per render (pure — derived only from the snapshot links). */
function buildAdjacency(snapshot: Snapshot): Adjacency {
	const outgoing = new Map<string, SnapshotLink[]>();
	const incoming = new Map<string, SnapshotLink[]>();
	for (const link of snapshot.links) {
		(outgoing.get(link.source) ?? setAndGet(outgoing, link.source)).push(link);
		(incoming.get(link.target) ?? setAndGet(incoming, link.target)).push(link);
	}
	return { outgoing, incoming };
}

function setAndGet(map: Map<string, SnapshotLink[]>, key: string): SnapshotLink[] {
	const list: SnapshotLink[] = [];
	map.set(key, list);
	return list;
}

/** The repo-relative file path embedded in a node id (`file` id = path; `sym` id = `path#name`). */
function fileOf(nodeId: string): string {
	const hash = nodeId.indexOf("#");
	return hash < 0 ? nodeId : nodeId.slice(0, hash);
}

function byId(a: GraphNode, b: GraphNode): number {
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Bounded Levenshtein edit distance (FR-9) — zero-dependency, the fuzzy fallback's core.
 * Returns the edit distance between `a` and `b`, or `maxDistance + 1` once it provably
 * exceeds the bound (an early-out that keeps a one-char typo cheap and prunes far-off
 * candidates). A length gap larger than the bound short-circuits immediately. The classic
 * two-row DP — pure, deterministic, no allocation beyond two rows.
 */
function levenshtein(a: string, b: string, maxDistance: number): number {
	if (a === b) return 0;
	if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	let curr = new Array<number>(b.length + 1);
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		let rowMin = curr[0];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
			if (curr[j] < rowMin) rowMin = curr[j];
		}
		// Early-out: if the best cell in this row already exceeds the bound, no later row recovers.
		if (rowMin > maxDistance) return maxDistance + 1;
		[prev, curr] = [curr, prev];
	}
	return prev[b.length];
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const item of items) {
		const k = key(item);
		counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	return counts;
}

function renderCounts(counts: Map<string, number>): string {
	return [...counts.entries()].sort().map(([k, v]) => `${k}=${v}`).join("  ") || "(none)";
}

function topFilesBySymbols(snapshot: Snapshot, limit = 10): Array<[string, number]> {
	const counts = countBy(
		snapshot.nodes.filter((n) => n.kind === "symbol"),
		(n) => n.sourceFile,
	);
	return [...counts.entries()].sort((a, b) => (a[1] !== b[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1)).slice(0, limit);
}

/**
 * A stable per-snapshot key for stamping handles when no explicit `snapshotSha` is given.
 * Derived ONLY from STABLE content (node ids + link endpoints) so two renders of the same
 * graph share handles; cheap (no crypto) and zero-network. The MOUNT may pass the real
 * `snapshot_sha256` via `options.snapshotSha` for an exact match.
 */
function snapshotKey(snapshot: Snapshot): string {
	const commit = snapshot.graph.commit ?? "";
	return `${commit}:${snapshot.nodes.length}:${snapshot.links.length}`;
}

/** A short usage listing for an unknown command (never throws). */
function renderUsage(command: string): string {
	return [
		`graph/${command}: unknown. Available:`,
		"  index.md                      overview",
		"  find/<pattern>                ranked search + numbered handles + fuzzy fallback",
		"  query/<pattern>               find + 1-hop neighbor expansion",
		"  show/<handle-or-pattern>      node detail + grouped edges (re-validated handle)",
		"  impact/<pattern>              transitive dependents (blast radius)",
		"  neighborhood/<file>           a file's symbols + cross-file neighbors",
		"  layers                        files grouped by subsystem",
		"  tour                          dependency-ordered walkthrough",
		"  path/<from>/<to>              shortest directed path",
	].join("\n");
}
