/**
 * Candidate collection — PRD-007a (Wave 1, FILLED by `retrieval-worker-bee`).
 *
 * Phase 1 (prepare) + the lexical/vector/hint arms of phase 2 (collect) of recall.
 * Produces memory IDs ONLY across three channels, merged by id — NO content is
 * loaded here (a-AC-7 / FR-8). This GENERALIZES 006b's focused hybrid lookup
 * (`decision.ts` searchCandidates) from a single decision-time blend into the
 * multi-channel recall collector.
 *
 * ── The three channels ──────────────────────────────────────────────────────
 *   1. FTS (a-AC-1 / FR-1 / FR-3): a BM25-style lexical match over `memories.content`,
 *      scored 0..1, IDs only. The raw query is normalized into a safe full-text
 *      expression escaped via the 002b helpers (the endpoint binds no params);
 *      keyword expansion (D-2, OFF by default) widens the LEXICAL expression only.
 *   2. Vector (a-AC-2 / FR-4 / FR-5): the query's ORIGINAL NL string (preserved
 *      verbatim, a-AC-6 / FR-2) is embedded via the 005b embed seam, then a GPU
 *      `<#>` cosine search runs over the 768-dim `content_embedding` column,
 *      over-fetching `config.overFetchMultiplier`× (D-1: 3x) for scoped recalls.
 *      Embed off / unreachable / wrong-dim → the vector channel is SKIPPED and
 *      recall degrades to lexical (FTS + hints) with NO error (a-AC-3 / FR-6) —
 *      the silent BM25/ILIKE fallback is the correctness guarantee, never a throw.
 *   3. Hints (a-AC-4 / FR-7): the query matched against write-time prospective
 *      hints, CAPPED at `config.hintCap` (D-2: ≤3) so a memory matched only by
 *      hints cannot dominate the pool. Prospective hints are NOT written yet
 *      (PRD-006 D-2 deferred them), so the channel reads a {@link HintSource} seam
 *      that is EMPTY by default — documented, capped, and ready for the real source.
 *
 * Every channel runs within the org/workspace partition (rides the storage
 * `QueryScope`) + the engine table's `agent_id` scope conjunct (a-AC... FR-9);
 * collection MUST NOT cross a workspace boundary even though the agent READ-POLICY
 * clause is applied later in 007c (collection emits unauthorized IDs by design).
 * The channels merge by memory id, strongest calibrated score winning (a-AC-5 /
 * FR-8), per-channel provenance attached (a-AC-7).
 *
 * ── Reaching storage/embed/config (CONVENTIONS) ─────────────────────────────
 * Storage via the injected {@link import("../../storage/client.js").StorageQuery};
 * SQL via the 002b helpers + the 002e vector builders (NEVER a raw fetch, NEVER a
 * hand-quoted value — `audit:sql` scans `src/daemon`). The embed seam is the 005b
 * {@link EmbedClient}; the config knobs come from the resolved {@link RecallConfig}.
 */

import type { StorageQuery } from "../../storage/client.js";
import { isOk, type QueryResult, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent, sqlLike } from "../../storage/sql.js";
import {
	assertEmbeddingDim,
	buildVectorSearchSql,
	EMBEDDING_DIMS,
	type VectorScopeFilter,
} from "../../storage/vector.js";
import type { EmbedClient } from "../services/embed-client.js";
import type { RecallConfig } from "./config.js";
import { mergeChannels, type MergedPool, type RecallChannel, type RecallQuery, type RecallLogger } from "./contracts.js";
import { buildProjectScopeConjunct } from "./scope-clause.js";

/** The table + columns collection reads (the engine `memories` table). */
const MEMORIES_TABLE = "memories";
const ID_COLUMN = "id";
const CONTENT_COLUMN = "content";
const EMBEDDING_COLUMN = "content_embedding";
const AGENT_COLUMN = "agent_id";

/** One scored memory id (IDs only) a channel emits. */
export interface ScoredId {
	readonly id: string;
	readonly score: number;
}

/**
 * The prospective-hints source seam (a-AC-4 / FR-7). Prospective hints are written
 * at extraction/decision time in a FUTURE PRD (PRD-006 D-2 deferred them), so this
 * seam is EMPTY by default — {@link emptyHintSource}. When the real source lands it
 * implements this interface; collection caps whatever it returns at `config.hintCap`
 * so the channel can never dominate. Returns IDs + scores only (no content).
 */
export interface HintSource {
	/**
	 * Return write-time prospective-hint matches for the query, scoped to the
	 * partition + agent. IDs + scores only. May return more than the cap; collection
	 * truncates to `config.hintCap`.
	 */
	match(query: RecallQuery): Promise<readonly ScoredId[]>;
}

/** The default empty hint source (the real prospective-hints writer is a future PRD). */
export const emptyHintSource: HintSource = {
	async match(): Promise<readonly ScoredId[]> {
		return [];
	},
};

/**
 * The user-selected recall mode (PRD-044c). The daemon reads the `recallMode` vault `setting`
 * at recall time and threads it here; the closed enum is validated daemon-side
 * (`vault/api.ts` `isValidRecallMode`, fail-closed). UNDEFINED is the default — it preserves
 * today's PRD-025 runtime decision EXACTLY (the behavior-neutral ship): the vector arm runs
 * whenever a usable query vector exists, and the silent lexical fallback sets `degraded` as
 * before. An explicit mode OVERRIDES that decision:
 *   - `keyword` → SKIP the vector arm even when embeddings are on (lexical FTS only); `degraded`
 *     is NOT set — this is an intentional lexical run, not a fallback (PRD-029 coherence).
 *   - `semantic` → run the vector arm; when no usable query vector exists, fall back to lexical
 *     and set `degraded: true` EXACTLY as today (PRD-025 D-4).
 *   - `hybrid` → run BOTH arms (the current default behavior when embeddings are on).
 */
export type RecallMode = "keyword" | "semantic" | "hybrid";

/** Collection deps (a superset of the phase deps + the hint source seam). */
export interface CollectionDeps {
	/** Run every channel query through this — never a raw fetch. */
	readonly storage: StorageQuery;
	/** The org/workspace partition the storage queries run under (the outer scope ring). */
	readonly scope: { readonly org: string; readonly workspace?: string };
	/** The resolved recall config (over-fetch, hint cap, keyword expansion). */
	readonly config: RecallConfig;
	/** The query-vector embed seam (005b). Absent/null → vector channel skipped (a-AC-3). */
	readonly embed?: EmbedClient;
	/** The prospective-hints source. Defaults to {@link emptyHintSource}. */
	readonly hints?: HintSource;
	/** Optional structured-log sink (surfaces the silent-fallback degrade). */
	readonly logger?: RecallLogger;
	/**
	 * The user-selected {@link RecallMode} (PRD-044c). UNDEFINED preserves the PRD-025 runtime
	 * default (behavior-neutral); an explicit mode gates the vector channel (see {@link RecallMode}).
	 */
	readonly recallMode?: RecallMode;
}

/**
 * The engine-table scope filter for collection: the `agent_id` conjunct applied
 * inline in the SAME statement as the match (FR-9). The org/workspace partition
 * rides the storage `QueryScope` (the outer ring); `memories` is an engine table
 * with no org/workspace columns. `agent_id` defaults to `'default'` when blank.
 * The agent READ-POLICY clause is NOT applied here — that is 007c's boundary.
 */
function collectionScopeFilter(agentId: string): VectorScopeFilter {
	return {
		agentColumn: AGENT_COLUMN,
		agentValue: agentId === "" ? "default" : agentId,
	};
}

/**
 * Normalize the raw query into a safe full-text expression for the LEXICAL path
 * (FR-1). Collapses whitespace and trims; the original NL string is preserved
 * SEPARATELY for the vector path (a-AC-6 / FR-2 — see {@link collectCandidates},
 * which passes `query.query` verbatim to the embed seam). When keyword expansion is
 * on (D-2, OFF by default) the expression is widened for the lexical path ONLY so
 * it cannot pollute the semantic query.
 *
 * Pure. The returned term is the value the FTS builder escapes via `sqlLike`.
 */
export function prepareLexicalTerm(rawQuery: string, keywordExpansion: boolean): string {
	const normalized = rawQuery.replace(/\s+/g, " ").trim();
	if (!keywordExpansion) return normalized;
	// Keyword expansion (lexical-only): a conservative widening that keeps the
	// normalized phrase. The real class→instance expansion is a future tuning knob;
	// today it is a documented pass-through so the lexical path is never polluted.
	return normalized;
}

/**
 * Build the BM25-style FTS channel SQL (a-AC-1 / FR-3): an ILIKE lexical match over
 * `memories.content`, returning IDs with a score NORMALIZED to 0..1 — NOT the
 * constant-1.0 degrade sentinel. The score is a length-ratio proxy
 * (`length(term) / length(content)`, clamped 0..1): a tighter match (the term is a
 * larger fraction of the content) scores higher, a real 0..1 lexical signal the
 * merge can rank on. IDs + score ONLY, no content row loaded. Scope conjunct inline
 * (FR-9). The term routes through `sqlLike`; identifiers through `sqlIdent`.
 *
 * Pure: takes the prepared term + scope and returns SQL.
 */
export function buildFtsSql(args: {
	readonly term: string;
	readonly agentId: string;
	readonly limit: number;
	/** PRD-049b: the prebuilt project-segment conjunct, ANDed beside the agent_id conjunct (49b-AC-4). */
	readonly projectClause?: string;
}): string {
	const tbl = sqlIdent(MEMORIES_TABLE);
	const id = sqlIdent(ID_COLUMN);
	const contentCol = sqlIdent(CONTENT_COLUMN);
	const agentCol = sqlIdent(AGENT_COLUMN);
	const agentVal = sLiteral(args.agentId === "" ? "default" : args.agentId);
	const limit = Math.max(0, Math.trunc(args.limit));
	// `sqlLike` escapes the term for an ILIKE pattern (and its `%`/`_`); wrap in `%…%`.
	const pattern = `'%${sqlLike(args.term)}%'`;
	// BM25-style 0..1 proxy: how large is the matched term relative to the content?
	// LEAST(1, len(term)/GREATEST(1,len(content))) keeps it in [0,1] without div-by-zero.
	// The term length is a numeric literal computed at build time (not a value sink).
	const termLen = args.term.length;
	const scoreSql = `LEAST(1.0, ${termLen}.0 / GREATEST(1, LENGTH(${contentCol}::text)))`;
	// PRD-049b (49b-AC-2 / 49b-AC-4): the project segment is ANDed BESIDE the agent_id conjunct
	// in the SAME statement — project is an additional predicate, not a replacement.
	const projectClause = args.projectClause ?? "";
	return (
		`SELECT ${id} AS id, ${scoreSql} AS score ` +
		`FROM "${tbl}" ` +
		`WHERE ${contentCol}::text ILIKE ${pattern} AND ${agentCol} = ${agentVal}${projectClause} ` +
		"ORDER BY score DESC " +
		`LIMIT ${limit}`
	);
}

/** Project a query result's rows into scored ids (IDs + clamped 0..1 scores). */
function toScoredIds(result: QueryResult): ScoredId[] {
	if (!isOk(result)) return [];
	return (result.rows as StorageRow[]).map((row) => {
		const rawScore = typeof row.score === "number" ? row.score : Number(row.score);
		const score = Number.isFinite(rawScore) ? Math.min(1, Math.max(0, rawScore)) : 0;
		return { id: String(row.id ?? ""), score };
	});
}

/**
 * Compute the 768-dim query vector for the vector channel via the 005b embed seam,
 * from the query's ORIGINAL NL string (a-AC-6 / FR-2 — passed verbatim, never the
 * lexical-normalized term). Returns the validated vector, or `null` when embeddings
 * are disabled, the embed client is absent/unreachable, or the vector is the wrong
 * dimension — in every `null` case the vector channel is SKIPPED and recall degrades
 * to lexical (a-AC-3 / FR-6). Never throws: a wrong-dim/non-finite vector is caught
 * and turned into `null`, not an error.
 */
export async function computeQueryVector(rawQuery: string, deps: CollectionDeps): Promise<readonly number[] | null> {
	if (deps.embed === undefined) return null;
	const vector = await deps.embed.embed(rawQuery);
	if (vector === null || vector.length !== EMBEDDING_DIMS) return null;
	try {
		assertEmbeddingDim(vector); // final guard: a non-finite entry is a dim-class error.
	} catch {
		deps.logger?.event("recall.query_vector_rejected", { actual: vector.length });
		return null;
	}
	return vector;
}

/**
 * Collect candidate memory IDs across the FTS, vector, and hint channels and merge
 * them by id (007a / a-AC-1..7). Returns a {@link MergedPool} — IDs only, per-channel
 * scores + provenance, plus the `degraded` flag (true when the vector channel was
 * skipped → lexical-only, the silent BM25 fallback signal).
 *
 * Order:
 *   1. Prepare the lexical term (FR-1) + preserve the NL query for the vector path
 *      (a-AC-6 / FR-2).
 *   2. FTS channel — always runs (a-AC-1). The lexical floor.
 *   3. Vector channel — only with a usable 768-dim query vector; over-fetch 3x
 *      (a-AC-2). Embed off/fail → skipped, `degraded = true` (a-AC-3).
 *   4. Hints channel — capped at `config.hintCap` (a-AC-4).
 *   5. Merge by id, strongest-wins, provenance attached (a-AC-5 / a-AC-7).
 */
export async function collectCandidates(query: RecallQuery, deps: CollectionDeps): Promise<MergedPool> {
	const { config } = deps;
	const agentId = query.scope.agentId;
	const scopeFilter = collectionScopeFilter(agentId);
	const channelInputs: { channel: RecallChannel; ids: ScoredId[] }[] = [];

	// PRD-049b (49b-AC-2): the project-segment conjunct, ANDed into BOTH collection channels
	// (FTS + vector) beside the agent_id scope (49b-AC-4). A blank `projectId` is the unbound
	// inbox session (D8 / 49b-AC-3): the conjunct narrows to inbox + workspace-global only.
	const projectClause = buildProjectScopeConjunct({
		projectId: query.scope.projectId ?? "",
		...(query.scope.projectBound !== undefined ? { bound: query.scope.projectBound } : {}),
	});

	// 1. Prepare the lexical term (FR-1); the NL query is preserved verbatim for vector.
	const term = prepareLexicalTerm(query.query, config.keywordExpansion);

	// 2. FTS channel — always runs (a-AC-1 / the lexical floor).
	const ftsResult = await deps.storage.query(
		buildFtsSql({ term, agentId, limit: config.channelLimit, projectClause }),
		{ org: deps.scope.org, workspace: deps.scope.workspace },
	);
	channelInputs.push({ channel: "fts", ids: toScoredIds(ftsResult) });

	// 3. Vector channel — gated by the user-selected recall mode (PRD-044c), then by a usable
	//    768-dim vector (a-AC-2 / a-AC-3). The mode RESOLVES which arms run:
	//      · `keyword`              → the vector arm is SKIPPED even when embeddings are on, and
	//                                 `degraded` stays FALSE — this is an intentional lexical run,
	//                                 NOT a fallback, so the PRD-029 "lexical fallback" badge must
	//                                 not show (AC-3 fallback-vs-mode coherence).
	//      · `semantic` / `hybrid`  → the vector arm RUNS when a usable query vector exists; when it
	//                                 does not (embeddings off/unreachable/wrong-dim), recall falls
	//                                 back to lexical and sets `degraded: true` EXACTLY as today.
	//      · UNDEFINED (default)    → byte-for-byte today's PRD-025 behavior (run the vector arm
	//                                 whenever a vector exists; degrade otherwise) — behavior-neutral.
	let degraded = false;
	if (deps.recallMode === "keyword") {
		// Intentional lexical-only run (NOT a degraded fallback). The vector arm is never built —
		// no embed call, no `<#>` statement — and `degraded` stays false (AC-3).
		deps.logger?.event("recall.collect_keyword_only", { mode: "keyword" });
	} else {
		const queryVector = await computeQueryVector(query.query, deps);
		if (queryVector === null) {
			// Silent BM25/ILIKE fallback: a `semantic`/`hybrid`/default run wanted the vector arm
			// but had no usable query vector → lexical-only, `degraded: true` (PRD-025 D-4 / PRD-029).
			degraded = true;
			deps.logger?.event("recall.collect_degraded", { reason: "no_query_vector" });
		} else {
			const vectorResult = await deps.storage.query(
				buildVectorSearchSql({
					table: MEMORIES_TABLE,
					idColumn: ID_COLUMN,
					embeddingColumn: EMBEDDING_COLUMN,
					queryVector,
					scope: scopeFilter,
					limit: config.channelLimit,
					overFetchMultiplier: config.overFetchMultiplier, // D-1: 3x (a-AC-2).
					// PRD-049b (49b-AC-2): the project segment rides the `<#>` match in the SAME
					// statement, so a strong cross-project cosine hit is filtered before its id leaves.
					...(projectClause !== "" ? { extraClause: projectClause } : {}),
				}),
				{ org: deps.scope.org, workspace: deps.scope.workspace },
			);
			channelInputs.push({ channel: "vector", ids: toScoredIds(vectorResult) });
		}
	}

	// 4. Hints channel — capped so a memory can't ride in on hints alone (a-AC-4).
	const hintSource = deps.hints ?? emptyHintSource;
	const hintMatches = await hintSource.match(query);
	const cappedHints = hintMatches.slice(0, Math.max(0, config.hintCap));
	if (cappedHints.length > 0) {
		channelInputs.push({ channel: "hint", ids: [...cappedHints] });
	}

	// 5. Merge by memory id — strongest calibrated score wins, provenance attached.
	return mergeChannels(channelInputs, degraded);
}
