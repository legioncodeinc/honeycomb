/**
 * PRD-078a — the in-daemon LOCAL ANN recall index (MVP).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS. Deep Lake has NO vector-index primitive (`USING vector` /
 * `USING hnsw` → 400; `deeplake_index` is BM25-only — measured live 2026-07-09).
 * So the `<#>` cosine over `memories.content_embedding` is an unavoidable
 * brute-force full-column scan (~2.6s server-side for 2,004 rows, I/O-bound,
 * linear in corpus size). PRD-077 bounded per-turn recall but it returns 0 hits
 * because that 2.6s query exceeds the 3s fast-lane deadline. The fix (PRD-077
 * deferred D-3) is to move the vector search INTO the daemon: an in-RAM flat
 * cosine index over the project's embeddings, answering the `memories` semantic
 * arm from RAM in sub-100ms instead of the Deep Lake round-trip.
 *
 * Deep Lake stays the durable, fleet-shared store; this index is a HOT-READ
 * ACCELERATOR derived from it. The `<#>` SQL remains the cold/disabled fallback
 * (D-4) — the index is never a hard dependency.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── Content is stored INLINE (the whole point) ───────────────────────────────
 * Each entry holds the memory's `content` text alongside its vector, so a fast-
 * path hit needs NO hydrate round-trip to Deep Lake — the hot path is cloud-
 * independent. Text is small (2k rows × ~1KB ≈ 2MB), so this is a cheap trade for
 * a cloud-free hot path.
 *
 * ── Ranking is PRESERVED EXACTLY (D-3) ───────────────────────────────────────
 *   - Score = the VERBATIM `((1 + (emb <#> q)) / 2)` normalization the `<#>` SQL uses
 *     (`buildVectorSearchSql`), obtained through {@link deeplakeCosineScore} — the in-process
 *     single source of the on-wire `<#>` scoring semantics. `<#>` was proven LIVE (2026-07-09) to
 *     be TRUE COSINE (it normalizes both operands; scaling the query left `<#>` unchanged), so that
 *     normalization IS `((1 + cosine)/2)` and `deeplakeCosineScore` delegates to `cosineSimilarity`
 *     — the index and the `<#>` SQL fallback score verbatim, same magnitude AND same rank (D-3).
 *   - The 049b project scope is applied in-process (`project_id = P OR '' OR NULL`).
 *   - {@link LocalVectorIndex.search} returns rows in the SAME uniform shape
 *     {@link import("./recall.js").buildFastSemanticArmSql} produces
 *     (`source`/`id`/`text`/`created_at`/`score`), so `recallFast`'s
 *     `rowsToRankedArm` → `fuseHits` → recency consume them BYTE-UNCHANGED.
 *
 * ── Scope (this phase only) ──────────────────────────────────────────────────
 * MVP = the fast per-turn path's `memories` semantic arm, fully local, cold-built
 * on boot. Freshness/write-through (078b) and eviction/HNSW (078c) are LATER
 * phases — this module does not build them, but does not preclude them.
 */

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sqlIdent } from "../../storage/sql.js";
import { deeplakeCosineScore, EMBEDDING_DIMS, readEmbeddingCell } from "../../storage/vector.js";
import { SOFT_DELETED } from "../../storage/catalog/memories.js";

/**
 * One resident memory in the index. The vector is a {@link Float32Array} (3KB/row
 * — 2k rows ≈ 6MB of vectors), the `content` is stored INLINE so the fast path
 * needs no hydrate, and `projectId`/`createdAt`/`isDeleted` carry the exact
 * signals the 049b scope filter + the recency stage read downstream.
 */
export interface LocalVectorEntry {
	/** The 768-dim `content_embedding` as a packed Float32Array. */
	readonly vec: Float32Array;
	/** The memory's `content` text, stored inline so a hit needs no hydrate round-trip. */
	readonly content: string;
	/** The memory's `created_at` (ISO TEXT, or ""), for the recency-activation stage. */
	readonly createdAt: string;
	/** The RESOLVED 049b `project_id` (or "" for an unset/legacy/global row). */
	readonly projectId: string;
	/** The `is_deleted` flag (BIGINT 0/1); a `1` (soft-deleted) row is never returned. */
	readonly isDeleted: number;
}

/**
 * The injectable index seam the recall engine consumes (PRD-078a). `recallFast`
 * routes the `memories` semantic arm through {@link search} when the index is
 * enabled + {@link ready}; otherwise it falls back to the `<#>` SQL path (D-4).
 * A concrete {@link InMemoryLocalVectorIndex} is the production implementation;
 * a unit test injects a fake to drive the enabled/cold/throwing branches.
 */
export interface LocalVectorIndex {
	/** True once the cold-build has populated the index; recall falls back to `<#>` until then. */
	readonly ready: boolean;
	/** The number of resident entries (post-skip). */
	readonly size: number;
	/**
	 * Flat cosine search over the resident `memories` vectors, scoped + top-k'd.
	 * Returns rows in the SAME shape {@link import("./recall.js").buildFastSemanticArmSql}
	 * produces so `recallFast`'s `rowsToRankedArm` consumes them byte-unchanged:
	 * `{ source: "memories", id, text, created_at, score }`, ordered by `score` DESC.
	 */
	search(queryVec: readonly number[], projectId: string, k: number): StorageRow[];
}

/** A scored entry the flat scan produces before it is mapped to the row shape. */
interface ScoredEntry {
	readonly id: string;
	readonly content: string;
	readonly createdAt: string;
	/** The VERBATIM `((1 + (emb <#> q)) / 2)` similarity (from {@link deeplakeCosineScore}). */
	readonly score: number;
}

/**
 * The RESOLVED project-scope admission for one entry — the in-process mirror of
 * the 049b `buildProjectScopeConjunct` predicate (`recall/scope-clause.ts`).
 * A row is admitted iff its `project_id` equals the session's `projectId`, is the
 * UNSET sentinel `""`, or is NULL/undefined (a legacy pre-049b row) — every OTHER
 * project's rows are excluded, EXACTLY as the `<#>` SQL filters them server-side,
 * so a project-B row is never returned even on a strong cosine hit.
 */
function admittedByProjectScope(entryProjectId: string | null | undefined, projectId: string): boolean {
	return entryProjectId === projectId || entryProjectId === "" || entryProjectId === null || entryProjectId === undefined;
}

/**
 * Coerce a stored `FLOAT4[]` cell into a `Float32Array` of exactly {@link EMBEDDING_DIMS},
 * or `null` when it is not a usable 768-dim vector (empty / wrong-dim / non-finite /
 * unparseable).
 *
 * The on-the-wire PARSE is delegated to {@link readEmbeddingCell} (`vector.ts`) — the ONE
 * canonical reader of a live DeepLake embedding cell, ALSO used by the PRD-047b rerank fetch
 * (`recall.ts` `fetchCandidateEmbeddings`, which reads the SAME `content_embedding` column). The
 * cold-build previously hand-rolled its own coercion, which never exercised the real returned-row
 * shape (the 078a unit tests fed pre-formed arrays), so any drift between the homegrown parse and
 * the live cell format silently mass-skipped rows. Routing through the shared reader keeps the two
 * paths byte-identical: a vector the reranker parses is a vector the index parses.
 *
 * The 768-dim + finiteness contract is enforced HERE, AFTER the canonical parse (D-3): the a-AC-1
 * skip keeps an empty back-filled `[]`, a wrong-dim vector, or a non-finite entry out of the index
 * rather than corrupting a search. `readEmbeddingCell` already rejects non-finite entries, but the
 * explicit re-check keeps this function's contract self-contained.
 */
function toFloat32Vector(value: unknown): Float32Array | null {
	const parsed = readEmbeddingCell(value); // canonical live-cell parse (shared with the reranker).
	if (parsed === null) return null; // not an array / empty / non-finite → skip.
	if (parsed.length !== EMBEDDING_DIMS) return null; // wrong-dim → the a-AC-1 skip.
	const vec = new Float32Array(EMBEDDING_DIMS);
	for (let i = 0; i < EMBEDDING_DIMS; i += 1) {
		const n = parsed[i]!;
		if (!Number.isFinite(n)) return null; // belt-and-suspenders (readEmbeddingCell already guards this).
		vec[i] = n;
	}
	return vec;
}

/** Coerce a row cell to a string (never undefined/null). */
function cellText(value: unknown): string {
	return value === undefined || value === null ? "" : String(value);
}

/** Coerce a row cell to a number (default 0) — the `is_deleted` BIGINT reads back as 0/1. */
function cellNumber(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : 0;
}

/**
 * The production in-RAM flat-cosine index (D-2). Holds `id → {@link LocalVectorEntry}`,
 * built at boot from paged `memories` rows. Search is a flat scan — O(N) per query,
 * but pure in-process arithmetic (no I/O), so ~a few-thousand vectors resolve in
 * sub-100ms (a-AC-6) versus the ~2.6s `<#>` full-column scan.
 */
export class InMemoryLocalVectorIndex implements LocalVectorIndex {
	private readonly entries = new Map<string, LocalVectorEntry>();
	private built = false;

	get ready(): boolean {
		return this.built;
	}

	get size(): number {
		return this.entries.size;
	}

	/**
	 * Populate the index from paged `memories` rows (a-AC-1). Each row must carry
	 * `id`, `content`, `content_embedding`, `project_id`, `created_at`, `is_deleted`
	 * (the {@link buildMemoriesColdBuildSql} projection). A row whose embedding is
	 * empty / wrong-dim / non-finite is SKIPPED (guarded by {@link toFloat32Vector} —
	 * `vec.length === EMBEDDING_DIMS`), so a malformed vector never enters recall.
	 * Marks the index {@link ready} at the end so recall falls back to `<#>` until the
	 * whole build lands (an atomic flip, not a partial index). Returns the `{ loaded, skipped }`
	 * counts so the cold-build can emit the secret-free `recall.index.built` observability event
	 * (a dogfood can then SEE `loaded ≈ corpus` / `skipped ≈ 0`, the signal that would have caught
	 * a mass-skip regression immediately).
	 */
	buildFromRows(rows: readonly StorageRow[]): { loaded: number; skipped: number } {
		let skipped = 0;
		for (const row of rows) {
			const id = cellText(row.id);
			if (id === "") {
				skipped += 1; // no identity → cannot dedup/fuse; skip.
				continue;
			}
			const vec = toFloat32Vector(row.content_embedding);
			if (vec === null) {
				skipped += 1; // empty / wrong-dim / malformed embedding → a-AC-1 skip.
				continue;
			}
			this.entries.set(id, {
				vec,
				content: cellText(row.content),
				createdAt: cellText(row.created_at),
				projectId: cellText(row.project_id),
				isDeleted: cellNumber(row.is_deleted),
			});
		}
		this.built = true;
		return { loaded: this.entries.size, skipped };
	}

	/**
	 * Flat cosine search (a-AC-2). Over every entry that (a) is admitted by the 049b
	 * project scope, (b) is NOT soft-deleted (`is_deleted !== 1`), and (c) has a
	 * vector, compute the VERBATIM `((1 + (emb <#> q)) / 2)` score via {@link deeplakeCosineScore}
	 * (the in-process single source of the `<#>` normalization — not re-derived), sort DESC, and
	 * return the top-k as rows in the {@link import("./recall.js").buildFastSemanticArmSql} shape so
	 * the downstream RRF/recency is byte-identical to the `<#>` path.
	 */
	search(queryVec: readonly number[], projectId: string, k: number): StorageRow[] {
		const topK = Math.max(0, Math.trunc(k));
		if (topK === 0) return [];
		const scored: ScoredEntry[] = [];
		for (const [id, entry] of this.entries) {
			if (entry.isDeleted === SOFT_DELETED) continue; // soft-deleted rows never surface.
			if (!admittedByProjectScope(entry.projectId, projectId)) continue; // 049b project scope.
			// Score through deeplakeCosineScore — the single source of the on-wire `<#>` scoring
			// semantics (vector.ts). `<#>` is TRUE COSINE (measured live), so this returns the exact
			// `((1 + (emb <#> q))/2)` the SQL arm produces — verbatim magnitude AND rank. The
			// Float32Array is a numeric ArrayLike it reads by index+length; the cast only satisfies
			// the `readonly number[]` parameter type.
			const score = deeplakeCosineScore(queryVec, entry.vec as unknown as readonly number[]);
			if (score === null) continue; // unusable (zero-magnitude / non-finite) — never scored on garbage.
			scored.push({ id, content: entry.content, createdAt: entry.createdAt, score });
		}
		// Sort by score DESC; the arm's row order IS the rank signal RRF consumes, so a
		// deterministic id tie-break keeps the order stable across equal scores.
		scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		return scored.slice(0, topK).map((s) => ({
			source: "memories",
			id: s.id,
			text: s.content,
			created_at: s.createdAt,
			score: s.score,
		}));
	}
}

/**
 * The secret-free observability event the cold-build emits ONCE when it finishes (PRD-078a-fix).
 * COUNTS ONLY — the number of vectors loaded into the index, the number of rows skipped (empty /
 * wrong-dim / id-less embeddings), the number of Deep Lake pages scanned, and the wall-clock ms —
 * mirroring the `recall.shed` / `recall.timing` convention (NO query text, id, content, or token).
 * The composition root wires it to `daemon.logger.event("recall.index.built", …)` so a dogfood can
 * SEE the index populated (`loaded ≈ 2000`, `skipped ≈ 0`) instead of inferring health from an
 * indirect per-query `annHits` — the exact blind spot that let a build-time regression hide.
 */
export interface RecallIndexBuiltEvent {
	/** Vectors resident in the index after the build (== {@link InMemoryLocalVectorIndex.size}). */
	readonly loaded: number;
	/** Rows scanned but NOT indexed (empty / wrong-dim / non-finite / id-less embedding). */
	readonly skipped: number;
	/** Deep Lake pages fetched during the cold-build scan. */
	readonly pages: number;
	/** Cold-build wall-clock, milliseconds. */
	readonly ms: number;
}

/**
 * The page size for the cold-build scan. A bounded page keeps per-round-trip memory
 * capped even as `memories` grows, mirroring the job-queue's paginated stats scan.
 */
export const COLD_BUILD_PAGE_SIZE = 500;

/** A hard cap on cold-build pages so a pathological table can never hang the boot build. */
export const COLD_BUILD_MAX_PAGES = 10_000;

/**
 * Build ONE page of the cold-build scan (PRD-078a step 2). SELECTs exactly the
 * columns {@link InMemoryLocalVectorIndex.buildFromRows} reads, over rows whose
 * embedding is non-empty (`ARRAY_LENGTH(content_embedding, 1) > 0` — the SAME
 * null-embedding guard the `<#>` arm uses), ordered by `id` for deterministic
 * OFFSET paging. Every identifier routes through `sqlIdent`; the LIMIT/OFFSET are
 * clamped integers inlined as numeric fragments (no value interpolation), so
 * `audit:sql` reads the statement as fully guarded.
 */
export function buildMemoriesColdBuildSql(pageSize: number, offset: number): string {
	const tbl = sqlIdent("memories");
	const idCol = sqlIdent("id");
	const contentCol = sqlIdent("content");
	const embCol = sqlIdent("content_embedding");
	const projectCol = sqlIdent("project_id");
	const createdCol = sqlIdent("created_at");
	const deletedCol = sqlIdent("is_deleted");
	const pageLimit = Math.max(1, Math.trunc(pageSize));
	const pageOffset = Math.max(0, Math.trunc(offset));
	return (
		`SELECT ${idCol} AS id, ${contentCol}::text AS content, ${embCol} AS content_embedding, ` +
		`${projectCol} AS project_id, ${createdCol}::text AS created_at, ${deletedCol} AS is_deleted ` +
		`FROM "${tbl}" ` +
		`WHERE ARRAY_LENGTH(${embCol}, 1) > 0 ` +
		`ORDER BY ${idCol} ` +
		`LIMIT ${pageLimit} OFFSET ${pageOffset}`
	);
}

/**
 * Cold-build the index by paging embedded `memories` rows from Deep Lake (PRD-078a
 * step 2 / a-AC-1). Runs OFF the recall hot path (fired non-blocking from the
 * composition root) and MAY exceed the 3s per-turn budget — recall falls back to
 * the `<#>` SQL path until the index is {@link LocalVectorIndex.ready}.
 *
 * FAIL-SOFT: a non-`ok` page (missing table on a fresh partition, any query error,
 * a connection flap) STOPS paging and builds from whatever was gathered — the
 * index still flips {@link ready} true, so the accelerator serves the rows it has
 * and the `<#>` fallback covers the rest. A THROW is swallowed by the caller's
 * fire-and-forget wrapper; recall keeps working via `<#>` (D-4).
 *
 * Reads through the READ {@link StorageQuery} under the daemon {@link QueryScope}
 * (the org/workspace partition), so the cold-build sees only the daemon's tenant.
 */
export async function coldBuildLocalVectorIndex(
	index: InMemoryLocalVectorIndex,
	storage: StorageQuery,
	scope: QueryScope,
	pageSize: number = COLD_BUILD_PAGE_SIZE,
	// PRD-078a-fix: the OPTIONAL secret-free observability seam, wired at the composition root to
	// `daemon.logger.event("recall.index.built", …)` (the same posture as `onShed`/`onTiming`). Absent
	// in the unit suite (nowhere to log) — a no-op then, so the build is byte-for-byte the prior path.
	onBuilt?: (event: RecallIndexBuiltEvent) => void,
): Promise<void> {
	const startedAt = Date.now();
	const collected: StorageRow[] = [];
	const size = Math.max(1, Math.trunc(pageSize));
	let pages = 0;
	for (let page = 0; page < COLD_BUILD_MAX_PAGES; page += 1) {
		const sql = buildMemoriesColdBuildSql(size, page * size);
		const result = await storage.query(sql, scope, { source: "recall-arm" });
		if (!isOk(result)) break; // fail-soft: build from whatever we gathered (index still readies).
		pages += 1;
		const rows = result.rows;
		for (const row of rows) collected.push(row);
		if (rows.length < size) break; // short page → the table is exhausted.
	}
	const { loaded, skipped } = index.buildFromRows(collected);
	// Emit ONCE, after the atomic ready-flip, so the event reflects the FINAL resident count. Counts
	// only (loaded / skipped / pages / ms) — no query text, id, or content — per the secret-free rule.
	onBuilt?.({ loaded, skipped, pages, ms: Date.now() - startedAt });
}
