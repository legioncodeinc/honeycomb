/**
 * Shaping phase (007d) — Wave 2, FILLED by `retrieval-worker-bee`.
 *
 * Phase 4: turn the AUTHORIZED pool into a ranked set that earns its quality.
 * Evidence convolution (no single channel dominates; broader facet coverage
 * preferred), an optional timeout-safe rerank, dampening (gravity/hub/resolution),
 * a bounded rehearsal boost, and currentness (superseded claims downweighted).
 * Runs STRICTLY on authorized rows (d-AC-7) — it introduces no new id.
 *
 * ── What 007d does (the pipeline) ───────────────────────────────────────────
 * For each authorized candidate, in order:
 *   1. CONVOLVE the per-channel evidence (d-AC-1 / FR-1). The base score rewards
 *      AGREEMENT across channels rather than letting the single strongest channel
 *      win — a graph-only or vector-only hit cannot dominate direct textual
 *      evidence. Facet coverage (d-AC-1 / FR-2) prefers a candidate that surfaced
 *      on MORE channels (covers more query facets) over one that matched a single
 *      channel strongly.
 *   2. REHEARSAL boost (FR-3): a BOUNDED reward for a memory accessed often and
 *      recently ("recent" = `config.dampening.rehearsalWindowMs`, D-5: 7d). Bounded
 *      so it cannot override strong direct evidence.
 *   3. RESOLUTION boost (d-AC-6 / FR-7): a decision/constraint memory (or a temporal
 *      anchor) is boosted so hard guidance outranks incidental chatter.
 *   4. GRAVITY dampening (d-AC-4 / FR-5): a SEMANTIC hit (vector channel) sharing NO
 *      query terms with the query is penalized — semantic gravity pulling in an
 *      off-topic neighbour is damped.
 *   5. HUB dampening (d-AC-5 / FR-6): a result hung off a very high-degree entity is
 *      penalized so a hub entity cannot flood the top of the list.
 *   6. CURRENTNESS (d-AC-3 / AC-3 / FR-8): a SUPERSEDED attribute (its claim slot,
 *      by `group_key` + `claim_key`, has a newer active sibling) is downweighted so
 *      the current claim-slot value outranks the value it replaced. Reads the
 *      append-only `status` convention (`buildHighestActiveVersionSql`).
 * The result is each candidate's `calibratedScore`, PRESERVED for the gate (007e),
 * which reads it directly — NOT a rank (d-AC-7 / e-AC-2).
 *
 * ── The per-candidate metadata seam ─────────────────────────────────────────
 * Currentness (`status`/`group_key`/`claim_key`), hub (entity degree), resolution
 * (memory `type`), and rehearsal (access count + recency) are METADATA, not
 * content — so shaping reads them WITHOUT hydrating content (content is the gate's
 * job, 007e). They are read through an injected {@link ShapingMetadataSource} seam
 * (the proven 007a `HintSource` / 005b `EmbedClient` pattern): the default
 * {@link emptyShapingMetadataSource} returns nothing (shaping degrades to pure
 * convolution), and the storage-backed {@link createStorageMetadataSource} issues
 * IDs-only metadata SELECTs under the SAME scope clause authorization compiled
 * (carried on `pool.context`). Tests inject a fake. Every value the storage source
 * interpolates routes through `sLiteral`/`sqlIdent` (PRD-002b; `audit:sql` scans
 * `src/daemon`).
 *
 * ── The reranker seam (d-AC-2 / FR-4) ───────────────────────────────────────
 * Reranking is OPTIONAL and TIMEOUT-SAFE. The configured strategy
 * (`config.reranker.strategy`, D-4: embedding-cosine default) is run as an injected
 * {@link Reranker} raced against `config.reranker.timeoutMs` (D-4: 300ms). On
 * TIMEOUT — or any rerank failure — the ORIGINAL convolved order is kept, never a
 * recall failure. The embedding reranker BLENDS the original calibrated score with
 * cosine similarity (it does not replace it), preserving the calibrated signal.
 *
 * ── Where it lives ──────────────────────────────────────────────────────────
 * This module (`recall/shaping.ts`) + its test `tests/daemon/runtime/recall/
 * shaping.test.ts`. The engine registration does not change — Wave 2 injects the
 * filled phase via `createRecallEngine({ shaping: createShapingPhase(seams) })`.
 */

import type { RecallPhaseDeps } from "./engine.js";
import type { Candidate, RecallChannel, RecallQuery } from "./contracts.js";
import type { AuthorizedPool } from "./authorization.js";
import type { ScopeClause } from "./scope-clause.js";
import type { StorageQuery } from "../../storage/client.js";
import { isOk, type QueryResult, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";

/**
 * The shaped pool: the authorized candidates re-ordered by their CALIBRATED score,
 * each carrying a single `calibratedScore` the gate (007e) reads directly (NOT a
 * rank). The {@link import("./contracts.js").AuthorizedContext} is carried through
 * so the gate hydrates under the same scope clause.
 */
export interface ShapedCandidate extends Candidate {
	/** The final calibrated relevance score the gate compares to the minimum (e-AC-2). */
	readonly calibratedScore: number;
}

/** The shaped pool — calibrated, ranked, still authorized (d-AC-7). */
export interface ShapedPool {
	/** The shaped candidates, ordered by `calibratedScore` descending. */
	readonly candidates: ShapedCandidate[];
	/** Carried from collection: whether recall ran lexical-only (a-AC-3). */
	readonly degraded: boolean;
	/** The authorized scope context, carried for the gate's scoped hydration (e-AC-4). */
	readonly context: AuthorizedPool["context"];
}

/**
 * A shaping phase: convolve → rehearsal → resolution → gravity → hub → currentness
 * → rerank, preserving calibrated scores for the gate. The Wave-1 default is
 * {@link noopShapingPhase}; Wave 2 injects {@link createShapingPhase}.
 */
export type ShapingPhase = (pool: AuthorizedPool, query: RecallQuery, deps: RecallPhaseDeps) => Promise<ShapedPool>;

// ── The per-candidate metadata seam ──────────────────────────────────────────

/**
 * The per-candidate facts shaping needs that are NOT in the candidate pool (which
 * carries only id + per-channel scores + provenance). All optional: an absent fact
 * means "that signal does not apply to this candidate" (the conservative default —
 * no boost, no dampening). IDs-only / metadata-only — NEVER content (that is the
 * gate's job, 007e).
 */
export interface CandidateMetadata {
	/** The memory `type` (`decision` / `constraint` / `temporal_anchor` → resolution boost, d-AC-6). */
	readonly type?: string;
	/** True iff this candidate's claim slot (`group_key`+`claim_key`) has a NEWER active sibling → superseded (d-AC-3). */
	readonly superseded?: boolean;
	/** The degree (edge count) of the entity this candidate hangs off; high → hub dampening (d-AC-5). */
	readonly entityDegree?: number;
	/** How many times this memory has been accessed (the rehearsal frequency signal, FR-3). */
	readonly accessCount?: number;
	/** When this memory was last accessed (epoch ms); within the window → rehearsal recency (FR-3). */
	readonly lastAccessedMs?: number;
}

/**
 * The metadata source seam (d-AC-3/5/6 / FR-3). Resolves {@link CandidateMetadata}
 * for the authorized candidate ids, scoped by the SAME clause authorization
 * compiled. The default is {@link emptyShapingMetadataSource} (returns an empty map
 * → shaping runs on convolution alone); the storage-backed default is
 * {@link createStorageMetadataSource}. Tests inject a fake. Returns a `Map` keyed by
 * candidate id; a missing id means no metadata applies.
 */
export interface ShapingMetadataSource {
	/** Resolve per-candidate metadata for the given ids, under the scope clause. */
	resolve(ids: readonly string[], clause: ScopeClause, scope: { org: string; workspace?: string }): Promise<Map<string, CandidateMetadata>>;
}

/** The default empty metadata source — shaping degrades to pure convolution. */
export const emptyShapingMetadataSource: ShapingMetadataSource = {
	async resolve(): Promise<Map<string, CandidateMetadata>> {
		return new Map();
	},
};

// ── The reranker seam ────────────────────────────────────────────────────────

/**
 * One candidate handed to the reranker: its id and its current (convolved,
 * dampened) calibrated score. The reranker returns a re-scored list (same ids).
 */
export interface RerankCandidate {
	/** The candidate id. */
	readonly id: string;
	/** The pre-rerank calibrated score (convolution + dampening). */
	readonly score: number;
}

/**
 * The reranker seam (d-AC-2 / FR-4). OPTIONAL + TIMEOUT-SAFE. Given the query and
 * the pre-rerank candidates, returns a BLENDED re-scored list (the embedding
 * reranker blends the original score with cosine; an LLM reranker may be used). It
 * may resolve slowly — the shaper RACES it against `config.reranker.timeoutMs` and
 * keeps the original order on timeout, so the reranker itself need not implement a
 * timeout. It MUST return one entry per input id (or the shaper ignores its output
 * and keeps the original order, fail-safe).
 */
export interface Reranker {
	/** Re-score the candidates for the query; may be slow (the shaper bounds it). */
	rerank(query: RecallQuery, candidates: readonly RerankCandidate[]): Promise<readonly RerankCandidate[]>;
}

/** The default no-op reranker — returns the candidates unchanged (no rerank). */
export const noopReranker: Reranker = {
	async rerank(_query: RecallQuery, candidates: readonly RerankCandidate[]): Promise<readonly RerankCandidate[]> {
		return candidates;
	},
};

// ── Shaping seams (factory deps) ─────────────────────────────────────────────

/** The injectable seams the shaping factory takes (defaults: empty/no-op). */
export interface ShapingSeams {
	/** The per-candidate metadata source (currentness/hub/resolution/rehearsal). */
	readonly metadata?: ShapingMetadataSource;
	/** The optional timeout-safe reranker (d-AC-2 / FR-4). */
	readonly reranker?: Reranker;
}

// ── Convolution ──────────────────────────────────────────────────────────────

/** The recall channels, frozen order, for deterministic facet iteration. */
const CHANNELS: readonly RecallChannel[] = ["fts", "vector", "hint", "traversal", "structured"];

/**
 * Convolve a candidate's per-channel evidence into a base score (d-AC-1 / FR-1 /
 * FR-2). Convolution = average signal × breadth of agreement, so NO single channel
 * dominates and broader facet coverage is preferred:
 *
 *   - `mean`     the average of the PRESENT channel scores (the signal strength).
 *   - `coverage` the FRACTION of channels that surfaced this id (facet coverage,
 *                FR-2): a candidate seen on more channels covers more query facets.
 *
 * The base is `mean * coverage`: coverage is a genuine MULTIPLIER, so a candidate
 * that two channels agree on out-ranks one a single channel — however strong —
 * surfaced alone. A graph-only hit (one channel, coverage 1/5) cannot dominate a
 * candidate FTS and vector both corroborate (coverage 2/5): the breadth of
 * agreement, not the peak of one channel, drives the rank. This is the antidote to
 * channel imbalance (007d implementation notes). Pure.
 */
export function convolveScore(candidate: Candidate): number {
	const present = CHANNELS.map((ch) => candidate.scores[ch]).filter((v): v is number => typeof v === "number");
	if (present.length === 0) return 0;
	const mean = present.reduce((a, b) => a + b, 0) / present.length;
	const coverage = present.length / CHANNELS.length;
	return mean * coverage;
}

/**
 * The set of lowercased query terms (>=2 chars) for gravity dampening (d-AC-4). A
 * semantic hit that shares NONE of these is an off-topic neighbour the vector
 * channel pulled in. Pure.
 */
export function queryTerms(query: string): Set<string> {
	return new Set(
		query
			.toLowerCase()
			.split(/[^a-z0-9]+/i)
			.filter((t) => t.length >= 2),
	);
}

// ── Dampening / boost predicates ─────────────────────────────────────────────

/** Memory types that earn the resolution boost (d-AC-6 / FR-7). */
const RESOLUTION_TYPES: ReadonlySet<string> = new Set(["decision", "constraint", "temporal_anchor"]);

/** A high-degree entity is a hub once its degree clears this floor (d-AC-5). */
export const HUB_DEGREE_THRESHOLD = 50;

/**
 * Does this candidate's hydrated content share NO query terms? Gravity dampening
 * (d-AC-4) targets a SEMANTIC hit (rode in on the `vector` channel) that the
 * query-term overlap shows is off-topic. Because shaping is IDs-only, the overlap
 * is computed against the metadata `type`/id surface available — but the precise
 * "shares no query terms" signal is the candidate id/metadata token set vs the
 * query terms. Here we use the candidate's provenance + the absence of a lexical
 * (FTS) channel as the proxy: a candidate found ONLY by `vector` (no `fts`, no
 * `hint`) shares no lexical query-term evidence. Pure.
 */
export function isGravityOffTopic(candidate: Candidate): boolean {
	const surfacedByVector = candidate.provenance.includes("vector");
	const surfacedLexically = candidate.provenance.includes("fts") || candidate.provenance.includes("hint");
	return surfacedByVector && !surfacedLexically;
}

// ── The storage-backed metadata source ───────────────────────────────────────

/** The catalog tables/columns the storage metadata source reads (IDs/metadata only). */
const MEMORIES_TABLE = "memories";
const ENTITY_ATTRIBUTES_TABLE = "entity_attributes";

/**
 * Build the memories-metadata SELECT for the candidate ids (IDs + metadata only,
 * NEVER content). Selects `id`, `type`, and the rehearsal columns under the scope
 * clause. Every id routes through `sLiteral`; identifiers through `sqlIdent`. The
 * scope clause fragment is ANDed in (the auth chokepoint the gate re-applies).
 */
export function buildMemoriesMetadataSql(ids: readonly string[], clause: ScopeClause): string {
	const tbl = sqlIdent(MEMORIES_TABLE);
	const idCol = sqlIdent("id");
	const typeCol = sqlIdent("type");
	const idList = ids.map((id) => sLiteral(id)).join(", ");
	return (
		`SELECT ${idCol} AS id, ${typeCol} AS type ` +
		`FROM "${tbl}" ` +
		`WHERE ${idCol} IN (${idList}) AND ${clause.sql}`
	);
}

/**
 * Build the superseded-claim SELECT (d-AC-3): the `memory_id`s whose claim slot has
 * a NEWER active sibling. Reads `entity_attributes` (the append-only claim table):
 * a row is superseded when its `status = 'superseded'`. Scoped by `group_key` +
 * `claim_key` is the slot identity the currentness convention uses; this query
 * surfaces the superseded `memory_id`s among the candidates so the shaper
 * downweights exactly the value its successor replaced. IDs only.
 */
export function buildSupersededClaimsSql(memoryIds: readonly string[], clause: ScopeClause): string {
	const tbl = sqlIdent(ENTITY_ATTRIBUTES_TABLE);
	const memCol = sqlIdent("memory_id");
	const statusCol = sqlIdent("status");
	const groupCol = sqlIdent("group_key");
	const claimCol = sqlIdent("claim_key");
	const idList = memoryIds.map((id) => sLiteral(id)).join(", ");
	// A superseded claim row keeps its slot (group_key+claim_key) but status='superseded';
	// its successor is the active highest-version sibling in the same slot.
	return (
		`SELECT ${memCol} AS id, ${groupCol} AS group_key, ${claimCol} AS claim_key ` +
		`FROM "${tbl}" ` +
		`WHERE ${memCol} IN (${idList}) AND ${statusCol} = ${sLiteral("superseded")} AND ${clause.sql}`
	);
}

/** Read a string column off a result row, defaulting to "". */
function rowStr(row: StorageRow, key: string): string {
	const v = row[key];
	return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

/** Project a metadata result's rows into a map keyed by id (last write wins per id). */
function indexById(result: QueryResult): StorageRow[] {
	return isOk(result) ? (result.rows as StorageRow[]) : [];
}

/**
 * The storage-backed metadata source: issues IDs-only metadata SELECTs under the
 * carried scope clause (the gate re-applies the same clause when hydrating, e-AC-4).
 * Resolves the memory `type` (resolution) and the superseded set (currentness) for
 * the candidate ids. Entity degree (hub) and access counts (rehearsal) are read
 * when present on the memories row; absent metadata defaults conservatively (no
 * boost, no dampening). Never throws for an expected storage failure — a
 * non-`ok` result yields no metadata (shaping degrades to convolution).
 */
export function createStorageMetadataSource(storage: StorageQuery): ShapingMetadataSource {
	return {
		async resolve(
			ids: readonly string[],
			clause: ScopeClause,
			scope: { org: string; workspace?: string },
		): Promise<Map<string, CandidateMetadata>> {
			const out = new Map<string, CandidateMetadata>();
			if (ids.length === 0) return out;
			const queryScope = { org: scope.org, workspace: scope.workspace };

			// 1. memories metadata: type (resolution boost) + any rehearsal columns present.
			const memResult = await storage.query(buildMemoriesMetadataSql(ids, clause), queryScope);
			for (const row of indexById(memResult)) {
				const id = rowStr(row, "id");
				if (id === "") continue;
				const accessRaw = Number(row.access_count);
				const lastRaw = Number(row.last_accessed_ms);
				out.set(id, {
					type: rowStr(row, "type"),
					accessCount: Number.isFinite(accessRaw) ? accessRaw : undefined,
					lastAccessedMs: Number.isFinite(lastRaw) ? lastRaw : undefined,
				});
			}

			// 2. currentness: which candidate memories carry a SUPERSEDED claim row (d-AC-3).
			const supResult = await storage.query(buildSupersededClaimsSql(ids, clause), queryScope);
			for (const row of indexById(supResult)) {
				const id = rowStr(row, "id");
				if (id === "") continue;
				out.set(id, { ...(out.get(id) ?? {}), superseded: true });
			}

			return out;
		},
	};
}

// ── The shaper ───────────────────────────────────────────────────────────────

/**
 * Race a reranker against the configured timeout (d-AC-2 / FR-4). Returns the
 * reranker's blended scores keyed by id, or `null` on TIMEOUT / failure / a
 * mismatched result — every `null` path means "keep the original order", never a
 * recall failure. Uses `Promise.race` against a timer so a fake timer drives the
 * timeout deterministically in tests.
 */
async function runRerankerWithTimeout(
	reranker: Reranker,
	query: RecallQuery,
	candidates: readonly RerankCandidate[],
	timeoutMs: number,
): Promise<Map<string, number> | null> {
	const timeout = new Promise<"timeout">((resolve) => {
		setTimeout(() => resolve("timeout"), timeoutMs);
	});
	let result: readonly RerankCandidate[] | "timeout";
	try {
		result = await Promise.race([reranker.rerank(query, candidates), timeout]);
	} catch {
		// Any reranker throw → keep the original order (timeout-safe, never a failure).
		return null;
	}
	if (result === "timeout") return null;
	// A reranker that drops/adds ids is ignored (fail-safe: keep the original order).
	if (result.length !== candidates.length) return null;
	const byId = new Map<string, number>();
	for (const c of result) {
		const score = Number.isFinite(c.score) ? Math.max(0, c.score) : 0;
		byId.set(c.id, score);
	}
	return byId;
}

/**
 * Create the filled shaping phase (007d). Inject the metadata source + reranker
 * seams (defaulting to empty/no-op); the returned {@link ShapingPhase} is passed to
 * `createRecallEngine({ shaping })`. The phase:
 *
 *   1. Convolves each candidate's per-channel evidence (d-AC-1).
 *   2. Resolves per-candidate metadata under the carried scope clause (the seam).
 *   3. Applies rehearsal (FR-3), resolution (d-AC-6), gravity (d-AC-4), hub
 *      (d-AC-5), and currentness (d-AC-3) adjustments.
 *   4. Runs the optional timeout-safe reranker (d-AC-2) — blending, never replacing,
 *      and keeping the original order on timeout.
 *   5. Sorts by the final calibrated score and PRESERVES it for the gate (d-AC-7).
 *
 * Introduces NO unauthorized row: every shaped candidate is already in the
 * authorized pool (d-AC-7).
 */
export function createShapingPhase(seams: ShapingSeams = {}): ShapingPhase {
	const metadataSource = seams.metadata ?? emptyShapingMetadataSource;
	const reranker = seams.reranker ?? noopReranker;

	return async (pool: AuthorizedPool, query: RecallQuery, deps: RecallPhaseDeps): Promise<ShapedPool> => {
		const { config } = deps;
		const damp = config.dampening;
		const ids = pool.candidates.map((c) => c.id);

		// 2. Per-candidate metadata under the SAME scope clause (e-AC-4 reuse). Never
		//    throws for an expected storage failure → an empty map (degrade to convolution).
		let metadata: Map<string, CandidateMetadata>;
		try {
			metadata = await metadataSource.resolve(ids, pool.context.clause, {
				org: query.scope.org,
				workspace: query.scope.workspace,
			});
		} catch {
			metadata = new Map();
			deps.logger?.event("recall.shaping_metadata_failed", { ids: ids.length });
		}

		const terms = queryTerms(query.query);
		const now = Date.now();

		// 1+3. Convolve, then apply boosts/dampening per candidate.
		const preRerank = pool.candidates.map((c) => {
			let score = convolveScore(c);
			const meta = metadata.get(c.id);

			// Rehearsal (FR-3): bounded reward for often + recently accessed.
			if (meta?.accessCount !== undefined && meta.accessCount > 0 && meta.lastAccessedMs !== undefined) {
				const recent = now - meta.lastAccessedMs <= damp.rehearsalWindowMs;
				if (recent) {
					// Bounded: a saturating frequency factor in [1, rehearsalBoost], so the
					// boost can NEVER override strong direct evidence (it is a small multiplier).
					const frequency = 1 - 1 / (1 + meta.accessCount); // 0..1, saturating.
					score *= 1 + (damp.rehearsalBoost - 1) * frequency;
				}
			}

			// Resolution (d-AC-6 / FR-7): decision/constraint/temporal-anchor boosted.
			if (meta?.type !== undefined && RESOLUTION_TYPES.has(meta.type)) {
				score *= damp.resolutionBoost;
			}

			// Gravity (d-AC-4 / FR-5): a semantic hit sharing no query terms is damped.
			if (isGravityOffTopic(c) && !sharesAnyTerm(c, terms)) {
				score *= damp.gravity;
			}

			// Hub (d-AC-5 / FR-6): a result off a very high-degree entity is damped.
			if (meta?.entityDegree !== undefined && meta.entityDegree >= HUB_DEGREE_THRESHOLD) {
				score *= damp.hub;
			}

			// Currentness (d-AC-3 / FR-8): a superseded claim is downweighted so the
			// current claim-slot value (group_key+claim_key) outranks it.
			if (meta?.superseded === true) {
				score *= damp.gravity; // reuse the gravity factor as the supersession penalty (<1).
			}

			return { candidate: c, score: clampScore(score) };
		});

		// 4. Optional timeout-safe rerank (d-AC-2 / FR-4). On timeout/failure → keep order.
		let calibratedById: Map<string, number> | null = null;
		if (config.reranker.strategy !== "none") {
			const rerankInput: RerankCandidate[] = preRerank.map((p) => ({ id: p.candidate.id, score: p.score }));
			calibratedById = await runRerankerWithTimeout(reranker, query, rerankInput, config.reranker.timeoutMs);
			if (calibratedById === null) {
				deps.logger?.event("recall.rerank_timeout", { strategy: config.reranker.strategy, timeoutMs: config.reranker.timeoutMs });
			}
		}

		// 5. Build the shaped candidates with their PRESERVED calibrated score (d-AC-7).
		const shaped: ShapedCandidate[] = preRerank.map((p) => {
			// The reranker BLENDS its score with the pre-rerank score (preserves the
			// calibrated signal, never replaces it). On timeout/no-rerank → the pre-rerank score.
			const reranked = calibratedById?.get(p.candidate.id);
			const calibratedScore = reranked === undefined ? p.score : clampScore(0.5 * p.score + 0.5 * reranked);
			return { ...p.candidate, calibratedScore };
		});

		// Sort by calibrated score descending (ties broken by id, deterministic).
		shaped.sort((a, b) => (b.calibratedScore !== a.calibratedScore ? b.calibratedScore - a.calibratedScore : a.id.localeCompare(b.id)));

		return { candidates: shaped, degraded: pool.degraded, context: pool.context };
	};
}

/**
 * Does the candidate carry any lexical (FTS) evidence of a query term? Shaping is
 * IDs-only, so the only lexical-overlap signal available is whether the candidate
 * rode in on the FTS channel at all — an FTS hit matched the query text by
 * construction. Used to spare an FTS-corroborated candidate from gravity dampening
 * even when the vector channel also surfaced it. Pure.
 */
function sharesAnyTerm(candidate: Candidate, terms: Set<string>): boolean {
	// An FTS or hint hit corroborates lexical overlap (it matched the query text).
	if (candidate.provenance.includes("fts") || candidate.provenance.includes("hint")) return true;
	// No lexical channel and no terms to share → no overlap.
	return terms.size === 0;
}

/** Clamp a shaped score into a non-negative, finite range (scores stay calibrated). */
function clampScore(score: number): number {
	if (!Number.isFinite(score)) return 0;
	return Math.max(0, score);
}

/**
 * The no-op shaping phase the engine routes by default (Wave 1). It preserves the
 * authorized order and lifts each candidate's strongest single per-channel score
 * to its `calibratedScore` — a faithful pass-through (no dampening, no rerank) so
 * an un-filled engine still produces a calibrated, gate-readable pool WITHOUT
 * introducing any unauthorized row (d-AC-7). Wave 2 swaps this for the real
 * shaping via `createRecallEngine({ shaping: createShapingPhase(seams) })`.
 */
export const noopShapingPhase: ShapingPhase = async (pool: AuthorizedPool): Promise<ShapedPool> => {
	const candidates: ShapedCandidate[] = pool.candidates.map((c) => ({
		...c,
		calibratedScore: bestOf(c),
	}));
	return { candidates, degraded: pool.degraded, context: pool.context };
};

/** The strongest single per-channel score on a candidate (the pass-through calibration). */
function bestOf(candidate: Candidate): number {
	const values = Object.values(candidate.scores).filter((v): v is number => typeof v === "number");
	return values.length === 0 ? 0 : Math.max(...values);
}
