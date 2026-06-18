/**
 * Snapshot-builder harness — PRD-014. Wave 1 owns the AGGREGATION half; Wave 2 (014b)
 * fills the FINALIZE half (resolve → degrees → hash → atomic write). The build pipeline:
 *
 *   discover (014a) → extract each file (014a, cache-backed) → AGGREGATE into a NetworkX
 *   node-link {@link Snapshot} (Wave 1) → resolveCrossFile (014b) → annotateNodeDegrees
 *   (014b) → computeSnapshotSha256 (014b) → writeSnapshotAtomic (014b).
 *
 * Wave 1 produces a CORRECT but UN-resolved, UN-hashed snapshot: nodes and edges are
 * real, the `external:` targets are still placeholders, and the VOLATILE `observation`
 * block is filled. 014b finalizes it; 014c pushes/pulls it (now in `push-pull.ts`); 014d
 * serves it (now in `query.ts`). None of those re-aggregates — they consume
 * {@link buildAggregateSnapshot}'s output.
 *
 * The 014b seams (`resolveCrossFile` / `annotateNodeDegrees` / `computeSnapshotSha256` /
 * `writeSnapshotAtomic`) live here, delegating to the focused helpers `resolve.ts`,
 * `degrees.ts`, and `hash.ts`. `computeSnapshotSha256` is re-exported for 014c's
 * pull-revalidation.
 *
 * The build is DAEMON-OWNED: in production a `memory_jobs` worker calls
 * {@link buildAggregateSnapshot} then {@link finalizeSnapshot} then the 014c push. This
 * module reads the filesystem (via 014a discovery/extract) and aggregates; it does NOT
 * itself touch DeepLake — the 014c push (in `push-pull.ts`) does.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	type FileExtraction,
	type GraphEdge,
	type GraphNode,
	type ParseError,
	type Snapshot,
	type SnapshotIdentity,
	type SnapshotLink,
	type TsCrossFileInputs,
} from "./contracts.js";
import { ExtractionCache } from "./cache.js";
import { type DiscoveryDeps, discoverSourceFiles } from "./discovery.js";
import { contentSha256, extractFile } from "./extract.js";
import { annotateNodeDegrees as annotateDegrees } from "./degrees.js";
import { buildSnapshot, canonicalJSON, computeSnapshotSha256 as computeSha256 } from "./hash.js";
import { type CrossFileInputsByFile, resolveLinks } from "./resolve.js";

/** The generator/schema version stamped into the VOLATILE observation (D-6). */
export const SNAPSHOT_GENERATOR_VERSION = "014b.1" as const;

/** Injectable seams for the aggregate build (so tests drive discovery + file reads + the cache dir). */
export interface BuildDeps extends DiscoveryDeps {
	/** Read a file's UTF-8 content. Defaults to a real `readFileSync`. */
	readonly readFile?: (absPath: string) => string;
	/** The cache base dir (`~/.honeycomb/graphs/<repo-key>/` in prod; a temp dir in tests). */
	readonly cacheBaseDir?: string;
	/** Disable the content-addressed cache entirely (force fresh extraction). */
	readonly noCache?: boolean;
}

/** The result of the Wave-1 aggregate build (the input the 014b finalize consumes). */
export interface AggregateBuild {
	/** The un-resolved, un-hashed snapshot (nodes/links real; `external:` placeholders intact). */
	readonly snapshot: Snapshot;
	/** Every parse error across all files — the SKIPPED files (a-AC-4), surfaced not hidden. */
	readonly parseErrors: readonly ParseError[];
	/** How many files were reused from the cache vs freshly extracted (build telemetry). */
	readonly cacheStats: { readonly reused: number; readonly extracted: number };
	/**
	 * Per-file TS/JS cross-file inputs (`importBindings` + `rawCalls`), keyed by source
	 * path — the 014b resolve pass (FR-3) consumes these to wire calls/heritage across
	 * files WITHOUT re-parsing. Empty for non-TS/JS files.
	 */
	readonly crossFileInputs: CrossFileInputsByFile;
}

/**
 * Build the AGGREGATE snapshot (Wave 1) — discover, extract (cache-backed), aggregate
 * into NetworkX node-link JSON. The returned {@link Snapshot} is correct but NOT yet
 * resolved/hashed/degree-annotated: it carries the per-file placeholder edges and a
 * filled VOLATILE `observation`. {@link finalizeSnapshot} (014b) finalizes it.
 *
 * A malformed file contributes its parse errors and is SKIPPED from the graph — the
 * build NEVER aborts (a-AC-4).
 */
export async function buildAggregateSnapshot(
	repoRoot: string,
	identity: SnapshotIdentity,
	deps: BuildDeps = {},
): Promise<AggregateBuild> {
	const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
	const cache = deps.noCache ? null : new ExtractionCache(deps.cacheBaseDir ?? defaultCacheDir(identity));

	const discovery = discoverSourceFiles(repoRoot, deps);

	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	const parseErrors: ParseError[] = [];
	const crossFileInputs = new Map<string, TsCrossFileInputs>();
	let reused = 0;
	let extracted = 0;

	for (const relPath of discovery.files) {
		let content: string;
		try {
			content = readFile(join(repoRoot, relPath));
		} catch {
			// A file that vanished between discovery and read is skipped, not fatal.
			continue;
		}
		const sha = contentSha256(content);

		// Cache lookup: a hit reuses (and rename-rewrites to the current path) WITHOUT
		// re-parsing (a-AC-2). A miss extracts fresh and writes the entry.
		let extraction: FileExtraction | null = cache?.read(sha, relPath) ?? null;
		if (extraction !== null) {
			reused++;
		} else {
			extraction = await extractFile(relPath, content, sha);
			if (extraction === null) continue; // unsupported extension (defensive; discovery already filters)
			extracted++;
			cache?.write(extraction);
		}

		// Malformed file → record its parse errors and SKIP its (untrusted) nodes/edges
		// from the graph (a-AC-4). We keep ONLY the file node so the file shows degraded.
		if (extraction.parseErrors.length > 0) {
			parseErrors.push(...extraction.parseErrors);
			const fileNode = extraction.nodes.find((n) => n.kind === "file");
			if (fileNode) nodes.push(fileNode);
			continue;
		}

		nodes.push(...extraction.nodes);
		edges.push(...extraction.edges);
		// Carry the TS/JS cross-file inputs for the 014b resolve pass (FR-3).
		if (extraction.tsCrossFileInputs !== undefined) {
			crossFileInputs.set(extraction.sourceFile, extraction.tsCrossFileInputs);
		}
	}

	const snapshot = assembleSnapshot(identity, nodes, edges, {
		fileCount: discovery.files.length,
		parseErrorCount: parseErrors.length,
		worktreePath: repoRoot,
	});

	return { snapshot, parseErrors, cacheStats: { reused, extracted }, crossFileInputs };
}

/**
 * Assemble the node-link {@link Snapshot} from aggregated nodes + edges (Wave 1). The
 * `graph` dict carries the identity tuple (STABLE). The `observation` is VOLATILE.
 * Wave 1 does NOT sort/canonicalize — {@link finalizeSnapshot} (014b) re-sorts before
 * hashing.
 */
function assembleSnapshot(
	identity: SnapshotIdentity,
	nodes: readonly GraphNode[],
	edges: readonly GraphEdge[],
	counts: { readonly fileCount: number; readonly parseErrorCount: number; readonly worktreePath: string },
): Snapshot {
	const links: SnapshotLink[] = edges.map((e) => ({
		source: e.src,
		target: e.dst,
		relation: e.relation,
		confidence: e.confidence,
		id: e.id,
		...(e.ord === undefined ? {} : { ord: e.ord }),
	}));

	return {
		directed: true,
		multigraph: true,
		graph: {
			org: identity.org,
			workspace: identity.workspace,
			repo: identity.repo,
			user: identity.user,
			worktree: identity.worktree,
			commit: identity.commit,
		},
		nodes: [...nodes],
		links,
		observation: {
			generatedAt: new Date().toISOString(),
			generatorVersion: SNAPSHOT_GENERATOR_VERSION,
			worktreePath: counts.worktreePath,
			fileCount: counts.fileCount,
			nodeCount: nodes.length,
			edgeCount: links.length,
			parseErrorCount: counts.parseErrorCount,
		},
	};
}

/** Default local cache dir for an identity — `~/.honeycomb/graphs/<repo>/`. Repo is the key. */
function defaultCacheDir(identity: SnapshotIdentity): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const repoKey = identity.repo === "" ? "default" : identity.repo.replace(/[^A-Za-z0-9._-]/g, "_");
	return join(home, ".honeycomb", "graphs", repoKey);
}

// ════════════════════════════════════════════════════════════════════════════
// WAVE 2 (014b) — FINALIZE. The four seams the Wave-1 harness left stubbed, now
// filled by delegating to the focused helpers (`resolve.ts`/`degrees.ts`/`hash.ts`).
// The 014c (push/pull) seams moved to `push-pull.ts`; the 014d (graph VFS) seam moved
// to `query.ts` — so those parallel Bees own clean files (see CONVENTIONS §9).
// ════════════════════════════════════════════════════════════════════════════

/**
 * The result of finalizing a snapshot (014b): the resolved, degree-annotated, canonically
 * ordered snapshot plus its content hash. The 014c push consumes both.
 */
export interface FinalizedSnapshot {
	/** The final snapshot: cross-file edges resolved, nodes/links sorted, degrees annotated. */
	readonly snapshot: Snapshot;
	/** The canonical `snapshot_sha256` over the STABLE fields (observation excluded). */
	readonly sha256: string;
}

/**
 * Finalize an aggregate build into a deterministic, hashed snapshot (014b). Runs the full
 * Wave-2 pipeline: resolve cross-file edges → sort canonically → annotate degrees →
 * compute the stable-field hash. Pure (no I/O); the caller writes it via
 * {@link writeSnapshotAtomic} and pushes it via 014c.
 */
export function finalizeSnapshot(build: AggregateBuild): FinalizedSnapshot {
	const resolved = resolveCrossFile(build);
	const ordered = buildSnapshot(resolved);
	const annotated = annotateNodeDegrees(ordered);
	const sha256 = computeSnapshotSha256(annotated);
	return { snapshot: annotated, sha256 };
}

/**
 * WAVE 2 (014b) — resolve `external:` placeholder edges to real node ids across files
 * (high-confidence only; drop ambiguous — FR-1..FR-5 / b-AC-1/b-AC-3/b-AC-4). Consumes
 * the aggregate snapshot + the per-file `crossFileInputs`. Returns a snapshot whose
 * provable edges are repointed, whose ambiguous call/heritage edges are dropped, and
 * whose unresolvable imports keep their `external:` target.
 */
export function resolveCrossFile(build: AggregateBuild): Snapshot {
	const links = resolveLinks({
		nodes: build.snapshot.nodes,
		links: build.snapshot.links,
		crossFileInputs: build.crossFileInputs,
	});
	return { ...build.snapshot, links };
}

/**
 * WAVE 2 (014b) — set `fan_in` / `fan_out` / `is_entrypoint` on every node from the
 * COMPLETE resolved edge set (b-AC-5). Mutates the VOLATILE `observation`, so it runs
 * AFTER resolution and is excluded from the hash.
 */
export function annotateNodeDegrees(snapshot: Snapshot): Snapshot {
	return annotateDegrees(snapshot);
}

/**
 * WAVE 2 (014b) — compute the canonical `snapshot_sha256` over ONLY the STABLE fields
 * (`directed`/`multigraph`/`graph`/`nodes`/`links`), EXCLUDING every `observation` block
 * (D-6 / b-AC-2 / index AC-1). Identical content → identical hash. Re-exported for 014c's
 * pull-revalidation.
 */
export function computeSnapshotSha256(snapshot: Snapshot): string {
	return computeSha256(snapshot);
}

/**
 * WAVE 2 (014b) — write the snapshot ATOMICALLY (temp file + `renameSync` in the same
 * dir) so a crash leaves the prior OR the new file, never a partial (FR-10 / b-AC-6).
 * Lands at `<baseDir>/snapshots/<commit>.json` (or `<snapshot-sha256>.json` with no
 * commit). The temp file carries a unique suffix so concurrent writes never collide, and
 * the `rename` is atomic on the same filesystem. Returns the final path written.
 *
 * `sha256` is optional: when present (and there is no commit context) it names the file;
 * otherwise it is recomputed. Passing it avoids a re-hash on the hot path.
 */
export function writeSnapshotAtomic(snapshot: Snapshot, baseDir: string, sha256?: string): string {
	const dir = join(baseDir, "snapshots");
	mkdirSync(dir, { recursive: true });

	const commit = typeof snapshot.graph.commit === "string" ? snapshot.graph.commit : "";
	const hash = sha256 ?? computeSnapshotSha256(snapshot);
	const fileName = commit !== "" ? `${commit}.json` : `${hash}.json`;
	const finalPath = join(dir, fileName);

	// Atomic write: serialize to a UNIQUE temp file in the SAME directory, then rename.
	// A crash mid-write leaves the temp file (ignored/overwritten next run) and the prior
	// final file intact; the rename either fully happens or does not (b-AC-6).
	// The stored file is the FULL snapshot (STABLE fields + the VOLATILE `observation`, which
	// a renderer wants), canonicalized for stable bytes. Only the HASH excludes `observation`.
	const tmpPath = join(dir, `.${fileName}.${process.pid}.${Date.now()}.tmp`);
	const bytes = canonicalJSON(snapshot);
	writeFileSync(tmpPath, bytes, { encoding: "utf8" });
	renameSync(tmpPath, finalPath);
	return finalPath;
}
