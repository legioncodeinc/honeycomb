/**
 * Codebase-graph subsystem barrel — PRD-014. The single import surface for the
 * AST-only codebase graph: the contracts (FileExtraction/Node/Edge/Snapshot/Extractor),
 * the per-file extractor framework (`extractFile` + the nine language extractors), the
 * content-addressed cache, source discovery, and the snapshot-builder harness with the
 * 014b/014c/014d seams.
 *
 * Wave 1 (014a) exports the FULL contract + the extractor framework + the cache + the
 * discovery + the aggregate snapshot harness. Wave 2 fills:
 *   - 014b (`snapshot.ts` + `resolve.ts`/`degrees.ts`/`hash.ts`): `resolveCrossFile` /
 *     `annotateNodeDegrees` / `computeSnapshotSha256` / `writeSnapshotAtomic` /
 *     `finalizeSnapshot` (resolution + deterministic hash + degrees + atomic write).
 *   - 014c (`push-pull.ts`): `pushSnapshot` / `pullSnapshot` (the `codebase` table
 *     push/pull + drift) — owns its own file so 014b and 014c never collide.
 *   - 014d (`query.ts`): `handleGraphVfs` (the read-only `graph/` query surface).
 *
 * The whole module is built around ONE thesis: the graph is AST-ONLY (tree-sitter,
 * never an LSP/type-checker/LLM) and DETERMINISTIC (every field is STABLE-or-VOLATILE;
 * the volatile `observation` blocks are excluded from the content hash so identical
 * source anywhere dedups to one stored row). Read CONVENTIONS.md before extending it.
 */

// ── Contracts (the pinned Wave-2 surface) ─────────────────────────────────────
export {
	EDGE_CONFIDENCE,
	type EdgeConfidence,
	EDGE_RELATIONS,
	type EdgeRelation,
	EXTERNAL_PREFIX,
	externalTarget,
	type Extractor,
	type FileExtraction,
	type GraphEdge,
	type GraphNode,
	type ImportBinding,
	isExternalTarget,
	isLanguage,
	type Language,
	LANGUAGES,
	type NodeKind,
	NODE_KINDS,
	type NodeObservation,
	type ParseError,
	type ParseHandle,
	type RawCall,
	type Snapshot,
	type SnapshotIdentity,
	type SnapshotLink,
	type SnapshotObservation,
	type SymbolKind,
	SYMBOL_KINDS,
	type SyntaxCursorNode,
	type TsCrossFileInputs,
} from "./contracts.js";

// ── The extractor framework (014a) ────────────────────────────────────────────
export { baseName, contentSha256, EXTENSION_LANGUAGE, extractFile, languageForFile } from "./extract.js";

// ── The content-addressed cache (014a) ────────────────────────────────────────
export { CACHE_SCHEMA_VERSION, ExtractionCache } from "./cache.js";

// ── Source discovery (014a) ───────────────────────────────────────────────────
export {
	ALWAYS_IGNORED_DIRS,
	type DiscoveryDeps,
	type DiscoveryResult,
	discoverSourceFiles,
	MAX_DISCOVERED_FILES,
} from "./discovery.js";

// ── The snapshot-builder harness (014a) + the 014b finalize seams ─────────────
// 014c (`push-pull.ts`) and 014d (`query.ts`) own their own files — not re-exported
// here until those Bees land them, so this barrel stays buildable in isolation.
export {
	type AggregateBuild,
	annotateNodeDegrees,
	type BuildDeps,
	buildAggregateSnapshot,
	computeSnapshotSha256,
	type FinalizedSnapshot,
	finalizeSnapshot,
	resolveCrossFile,
	SNAPSHOT_GENERATOR_VERSION,
	writeSnapshotAtomic,
} from "./snapshot.js";

// ── Push / pull to the `codebase` table (014c) ────────────────────────────────
export {
	CODEBASE_TABLE,
	parseSnapshotJsonb,
	PUSH_VERIFY_POLLS,
	type PullLocalContext,
	type PullOutcome,
	type PullRefusalReason,
	pullSnapshot,
	type PushOutcome,
	type PushPullContext,
	type PushPullLogger,
	type PushSkipReason,
	pushSnapshot,
} from "./push-pull.js";

// ── The read-only `graph/` query surface (014d) ───────────────────────────────
export {
	DEAD_CODE_CAVEAT,
	type GraphVfsOptions,
	type HandleStore,
	type HandleTable,
	handleGraphVfs,
	inMemoryHandleStore,
} from "./query.js";

// ── The `/api/graph/*` mount seam — daemon-assembly wiring (CONVENTIONS §11) ──
export {
	defaultGraphBaseDir,
	GRAPH_GROUP,
	loadFreshestLocalSnapshot,
	type MountGraphOptions,
	mountGraphApi,
} from "./api.js";

// ── Snapshot-identity resolution (the build's identity tuple) ─────────────────
export {
	defaultGitProbe,
	type GitProbe,
	repoSlugFromOrigin,
	type ResolveIdentityOptions,
	resolveSnapshotIdentity,
} from "./identity.js";
