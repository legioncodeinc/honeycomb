/**
 * Recall-quality metrics — PRD-027 D-6 / AC-5 (the measurement core).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * PURE FUNCTIONS over `(ranked result ids, expected id)`. No I/O, no clock, no
 * storage — every function here is a deterministic transform of a ranked id list
 * plus the id(s) the golden set says SHOULD have been surfaced. That purity is the
 * point: the metric math is unit-tested against HAND-COMPUTED expectations (no
 * "feels better" — PRD-027 risk note), and the harness (`src/eval/golden.ts`), the
 * `npm run eval:recall` script, and the gated live itest all reduce recall output
 * to a `RankedResult` and call the SAME functions here. One source of the math.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── The headline metrics (D-6) ───────────────────────────────────────────────
 *   - recall@k (k = 1, 5, 10): did the expected memory appear in the top-k? The
 *     product question — "did we surface the right memory at all" (PRD index).
 *   - MRR (mean reciprocal rank): 1/rank of the first relevant hit, averaged over
 *     the query set. Rewards surfacing the right memory HIGH, not just somewhere.
 *   - nDCG (normalized discounted cumulative gain): a position-discounted gain,
 *     graded when the golden set carries graded relevance, BINARY otherwise (D-6:
 *     "nDCG can use binary relevance if graded isn't available").
 *
 * ── Rank convention ──────────────────────────────────────────────────────────
 * Ranks are 1-BASED throughout (the top hit is rank 1). The ranked id list is the
 * engine's emitted order (recall hits are already ordered by fused RRF score DESC,
 * PRD-027 Wave 1) — these metrics never re-rank; they SCORE the order they are given.
 *
 * ── Identity matching (graded relevance) ─────────────────────────────────────
 * A query's relevance judgements are a map `id -> gain` (gain > 0 = relevant). The
 * binary case is the gain-1 special case. `recall@k` / `MRR` treat any gain > 0 as
 * "relevant"; `nDCG` uses the gain magnitude. A `RankedResult` is a ranked list of
 * ids; matching is exact-string id equality against the judgement map.
 */

/** A single query's ranked result: the engine-ordered ids (rank = index + 1). */
export interface RankedResult {
	/** The ranked ids the engine surfaced, best-first (rank 1 = index 0). */
	readonly ids: readonly string[];
}

/**
 * The relevance judgements for one query: `id -> graded gain`. A gain `> 0` means
 * relevant; the binary golden case is `gain === 1`. Ids absent from the map are
 * non-relevant (gain 0). nDCG uses the gain magnitude; recall@k / MRR treat any
 * positive gain as relevant.
 */
export type RelevanceJudgements = Readonly<Record<string, number>>;

/** Whether `id` is relevant under `judgements` (any strictly-positive gain). */
export function isRelevant(judgements: RelevanceJudgements, id: string): boolean {
	const gain = judgements[id];
	return typeof gain === "number" && gain > 0;
}

/**
 * recall@k for ONE query: `1` iff at least one relevant id appears in the top-k of
 * `result`, else `0`. (With a single expected id per query — the common golden case
 * — this is exactly "was the expected memory in the top-k".) `k` is clamped to `≥ 1`;
 * a top-k longer than the result list simply considers the whole list.
 */
export function recallAtK(result: RankedResult, judgements: RelevanceJudgements, k: number): number {
	const topK = Math.max(1, Math.trunc(k));
	const limit = Math.min(topK, result.ids.length);
	for (let i = 0; i < limit; i++) {
		const id = result.ids[i];
		if (id !== undefined && isRelevant(judgements, id)) return 1;
	}
	return 0;
}

/**
 * The 1-based rank of the FIRST relevant id in `result`, or `null` if no relevant id
 * appears anywhere in the list. The building block for MRR (`1/rank`) and a useful
 * per-query diagnostic ("the expected memory surfaced at rank N").
 */
export function firstRelevantRank(result: RankedResult, judgements: RelevanceJudgements): number | null {
	for (let i = 0; i < result.ids.length; i++) {
		const id = result.ids[i];
		if (id !== undefined && isRelevant(judgements, id)) return i + 1; // 1-based.
	}
	return null;
}

/**
 * The reciprocal rank for ONE query: `1 / rank` of the first relevant hit, or `0`
 * when the query has no relevant hit in the list. MRR is the mean of this over the
 * query set (see {@link aggregateMetrics}).
 */
export function reciprocalRank(result: RankedResult, judgements: RelevanceJudgements): number {
	const rank = firstRelevantRank(result, judgements);
	return rank === null ? 0 : 1 / rank;
}

/**
 * The position discount for DCG: `1 / log2(rank + 1)` (the standard log-2 discount;
 * rank 1 → `1/log2(2) = 1`, rank 2 → `1/log2(3) ≈ 0.6309`, …). 1-based rank in.
 */
function dcgDiscount(rank: number): number {
	return 1 / Math.log2(rank + 1);
}

/**
 * Discounted cumulative gain at `k` for ONE query: `Σ gain_i / log2(rank_i + 1)` over
 * the top-k ranked ids, using the graded gain from `judgements` (0 for non-relevant
 * ids). Linear-gain DCG (not `2^gain − 1`) — adequate for the small graded scales the
 * golden set uses and simplest to hand-verify in the unit tests.
 */
export function dcgAtK(result: RankedResult, judgements: RelevanceJudgements, k: number): number {
	const topK = Math.max(1, Math.trunc(k));
	const limit = Math.min(topK, result.ids.length);
	let dcg = 0;
	for (let i = 0; i < limit; i++) {
		const id = result.ids[i];
		if (id === undefined) continue;
		const gain = judgements[id];
		if (typeof gain === "number" && gain > 0) {
			dcg += gain * dcgDiscount(i + 1); // i+1 = 1-based rank.
		}
	}
	return dcg;
}

/**
 * The IDEAL DCG at `k`: the DCG of the best POSSIBLE ordering — every relevant id
 * sorted by descending gain, placed at the top ranks. The normalizer for nDCG.
 */
export function idealDcgAtK(judgements: RelevanceJudgements, k: number): number {
	const gains = Object.values(judgements)
		.filter((g) => typeof g === "number" && g > 0)
		.sort((a, b) => b - a); // best gains first.
	const topK = Math.max(1, Math.trunc(k));
	const limit = Math.min(topK, gains.length);
	let idcg = 0;
	for (let i = 0; i < limit; i++) {
		const gain = gains[i];
		if (gain !== undefined) idcg += gain * dcgDiscount(i + 1);
	}
	return idcg;
}

/**
 * nDCG@k for ONE query: `DCG@k / IDCG@k`, in `[0, 1]`. Returns `0` when the query has
 * no relevant ids (IDCG 0 → no signal to normalize against; a no-judgement query
 * contributes 0, never NaN). With binary judgements (all gains 1) this is the binary
 * nDCG D-6 allows when graded relevance is absent.
 */
export function ndcgAtK(result: RankedResult, judgements: RelevanceJudgements, k: number): number {
	const idcg = idealDcgAtK(judgements, k);
	if (idcg === 0) return 0;
	return dcgAtK(result, judgements, k) / idcg;
}

/** One query paired with the engine's ranked result + its relevance judgements. */
export interface ScoredQuery {
	/** A stable id for the query (used in the per-query report). */
	readonly queryId: string;
	/** The engine-ordered result ids for this query. */
	readonly result: RankedResult;
	/** The relevance judgements (`id -> gain`) for this query. */
	readonly judgements: RelevanceJudgements;
}

/** The `k` values the headline recall@k is computed at (D-6: k = 1, 5, 10). */
export const RECALL_K_VALUES: readonly number[] = [1, 5, 10];

/** The `k` nDCG is reported at (top-10, matching the deepest recall@k). */
export const NDCG_K = 10;

/** The aggregate recall-quality metrics over a query set (the eval headline numbers). */
export interface AggregateMetrics {
	/** The number of scored queries (the denominator for every mean). */
	readonly queryCount: number;
	/** recall@k keyed by k (e.g. `{ "1": 0.4, "5": 0.8, "10": 0.9 }`) — the mean over queries. */
	readonly recallAtK: Readonly<Record<string, number>>;
	/** Mean reciprocal rank over the query set. */
	readonly mrr: number;
	/** Mean nDCG@{@link NDCG_K} over the query set. */
	readonly ndcg: number;
}

/**
 * Reduce a query set to the aggregate {@link AggregateMetrics}: recall@{1,5,10}, MRR,
 * and nDCG@10, each the MEAN over the scored queries. An empty set yields all-zero
 * metrics with `queryCount: 0` (never NaN) — the caller treats that as "nothing to
 * measure", not a passing eval.
 */
export function aggregateMetrics(queries: readonly ScoredQuery[]): AggregateMetrics {
	const n = queries.length;
	const recall: Record<string, number> = {};
	for (const k of RECALL_K_VALUES) recall[String(k)] = 0;

	if (n === 0) {
		return { queryCount: 0, recallAtK: recall, mrr: 0, ndcg: 0 };
	}

	let mrrSum = 0;
	let ndcgSum = 0;
	const recallSums: Record<string, number> = {};
	for (const k of RECALL_K_VALUES) recallSums[String(k)] = 0;

	for (const q of queries) {
		for (const k of RECALL_K_VALUES) {
			recallSums[String(k)] += recallAtK(q.result, q.judgements, k);
		}
		mrrSum += reciprocalRank(q.result, q.judgements);
		ndcgSum += ndcgAtK(q.result, q.judgements, NDCG_K);
	}

	for (const k of RECALL_K_VALUES) recall[String(k)] = recallSums[String(k)]! / n;
	return { queryCount: n, recallAtK: recall, mrr: mrrSum / n, ndcg: ndcgSum / n };
}
