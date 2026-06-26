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
 * A relevance-CLASS map for nDCG: `id -> classKey`. Ids that are duplicate copies of the
 * SAME distinct fact share a class key, so DCG credits the class ONCE (at its best-ranked
 * member) and never sums the clones. Ids absent from the map are their own singleton class
 * (the binary/common case). The map's domain is the relevant ids; non-relevant ids never
 * reach the class lookup. See {@link dcgAtK} / {@link idealDcgAtK} and `src/eval/golden.ts`.
 */
export type RelevanceClasses = Readonly<Record<string, string>>;

/** The class key for `id`: its mapped class, or the id itself (a singleton class). */
function classKeyOf(classes: RelevanceClasses | undefined, id: string): string {
	return classes?.[id] ?? id;
}

/**
 * Discounted cumulative gain at `k` for ONE query: `Σ gain_i / log2(rank_i + 1)` over
 * the top-k ranked ids, using the graded gain from `judgements` (0 for non-relevant
 * ids). Linear-gain DCG (not `2^gain − 1`) — adequate for the small graded scales the
 * golden set uses and simplest to hand-verify in the unit tests.
 *
 * When `classes` is supplied, each relevance CLASS contributes AT MOST ONCE — at its
 * best (first-seen, i.e. highest) rank in the result. Later clones of the same distinct
 * fact add 0. This is what makes nDCG DEDUP-INVARIANT: an engine scores the same whether
 * it returns one copy of a fact or many. Without `classes` every relevant id contributes
 * (the legacy binary behavior, preserved for callers that pass no class map).
 */
export function dcgAtK(
	result: RankedResult,
	judgements: RelevanceJudgements,
	k: number,
	classes?: RelevanceClasses,
): number {
	const topK = Math.max(1, Math.trunc(k));
	const limit = Math.min(topK, result.ids.length);
	const creditedClasses = new Set<string>();
	let dcg = 0;
	for (let i = 0; i < limit; i++) {
		const id = result.ids[i];
		if (id === undefined) continue;
		const gain = judgements[id];
		if (typeof gain === "number" && gain > 0) {
			// Count each relevance class once, at its best (first-encountered) rank.
			const cls = classKeyOf(classes, id);
			if (creditedClasses.has(cls)) continue;
			creditedClasses.add(cls);
			dcg += gain * dcgDiscount(i + 1); // i+1 = 1-based rank.
		}
	}
	return dcg;
}

/**
 * The IDEAL DCG at `k`: the DCG of the best POSSIBLE ordering — every relevant CLASS
 * placed at the top ranks, sorted by descending gain. The normalizer for nDCG.
 *
 * When `classes` is supplied, the ideal ranks DISTINCT classes (one gain per class, the
 * max gain among the class's members), NOT every duplicate id — so the normalizer reflects
 * the count of distinct facts, not the count of clones in the workspace. A single-fact
 * query therefore has IDCG = that fact's grade at rank 1, and per-query nDCG reduces to
 * `1/log2(bestRank+1)` — dedup-invariant. Without `classes` the legacy per-id ideal is used.
 */
export function idealDcgAtK(judgements: RelevanceJudgements, k: number, classes?: RelevanceClasses): number {
	// Collapse the relevant ids to one gain per distinct class (the class's MAX gain).
	const gainByClass = new Map<string, number>();
	for (const [id, g] of Object.entries(judgements)) {
		if (typeof g !== "number" || g <= 0) continue;
		const cls = classKeyOf(classes, id);
		const prev = gainByClass.get(cls);
		if (prev === undefined || g > prev) gainByClass.set(cls, g);
	}
	const gains = [...gainByClass.values()].sort((a, b) => b - a); // best gains first.
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
 *
 * When `classes` is supplied, nDCG is DEDUP-INVARIANT: duplicate copies of the same
 * distinct fact (a relevance class) are credited once (best rank) in both DCG and the
 * IDCG normalizer, so an engine that collapses clones scores identically to one that
 * stuffs them. For a single-fact class this is exactly `1/log2(bestRank+1)`.
 */
export function ndcgAtK(
	result: RankedResult,
	judgements: RelevanceJudgements,
	k: number,
	classes?: RelevanceClasses,
): number {
	const idcg = idealDcgAtK(judgements, k, classes);
	if (idcg === 0) return 0;
	return dcgAtK(result, judgements, k, classes) / idcg;
}

// ── PRD-058a, the freshness-sensitivity slice (recency ordering) ─────────────

/**
 * One freshness-sensitivity case (PRD-058a Test Plan / AC-55a.1.1): a FRESH id and a STALE id that are
 * EQUALLY relevant to the same query (same fact, different age). The recency activation must rank the
 * fresher member ABOVE the staler one, the eval-gated proof that the `A(m,t)` term reshapes order by
 * age at equal relevance. The eval reduces the engine output to a ranked id list and scores these pairs
 * with {@link freshRanksFirst}; the numeric LIVE run injects the real recall (and SKIPs without creds),
 * while the slice CODE + its unit coverage ship now.
 */
export interface FreshnessCase {
	/** A stable id for the case (used in the per-case report line). */
	readonly caseId: string;
	/** The id of the FRESHER row (smaller `t − t_ref`), must rank first. */
	readonly freshId: string;
	/** The id of the STALER row (larger `t − t_ref`), must rank below `freshId`. */
	readonly staleId: string;
}

/**
 * Score ONE freshness case against a ranked result (PRD-058a / AC-55a.1.1): `true` iff the FRESH id
 * appears in `result` and ranks strictly ABOVE the STALE id. A case where the fresh id is absent, or
 * ranks below/equal-to the stale id, is a FAIL (the recency term did not demote the staler row). A
 * stale id absent from the result while the fresh id is present is a PASS (the fresher row surfaced
 * and the staler did not outrank it). Pure: a deterministic transform of the ranked ids.
 */
export function freshRanksFirst(result: RankedResult, freshCase: FreshnessCase): boolean {
	const freshRank = indexOfId(result, freshCase.freshId);
	if (freshRank === null) return false; // the fresher row must surface to be scored a pass.
	const staleRank = indexOfId(result, freshCase.staleId);
	if (staleRank === null) return true; // fresh present, stale absent → fresh is not outranked.
	return freshRank < staleRank; // 0-based positions: a smaller index ranks higher.
}

/** The 0-based position of `id` in the ranked result, or `null` when it does not appear. */
function indexOfId(result: RankedResult, id: string): number | null {
	const i = result.ids.indexOf(id);
	return i === -1 ? null : i;
}

/**
 * Aggregate a freshness slice (PRD-058a): the fraction of cases where the fresher member ranked first.
 * `1` = every case passed (the slice gate); `0` on an empty slice (nothing to measure, never NaN). The
 * caller maps each case's query through the engine to a {@link RankedResult} and pairs it here.
 */
export function freshnessSliceScore(cases: readonly { result: RankedResult; freshCase: FreshnessCase }[]): number {
	if (cases.length === 0) return 0;
	const passes = cases.reduce((n, c) => n + (freshRanksFirst(c.result, c.freshCase) ? 1 : 0), 0);
	return passes / cases.length;
}

// ── PRD-058c, the staleness precision/recall/F1 slice (the `σ` detection gate) ─

/**
 * One staleness-detection case (PRD-058c Test Plan / scoring-model metrics table): a memory's GROUND-TRUTH
 * label (`labeledStale` — does it genuinely name a dangling reference?) paired with the diagnostic's
 * PREDICTION (`predictedStale` — did `σ` cross the stale threshold?). The slice answers "do we flag the
 * dead references and ONLY those?" — the staleness analogue of the freshness ordering gate. The unit suite
 * drives deterministic fakes; the LIVE numeric run labels a dangling-ref set, runs the real diagnostic,
 * and SKIPs without creds, while the slice CODE + its coverage ship now.
 */
export interface StalenessCase {
	/** A stable id for the case (used in the per-case report line). */
	readonly caseId: string;
	/** Ground truth: `true` iff the memory genuinely names a reference that no longer resolves. */
	readonly labeledStale: boolean;
	/** The diagnostic's verdict: `true` iff `σ` crossed the stale threshold (`ref_status === 'stale'`). */
	readonly predictedStale: boolean;
}

/** The precision/recall/F1 of a staleness slice over the labeled set (the committed, auditable numbers). */
export interface StalenessMetrics {
	/** The number of cases scored. */
	readonly count: number;
	/** True positives: labeled stale AND predicted stale. */
	readonly truePositives: number;
	/** False positives: NOT labeled stale BUT predicted stale (the failure mode we forbid most). */
	readonly falsePositives: number;
	/** False negatives: labeled stale BUT NOT predicted stale (a dangling ref we missed). */
	readonly falseNegatives: number;
	/** `tp / (tp + fp)` — of the memories we flagged, how many were genuinely stale. `1` when no flags. */
	readonly precision: number;
	/** `tp / (tp + fn)` — of the genuinely stale memories, how many we flagged. `1` when none labeled. */
	readonly recall: number;
	/** The harmonic mean `2·p·r / (p + r)` — `0` when both precision and recall are `0`. */
	readonly f1: number;
}

/**
 * Compute the staleness precision/recall/F1 over a labeled set (PRD-058c). RULES (no NaN, ever):
 *  - precision `tp/(tp+fp)` → `1` when we flagged nothing (`tp+fp === 0`): a no-flag run is vacuously
 *    precise (it raised no false alarm), which is the conservative-default-honoring reading.
 *  - recall `tp/(tp+fn)` → `1` when nothing was labeled stale (`tp+fn === 0`): there was nothing to miss.
 *  - F1 `2pr/(p+r)` → `0` when `p+r === 0`.
 * Pure: a deterministic transform of the labeled/predicted booleans.
 */
export function stalenessMetrics(cases: readonly StalenessCase[]): StalenessMetrics {
	let tp = 0;
	let fp = 0;
	let fn = 0;
	for (const c of cases) {
		if (c.labeledStale && c.predictedStale) tp++;
		else if (!c.labeledStale && c.predictedStale) fp++;
		else if (c.labeledStale && !c.predictedStale) fn++;
	}
	const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
	const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
	const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
	return { count: cases.length, truePositives: tp, falsePositives: fp, falseNegatives: fn, precision, recall, f1 };
}

// ── PRD-058b, the conflict slice (CRA + contradiction-detection PR/F1) ────────

/**
 * One contradiction-detection case (PRD-058b Test Plan / scoring-model metrics table): a memory PAIR's
 * GROUND-TRUTH label (`labeledConflict` — do the two genuinely assert contradictory outcomes?) paired with
 * the detector's PREDICTION (`predictedConflict` — did `Contra` cross `θ_detect`?). The slice answers "do
 * we detect the right contradiction pairs and ONLY those?" — the conflict analogue of the staleness
 * detection gate. The unit suite drives deterministic fakes; the LIVE numeric run labels a contradiction
 * set, runs the real detector, and SKIPs without creds, while the slice CODE + its coverage ship now.
 */
export interface ContradictionCase {
	/** A stable id for the case (the per-case report key). */
	readonly caseId: string;
	/** Ground truth: `true` iff the pair genuinely asserts contradictory outcomes about the same claim. */
	readonly labeledConflict: boolean;
	/** The detector's verdict: `true` iff `Contra(a,b) > θ_detect`. */
	readonly predictedConflict: boolean;
}

/**
 * Compute the contradiction-detection precision/recall/F1 over a labeled PAIR set (PRD-058b). Identical
 * math to {@link stalenessMetrics} (no NaN, ever): precision/recall vacuously `1` when nothing was
 * flagged/labeled, F1 `0` when `p+r === 0`. Reuses {@link stalenessMetrics} by projecting the
 * contradiction labels onto its `{labeledStale, predictedStale}` shape so there is ONE precision/recall/F1
 * implementation — a contradiction false positive (flagging an independent fact) is the failure mode the
 * `κ`-is-the-only-zeroing-term posture forbids most, so its precision must be auditable, not asserted-away.
 */
export function contradictionMetrics(cases: readonly ContradictionCase[]): StalenessMetrics {
	return stalenessMetrics(
		cases.map((c) => ({ caseId: c.caseId, labeledStale: c.labeledConflict, predictedStale: c.predictedConflict })),
	);
}

/**
 * One Conflict-Resolution-Accuracy (CRA) case (PRD-058b Test Plan): a labeled conflict's GROUND-TRUTH
 * winner id paired with the WINNER the resolution policy actually picked. CRA answers "do we pick the
 * right winner?" — the headline conflict-resolution metric. The unit suite drives deterministic resolutions;
 * the LIVE numeric run resolves a labeled conflict set and SKIPs without creds.
 */
export interface ConflictResolutionCase {
	/** A stable id for the case (the per-case report key). */
	readonly caseId: string;
	/** Ground truth: the memory id that SHOULD win the conflict. */
	readonly expectedWinnerId: string;
	/** The winner the policy picked (the resolver's `winnerId`). */
	readonly predictedWinnerId: string;
}

/** Conflict Resolution Accuracy: the fraction of labeled conflicts whose winner the policy picked correctly. */
export interface ConflictResolutionMetrics {
	/** The number of conflicts scored. */
	readonly count: number;
	/** The number whose predicted winner matched the labeled winner. */
	readonly correct: number;
	/** `correct / count` — the headline CRA. `1` on an empty set (nothing to get wrong, never NaN). */
	readonly accuracy: number;
}

/**
 * Compute Conflict Resolution Accuracy (CRA) over a labeled conflict set (PRD-058b): the fraction whose
 * predicted winner matched the labeled winner. An empty set is vacuously `1` (nothing to mis-resolve, never
 * NaN) — the caller treats `count: 0` as "nothing measured", not a passing gate. Pure: a deterministic
 * transform of the labeled/predicted winner ids (exact string equality).
 */
export function conflictResolutionAccuracy(cases: readonly ConflictResolutionCase[]): ConflictResolutionMetrics {
	let correct = 0;
	for (const c of cases) if (c.expectedWinnerId === c.predictedWinnerId) correct++;
	const accuracy = cases.length === 0 ? 1 : correct / cases.length;
	return { count: cases.length, correct, accuracy };
}

// ── The headline metric: useful-context@k (PRD-058 scoring-doc IDX) ──────────

/**
 * One useful-context@k case (the scoring-doc HEADLINE metric): a query whose top-k must contain a memory
 * that is simultaneously CORRECT, CURRENT, and NON-CONFLICTING. The four per-term slices
 * (freshness / staleness / contradiction / CRA) each measure ONE failure mode in isolation; this case
 * composes them into the end-to-end product question the scoring doc poses — "did the top-k surface a
 * memory the agent can actually trust?".
 *
 * A surfaced id "counts" as useful-context for the query iff it is BOTH:
 *   - RELEVANT — a member of `correctIds` (the correct answer set for the query), AND
 *   - TRUSTWORTHY — NOT in `excludedIds`, the set of ids that should NOT count even when surfaced: the
 *     STALE copies (058c — superseded / dangling-ref), and the CONFLICT LOSERS (058b — the κ = ρ side an
 *     open conflict suppresses). A fresh, non-conflicting CORRECT id is the only thing that satisfies the
 *     metric; surfacing only a stale copy, or only the losing side of a contradiction, is a MISS even
 *     though a "relevant" id appeared.
 *
 * The caller builds `excludedIds` from the SAME ground truth the per-term slices use (the staler copy of a
 * freshness pair, the labeled-stale memory, the labeled conflict loser), so useful-context@k is the
 * conjunction the four slices decompose — measured, not asserted.
 */
export interface UsefulContextCase {
	/** A stable id for the case (the per-case report key). */
	readonly caseId: string;
	/** The ids that are CORRECT answers to the query (relevant). A top-k hit must be one of these. */
	readonly correctIds: readonly string[];
	/**
	 * The ids that must NOT count as useful even when surfaced: stale/superseded copies (058c) and open-
	 * conflict LOSERS (058b). A surfaced correct id in this set is "relevant but untrustworthy" → not useful.
	 */
	readonly excludedIds: readonly string[];
}

/**
 * useful-context@k for ONE query (the scoring-doc headline): `1` iff the top-k of `result` contains an id
 * that is a CORRECT answer AND is NOT excluded (not stale, not a conflict loser), else `0`. The
 * end-to-end conjunction of correctness + currentness + non-conflict the four per-term slices decompose.
 * `k` is clamped to `≥ 1`; a top-k longer than the result simply considers the whole list. Pure.
 */
export function usefulContextAtK(result: RankedResult, c: UsefulContextCase, k: number): number {
	const topK = Math.max(1, Math.trunc(k));
	const limit = Math.min(topK, result.ids.length);
	const correct = new Set(c.correctIds);
	const excluded = new Set(c.excludedIds);
	for (let i = 0; i < limit; i++) {
		const id = result.ids[i];
		if (id !== undefined && correct.has(id) && !excluded.has(id)) return 1; // correct AND trustworthy.
	}
	return 0;
}

/** The aggregate useful-context@k over a case set: the mean per-case score keyed by k, + the count. */
export interface UsefulContextMetrics {
	/** The number of cases scored (the denominator). */
	readonly count: number;
	/** useful-context@k keyed by k (e.g. `{ "1": 0.6, "5": 0.9 }`) — the mean over cases. */
	readonly usefulAtK: Readonly<Record<string, number>>;
}

/**
 * Aggregate useful-context@k over a case set at each `k` in {@link RECALL_K_VALUES} (PRD-058 headline).
 * Each k's number is the fraction of cases whose top-k surfaced a correct, non-excluded memory. An empty
 * set yields all-zero with `count: 0` (never NaN) — the caller treats that as "nothing measured", not a
 * passing gate. Pure: a deterministic transform of the ranked results + the case ground truth.
 */
export function aggregateUsefulContext(
	cases: readonly { result: RankedResult; useful: UsefulContextCase }[],
): UsefulContextMetrics {
	const usefulAtK: Record<string, number> = {};
	for (const k of RECALL_K_VALUES) usefulAtK[String(k)] = 0;
	const n = cases.length;
	if (n === 0) return { count: 0, usefulAtK };
	const sums: Record<string, number> = {};
	for (const k of RECALL_K_VALUES) sums[String(k)] = 0;
	for (const c of cases) {
		for (const k of RECALL_K_VALUES) sums[String(k)] += usefulContextAtK(c.result, c.useful, k);
	}
	for (const k of RECALL_K_VALUES) usefulAtK[String(k)] = sums[String(k)]! / n;
	return { count: n, usefulAtK };
}

/** One query paired with the engine's ranked result + its relevance judgements. */
export interface ScoredQuery {
	/** A stable id for the query (used in the per-query report). */
	readonly queryId: string;
	/** The engine-ordered result ids for this query. */
	readonly result: RankedResult;
	/** The relevance judgements (`id -> gain`) for this query. */
	readonly judgements: RelevanceJudgements;
	/**
	 * Optional `id -> classKey` map grouping duplicate copies of the same distinct fact into
	 * one relevance class, so nDCG credits the class once and is DEDUP-INVARIANT. Absent → each
	 * relevant id is its own class (legacy behavior). recall@k / MRR ignore this entirely; only
	 * nDCG consults it. See {@link ndcgAtK} and `src/eval/golden.ts`.
	 */
	readonly classes?: RelevanceClasses;
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
		// nDCG consults the relevance-class map (when present) so duplicate copies of one
		// distinct fact are credited once — the dedup-invariant nDCG. recall@k / MRR above
		// are class-agnostic and unchanged: a hit on ANY class member is the hit.
		ndcgSum += ndcgAtK(q.result, q.judgements, NDCG_K, q.classes);
	}

	for (const k of RECALL_K_VALUES) recall[String(k)] = recallSums[String(k)]! / n;
	return { queryCount: n, recallAtK: recall, mrr: mrrSum / n, ndcg: ndcgSum / n };
}
