/**
 * The recall-eval harness — PRD-027 D-5/D-6 / AC-5/AC-6 (the orchestration layer).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * This module turns the committed golden set (`eval/recall-golden.json`) + the
 * pure metrics (`./metrics.ts`) into a runnable evaluation, WITHOUT owning any
 * I/O of its own. The recall engine is injected as a `SeededRecall` function, so:
 *   - the unit tests drive a deterministic fake recall and hand-check the report;
 *   - the gated live itest + `npm run eval:recall` inject the REAL `recallMemories`
 *     against live DeepLake (seeded + poll-convergent).
 * One harness, one metric source, two callers. The harness never embeds, never
 * stores, never reads storage — the CALLER seeds + polls; the harness scores.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── The golden pair → seeded memory → query → score flow ─────────────────────
 *   1. {@link loadGoldenSet} reads + zod-validates the committed pairs.
 *   2. The caller seeds each pair's `memoryText` as a memory under a per-run key
 *      ({@link uniqueKeyFor}) so a live run reads ONLY its own rows.
 *   3. {@link runEval} calls the injected recall for each query, maps the ranked
 *      hits to ids, and scores them against the seeded id via the metrics module.
 *   4. {@link gateAgainstBaseline} compares the aggregate recall@5 / MRR to the
 *      committed baseline and FAILS when either drops below `baseline − EPSILON`.
 *
 * ── The baseline gate (AC-6) ─────────────────────────────────────────────────
 * The eval is also a regression GATE: a committed `recall@5` / `MRR` baseline
 * (`eval/recall-baseline.json`) is the floor. {@link EPSILON} is the small named
 * tolerance that absorbs run-to-run noise (eventual consistency, embed jitter) so
 * the gate fails only on a REAL regression, not a flake. Wave 3 fills the measured
 * baseline numbers; until then the baseline is a marked placeholder (see the JSON).
 */

import { z } from "zod";

import {
	type CalibrationModel,
	type CalibrationSample,
	IDENTITY_MODEL,
	brierScore,
	expectedCalibrationError,
} from "../daemon/runtime/memories/calibration.js";
import {
	aggregateMetrics,
	aggregateUsefulContext,
	conflictResolutionAccuracy,
	contradictionMetrics,
	firstRelevantRank,
	freshRanksFirst,
	freshnessSliceScore,
	stalenessMetrics,
	usefulContextAtK,
	type AggregateMetrics,
	type ConflictResolutionCase,
	type ConflictResolutionMetrics,
	type ContradictionCase,
	type FreshnessCase,
	type RankedResult,
	type RelevanceClasses,
	type RelevanceJudgements,
	type ScoredQuery,
	type StalenessCase,
	type StalenessMetrics,
	type UsefulContextCase,
	type UsefulContextMetrics,
} from "./metrics.js";

/**
 * One golden pair: a query and the memory it SHOULD recall. `lexicalMiss` flags the
 * pairs whose query shares no surface token with `memoryText` (only the `<#>` semantic
 * arm bridges them — the PRD-025 lift exercisers). `relevance` is the graded gain for
 * nDCG (default 1 = binary). See `eval/recall-golden.json` + `eval/README.md`.
 */
export interface GoldenPair {
	/** A stable slug; the harness uniquifies it per run ({@link uniqueKeyFor}). */
	readonly key: string;
	/** The memory text to seed/store before the query runs. */
	readonly memoryText: string;
	/** The natural-language query run through recall. */
	readonly query: string;
	/** `true` iff the query shares no surface token with `memoryText` (semantic-only). */
	readonly lexicalMiss: boolean;
	/** The graded relevance gain for nDCG; defaults to 1 (binary). */
	readonly relevance: number;
}

/** The committed golden set: the validated pairs. */
export interface GoldenSet {
	/** The `(query → expected memory)` pairs. */
	readonly pairs: readonly GoldenPair[];
}

/**
 * The zod shape of ONE pair in the committed JSON. `relevance` defaults to 1 (binary)
 * when absent. Keys beginning `//` in the JSON are documentation comments, ignored here.
 */
const GoldenPairSchema = z.object({
	key: z.string().min(1),
	memoryText: z.string().min(1),
	query: z.string().min(1),
	lexicalMiss: z.boolean(),
	relevance: z.number().positive().optional().default(1),
});

/** The zod shape of the committed golden-set JSON (only `pairs` is load-bearing). */
const GoldenFileSchema = z.object({
	pairs: z.array(GoldenPairSchema).min(1),
});

/**
 * Validate a parsed golden-set JSON object into a {@link GoldenSet}. Throws a zod
 * error on a malformed set (a missing field, an empty `pairs`) — a broken golden set
 * is a hard failure, never a silently-empty eval. The `key` uniqueness invariant is
 * checked here too (duplicate keys would collide on seed).
 */
export function parseGoldenSet(raw: unknown): GoldenSet {
	const parsed = GoldenFileSchema.parse(raw);
	const seen = new Set<string>();
	for (const pair of parsed.pairs) {
		if (seen.has(pair.key)) {
			throw new Error(`recall-golden: duplicate pair key "${pair.key}" (keys must be unique)`);
		}
		seen.add(pair.key);
	}
	return { pairs: parsed.pairs };
}

/**
 * Load + validate the golden set from a JSON string (the file contents). Kept as a
 * string-in function (not a file read) so it is pure + unit-testable; the script /
 * itest read the file and pass the contents. Throws on malformed JSON or a bad shape.
 */
export function loadGoldenSet(jsonText: string): GoldenSet {
	let raw: unknown;
	try {
		raw = JSON.parse(jsonText);
	} catch (err) {
		throw new Error(`recall-golden: not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
	}
	return parseGoldenSet(raw);
}

/**
 * The per-run-unique seed key for a golden pair: `key-runId`. A live seed lands rows
 * keyed by this so the eval reads ONLY this run's rows (never real data, never another
 * run's) — the isolation rule the live itests use. `runId` must be `[A-Za-z0-9_-]`.
 */
export function uniqueKeyFor(pairKey: string, runId: string): string {
	return `${pairKey}-${runId}`;
}

/**
 * The seed text for a golden pair under a run: `memoryText` with the run id appended so
 * the stored memory is unique to this run AND so a lexical-miss pair's seeded text never
 * accidentally shares the run-id token with the query (the query carries no run id). The
 * expected id the harness scores against is whatever the seeding store returns for THIS text.
 */
export function seedTextFor(pair: GoldenPair, runId: string): string {
	return `${pair.memoryText} [${runId}]`;
}

/**
 * The injected recall seam: run the engine for a query and return the ranked hit ids,
 * best-first (rank 1 = index 0). The harness is engine-agnostic — the unit tests inject
 * a deterministic fake; the live caller injects `recallMemories` mapped to `hit.id`s.
 */
export type SeededRecall = (query: string) => Promise<readonly string[]>;

/**
 * The mapping from a seeded pair to the id(s) recall is expected to surface. The caller
 * builds this after seeding: `pair.key → the storage id the seed landed`. (For the
 * `memories` arm the id is the row id; the harness only needs id equality.)
 *
 * A value MAY be a single id (the common case) OR a SET of ids that are all CORRECT
 * answers to the query — the query's relevance CLASS. The live eval uses the set form to
 * absorb a shared append-only workspace where prior runs left near-duplicate copies of the
 * same golden memory: every such copy is an equally-correct answer, so a hit on ANY of them
 * is a hit. Scoring against the whole class (not one arbitrary copy) is what makes the
 * measurement STABLE — the target cluster reliably surfaces even though which individual
 * copy `<#>` ranks first shuffles run-to-run (PRD-027 Wave-3 stability fix). recall@k / MRR
 * treat a hit on any class member as the hit; the report's `expectedId` shows the primary
 * (this-run) id for traceability.
 */
export type ExpectedIds = ReadonlyMap<string, string | readonly string[]>;

/** One query's per-query eval line (the report row). */
export interface QueryReport {
	/** The golden pair key (un-uniquified — the stable slug). */
	readonly key: string;
	/** The query text. */
	readonly query: string;
	/** Whether this pair is a lexical-miss (semantic-only) pair. */
	readonly lexicalMiss: boolean;
	/** The expected id (the seeded memory's id), or `null` when seeding produced none. */
	readonly expectedId: string | null;
	/** The 1-based rank the expected id surfaced at, or `null` for a miss. */
	readonly rank: number | null;
	/** `true` iff the expected id surfaced anywhere in the ranked result (a hit). */
	readonly hit: boolean;
}

/** The full eval result: the per-query report + the aggregate metrics. */
export interface EvalReport {
	/** One line per golden query. */
	readonly queries: readonly QueryReport[];
	/** The aggregate recall@k / MRR / nDCG over the query set. */
	readonly metrics: AggregateMetrics;
}

/**
 * Run the eval: for each golden pair, run the injected recall, find where (if anywhere)
 * the expected seeded id surfaced, and reduce to per-query + aggregate metrics. The
 * caller has already seeded + (for a live run) polled to convergence; this is the pure
 * score step. A pair whose seed produced no id (`expectedIds` miss) is reported as a
 * miss with `expectedId: null` (it still counts as a scored query — a seed that failed
 * to land is a recall failure for measurement purposes, never silently dropped).
 */
export async function runEval(
	golden: GoldenSet,
	recall: SeededRecall,
	expectedIds: ExpectedIds,
): Promise<EvalReport> {
	const queries: QueryReport[] = [];
	const scored: ScoredQuery[] = [];

	for (const pair of golden.pairs) {
		// The expected relevance CLASS: one id, or a set of equally-correct ids (duplicate
		// copies of the same golden memory in a shared workspace). Normalize to an id array.
		const expected = expectedIds.get(pair.key);
		const expectedSet: readonly string[] =
			expected === undefined ? [] : typeof expected === "string" ? [expected] : expected;
		const ids = await recall(pair.query);
		const result: RankedResult = { ids };
		// Judgements: EVERY id in the class carries the pair's graded relevance, so a hit on ANY
		// correct copy is a hit (the stability property — see {@link ExpectedIds}). An empty
		// class (seed produced no id) → empty judgements → every metric scores this as a miss.
		// recall@5 / MRR consume ONLY these judgements (class-agnostic) and so are unchanged.
		const judgements: RelevanceJudgements = Object.fromEntries(
			expectedSet.map((id) => [id, pair.relevance] as const),
		);
		// The relevance CLASS: every member id of this pair maps to ONE class key (the pair key),
		// because the members are duplicate COPIES of the same distinct fact. This is what makes
		// nDCG DEDUP-INVARIANT — DCG and IDCG credit the fact once (best rank), so an engine that
		// collapses the clones scores identically to one that returns them all (PRD-047c c-AC-3:
		// the old relevance-class workaround over-rewarded clone-stuffing; this retires it). The
		// per-query nDCG reduces to 1/log2(bestRank+1), or 0 on a distinct miss.
		const classes: RelevanceClasses = Object.fromEntries(
			expectedSet.map((id) => [id, pair.key] as const),
		);
		const rank = firstRelevantRank(result, judgements);

		queries.push({
			key: pair.key,
			query: pair.query,
			lexicalMiss: pair.lexicalMiss,
			// The report shows the PRIMARY (this-run) id for traceability; scoring used the class.
			expectedId: expectedSet[0] ?? null,
			rank,
			hit: rank !== null,
		});
		scored.push({ queryId: pair.key, result, judgements, classes });
	}

	return { queries, metrics: aggregateMetrics(scored) };
}

// ── The baseline gate (AC-6) ─────────────────────────────────────────────────

/**
 * The baseline-gate tolerance (PRD-027 AC-6). A run PASSES when both `recall@5` and
 * `MRR` are `≥ baseline − EPSILON`. The epsilon absorbs run-to-run noise (DeepLake
 * eventual consistency, embed jitter, the small golden set) so the gate fires only on a
 * REAL regression — not a flake. Small + named + single-sourced; tune it on the eval,
 * never by feel. `0.05` ≈ "two of the ~36 queries may flap" without tripping the gate.
 */
export const EPSILON = 0.05;

/** The committed baseline the gate enforces: the `recall@5` / `MRR` / `nDCG@10` floor. */
export interface RecallBaseline {
	/** The committed recall@5 baseline (the floor minus EPSILON). */
	readonly recallAt5: number;
	/** The committed MRR baseline (the floor minus EPSILON). */
	readonly mrr: number;
	/**
	 * The committed nDCG@10 baseline (the floor minus EPSILON), or `null` when the nDCG
	 * number has NOT yet been measured against the graded golden set (PRD-047f f-AC-3 is the
	 * orchestrator's live run). A `null` nDCG is PLACEHOLDER-TOLERANT: the nDCG arm of the
	 * gate is advisory (never fails the run) until the measured number lands, EVEN WHEN the
	 * recall@5 / MRR numbers are already enforced (`placeholder: false`). This lets f-047f
	 * ship the graded set + gating mechanism without blocking on a live measurement.
	 */
	readonly ndcg: number | null;
	/** `true` while the numbers are the pre-Wave-3 placeholder (the gate is advisory, not enforced). */
	readonly placeholder: boolean;
}

/**
 * The zod shape of `eval/recall-baseline.json`. `ndcg` is `number | null` and OPTIONAL:
 * absent or `null` both mean "nDCG not yet measured" → the nDCG arm of the gate is advisory.
 * Keys beginning `//` in the JSON are documentation comments, ignored by zod.
 */
const BaselineFileSchema = z.object({
	recallAt5: z.number().min(0).max(1),
	mrr: z.number().min(0).max(1),
	ndcg: z.number().min(0).max(1).nullable().optional().default(null),
	placeholder: z.boolean(),
});

/** Load + validate the committed baseline JSON (string in). Throws on a bad shape. */
export function loadBaseline(jsonText: string): RecallBaseline {
	let raw: unknown;
	try {
		raw = JSON.parse(jsonText);
	} catch (err) {
		throw new Error(`recall-baseline: not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
	}
	return BaselineFileSchema.parse(raw);
}

/** The verdict of the baseline gate: pass/fail + the per-metric detail. */
export interface GateVerdict {
	/** `true` iff every enforced metric cleared `baseline − EPSILON` (or the baseline is a placeholder). */
	readonly passed: boolean;
	/** The recall@5 measured this run. */
	readonly recallAt5: number;
	/** The MRR measured this run. */
	readonly mrr: number;
	/** The nDCG@10 measured this run. */
	readonly ndcg: number;
	/** The recall@5 floor (`baseline.recallAt5 − EPSILON`). */
	readonly recallAt5Floor: number;
	/** The MRR floor (`baseline.mrr − EPSILON`). */
	readonly mrrFloor: number;
	/**
	 * The nDCG@10 floor (`baseline.ndcg − EPSILON`), or `null` when the baseline nDCG is
	 * not yet measured (`baseline.ndcg === null`) — i.e. the nDCG arm is advisory.
	 */
	readonly ndcgFloor: number | null;
	/** `true` when the baseline is the placeholder → the gate is ADVISORY (never fails the run). */
	readonly advisory: boolean;
	/** Human-readable reasons for a failure (empty on pass). */
	readonly reasons: readonly string[];
}

/**
 * Gate a run's aggregate metrics against the committed baseline (AC-6 + PRD-047f f-AC-2).
 * `recall@5`, `MRR`, and `nDCG@10` must each be `≥ baseline − EPSILON`. Two independent
 * advisory short-circuits:
 *   - When the baseline is the pre-Wave-3 PLACEHOLDER (`placeholder: true`), the WHOLE gate
 *     is advisory: it computes the verdict + reasons but `passed` is forced `true`.
 *   - When `baseline.ndcg === null` (nDCG not yet measured — PRD-047f f-AC-3 is a later live
 *     run), only the nDCG ARM is advisory: its reason is still reported but it never fails the
 *     run, while recall@5 / MRR stay ENFORCED. This is the placeholder-tolerant nDCG floor:
 *     the gating mechanism ships now; the orchestrator drops in the measured number later.
 */
export function gateAgainstBaseline(metrics: AggregateMetrics, baseline: RecallBaseline): GateVerdict {
	const recallAt5 = metrics.recallAtK["5"] ?? 0;
	const mrr = metrics.mrr;
	const ndcg = metrics.ndcg;
	const recallAt5Floor = baseline.recallAt5 - EPSILON;
	const mrrFloor = baseline.mrr - EPSILON;
	const ndcgFloor = baseline.ndcg === null ? null : baseline.ndcg - EPSILON;

	const reasons: string[] = [];
	if (recallAt5 < recallAt5Floor) {
		reasons.push(`recall@5 ${recallAt5.toFixed(4)} < floor ${recallAt5Floor.toFixed(4)} (baseline ${baseline.recallAt5} − ε ${EPSILON})`);
	}
	if (mrr < mrrFloor) {
		reasons.push(`MRR ${mrr.toFixed(4)} < floor ${mrrFloor.toFixed(4)} (baseline ${baseline.mrr} − ε ${EPSILON})`);
	}
	// nDCG is enforced only once a real (non-null) baseline number is committed; an unmeasured
	// (null) nDCG baseline keeps this arm advisory even when recall@5 / MRR are enforced.
	const ndcgAdvisory = ndcgFloor === null;
	if (ndcgFloor !== null && ndcg < ndcgFloor) {
		reasons.push(`nDCG@10 ${ndcg.toFixed(4)} < floor ${ndcgFloor.toFixed(4)} (baseline ${baseline.ndcg} − ε ${EPSILON})`);
	}

	// The nDCG arm, when advisory, must not contribute to the enforced pass/fail decision.
	const blockingReasons = reasons.filter((r) => !(ndcgAdvisory && r.startsWith("nDCG@10")));
	const enforcedPass = blockingReasons.length === 0;
	return {
		// Placeholder baseline → advisory: never fail the run on placeholder numbers.
		passed: baseline.placeholder ? true : enforcedPass,
		recallAt5,
		mrr,
		ndcg,
		recallAt5Floor,
		mrrFloor,
		ndcgFloor,
		advisory: baseline.placeholder,
		reasons,
	};
}

/**
 * The semantic-vs-lexical comparison verdict (AC-6, the behavioral bar): semantic-ON
 * must BEAT lexical-only on recall@5 / MRR. A strict improvement on at least one of the
 * two with no regression on the other, AND the lexical-miss pairs must improve under
 * semantic (the load-bearing proof). Returns the deltas so the caller can report them.
 */
export interface SemanticLiftVerdict {
	/** `true` iff semantic-ON beat lexical-only on the behavioral bar. */
	readonly beats: boolean;
	/** recall@5 under semantic-ON minus under lexical-only. */
	readonly recallAt5Delta: number;
	/** MRR under semantic-ON minus under lexical-only. */
	readonly mrrDelta: number;
}

/**
 * Compare a semantic-ON run to a lexical-only run (AC-6). The bar: semantic must not
 * REGRESS either headline metric and must IMPROVE at least one — the generalized,
 * measured version of PRD-025's single-query AC-4. (The live itest additionally asserts
 * the lexical-miss pairs surface under semantic and miss under lexical — the sharpest
 * form of the proof.)
 */
export function compareSemanticVsLexical(
	semantic: AggregateMetrics,
	lexical: AggregateMetrics,
): SemanticLiftVerdict {
	const recallAt5Delta = (semantic.recallAtK["5"] ?? 0) - (lexical.recallAtK["5"] ?? 0);
	const mrrDelta = semantic.mrr - lexical.mrr;
	const noRegression = recallAt5Delta >= 0 && mrrDelta >= 0;
	const improvesOne = recallAt5Delta > 0 || mrrDelta > 0;
	return { beats: noRegression && improvesOne, recallAt5Delta, mrrDelta };
}

// ── PRD-058a, the freshness-sensitivity slice (the recency eval gate) ─────────

/**
 * One freshness-slice pair (PRD-058a Test Plan / AC-55a.1.1): a query plus the FRESH and STALE ids it
 * should surface, where both are equally relevant to the query (the same fact at two ages). The slice
 * asserts the recency activation ranks `freshId` ABOVE `staleId`. The caller seeds a fresh copy and a
 * stale copy of one memory under controlled `created_at`s, maps each to its landed id, and runs the
 * query; the live numeric run injects the real recall (SKIPs without creds), the unit suite drives a
 * deterministic fake.
 */
export interface FreshnessPair {
	/** A stable slug for the pair (the per-case report key). */
	readonly key: string;
	/** The natural-language query both the fresh + stale copies answer. */
	readonly query: string;
	/** The id of the FRESHER seeded copy, must rank first. */
	readonly freshId: string;
	/** The id of the STALER seeded copy, must rank below the fresh copy. */
	readonly staleId: string;
}

/** One freshness case's report line. */
export interface FreshnessCaseReport {
	/** The pair key. */
	readonly key: string;
	/** The query text. */
	readonly query: string;
	/** `true` iff the fresher copy ranked strictly above the staler one (AC-55a.1.1). */
	readonly freshFirst: boolean;
}

/** The freshness-slice result: per-case lines + the aggregate pass fraction + the gate verdict. */
export interface FreshnessSliceReport {
	/** One line per freshness pair. */
	readonly cases: readonly FreshnessCaseReport[];
	/** The fraction of cases where the fresher copy ranked first (`1` = all passed). */
	readonly passFraction: number;
	/** `true` iff EVERY case passed (the slice gate, recency must order fresher-first at equal relevance). */
	readonly passed: boolean;
}

/**
 * Run the freshness-sensitivity slice (PRD-058a): for each pair, run the injected recall, reduce to a
 * ranked id list, and score whether the fresher copy ranked above the staler one ({@link freshRanksFirst}).
 * Engine-agnostic, the unit suite injects a deterministic fake, the live caller injects `recallMemories`
 * mapped to `hit.id`s after seeding aged fixtures + polling to convergence. The slice GATE passes only
 * when every case passes (the recency term must demote the staler copy at equal relevance). A pure score
 * step: the caller owns seeding/polling, this owns the scoring.
 */
export async function runFreshnessSlice(
	pairs: readonly FreshnessPair[],
	recall: SeededRecall,
): Promise<FreshnessSliceReport> {
	const cases: FreshnessCaseReport[] = [];
	const scored: { result: RankedResult; freshCase: FreshnessCase }[] = [];
	for (const pair of pairs) {
		const ids = await recall(pair.query);
		const result: RankedResult = { ids };
		const freshCase: FreshnessCase = { caseId: pair.key, freshId: pair.freshId, staleId: pair.staleId };
		const freshFirst = freshRanksFirst(result, freshCase);
		cases.push({ key: pair.key, query: pair.query, freshFirst });
		scored.push({ result, freshCase });
	}
	const passFraction = freshnessSliceScore(scored);
	return { cases, passFraction, passed: passFraction === 1 };
}

// ── PRD-058c, the staleness precision/recall/F1 slice (the `σ` detection gate) ─

/**
 * One staleness-slice pair (PRD-058c Test Plan): a memory id, its GROUND-TRUTH `labeledStale` (does it
 * genuinely name a dangling reference?), and the memory `content` the diagnostic extracts references from.
 * The caller seeds the memory + the codebase-graph snapshot, runs the real stale-ref diagnostic, and maps
 * its verdict to `predictedStale`; the unit suite drives a deterministic predictor. The committed slice
 * makes the choice of `sim` threshold and `s` AUDITABLE rather than asserted.
 */
export interface StalenessPair {
	/** A stable slug for the pair (the per-case report key). */
	readonly key: string;
	/** The memory content (the diagnostic extracts references from this). */
	readonly content: string;
	/** Ground truth: `true` iff the memory genuinely names a reference that no longer resolves. */
	readonly labeledStale: boolean;
}

/**
 * The staleness predictor seam: given a memory's content, return whether the diagnostic flagged it `stale`
 * (`ref_status === 'stale'`). The LIVE numeric run wires the real {@link import("../daemon/runtime/maintenance/stale-ref-diagnostic.js").runStaleRefDiagnostic}
 * against a seeded snapshot (and SKIPs without creds); the unit suite injects a deterministic fake. Async
 * because the live diagnostic reads the snapshot.
 */
export type StalenessPredictor = (content: string) => Promise<boolean>;

/** One staleness case's report line. */
export interface StalenessCaseReport {
	/** The pair key. */
	readonly key: string;
	/** Ground truth. */
	readonly labeledStale: boolean;
	/** The diagnostic's verdict. */
	readonly predictedStale: boolean;
}

/** The staleness-slice result: per-case lines + the precision/recall/F1 over the labeled set. */
export interface StalenessSliceReport {
	/** One line per staleness pair. */
	readonly cases: readonly StalenessCaseReport[];
	/** The precision/recall/F1 (and the tp/fp/fn breakdown) over the slice. */
	readonly metrics: StalenessMetrics;
}

/**
 * Run the staleness slice (PRD-058c): for each labeled pair, ask the predictor whether the diagnostic
 * flags it `stale`, pair the prediction with the ground-truth label, and reduce to precision/recall/F1 via
 * {@link stalenessMetrics} ("do we flag the dead references and ONLY those?"). Engine-agnostic: the unit
 * suite injects a deterministic predictor, the live caller wires the real diagnostic after seeding the
 * memory + snapshot and polling to convergence. A pure score step: the caller owns seeding, this owns the
 * scoring + the committed numbers.
 */
export async function runStalenessSlice(
	pairs: readonly StalenessPair[],
	predict: StalenessPredictor,
): Promise<StalenessSliceReport> {
	const cases: StalenessCaseReport[] = [];
	const scored: StalenessCase[] = [];
	for (const pair of pairs) {
		const predictedStale = await predict(pair.content);
		cases.push({ key: pair.key, labeledStale: pair.labeledStale, predictedStale });
		scored.push({ caseId: pair.key, labeledStale: pair.labeledStale, predictedStale });
	}
	return { cases, metrics: stalenessMetrics(scored) };
}

// ── PRD-058b — the conflict slice (CRA + contradiction-detection PR/F1) ───────

/**
 * One conflict-slice pair (PRD-058b Test Plan): a labeled memory PAIR — the two texts, their ground-truth
 * `labeledConflict` (do they genuinely assert contradictory outcomes about the same claim?), and the
 * ground-truth `expectedWinnerId` (which memory should win if they DO conflict). The caller seeds the two
 * memories, runs the real detector + resolver, and maps the verdicts; the unit suite injects deterministic
 * predictors. The committed slice makes the choice of `θ_detect` (detection) and `τ` thresholds
 * (resolution) AUDITABLE rather than asserted.
 */
export interface ConflictPair {
	/** A stable slug for the pair (the per-case report key). */
	readonly key: string;
	/** The first memory id. */
	readonly aId: string;
	/** The second memory id. */
	readonly bId: string;
	/** Ground truth: `true` iff the pair genuinely asserts contradictory outcomes about the same claim. */
	readonly labeledConflict: boolean;
	/** Ground truth: the memory id that should win the conflict (only meaningful when `labeledConflict`). */
	readonly expectedWinnerId: string;
}

/**
 * The conflict-detection predictor seam: given a pair's two ids, return whether the detector flags it
 * (`Contra > θ_detect`). The LIVE run wires the real {@link import("../daemon/runtime/memories/conflict-detect.js").detectConflicts}
 * against seeded memories (and SKIPs without creds); the unit suite injects a deterministic fake. Async
 * because the live detector embeds + may call the model judge.
 */
export type ContradictionPredictor = (aId: string, bId: string) => Promise<boolean>;

/**
 * The conflict-resolution predictor seam: given a pair's two ids, return the winner the policy picked. The
 * LIVE run wires the real {@link import("../daemon/runtime/memories/conflict-resolve.js").resolveConflict};
 * the unit suite injects a deterministic fake. Async to mirror the live resolver's reads.
 */
export type ConflictWinnerPredictor = (aId: string, bId: string) => Promise<string>;

/** One conflict case's report line. */
export interface ConflictCaseReport {
	/** The pair key. */
	readonly key: string;
	/** Ground truth: was it a genuine conflict? */
	readonly labeledConflict: boolean;
	/** The detector's verdict. */
	readonly predictedConflict: boolean;
	/** Ground truth winner. */
	readonly expectedWinnerId: string;
	/** The policy's winner (only scored for genuine conflicts the detector also flagged). */
	readonly predictedWinnerId: string;
}

/** The conflict-slice result: per-case lines + the detection PR/F1 + the Conflict Resolution Accuracy. */
export interface ConflictSliceReport {
	/** One line per conflict pair. */
	readonly cases: readonly ConflictCaseReport[];
	/** The contradiction-detection precision/recall/F1 over the labeled set ("detect the right pairs?"). */
	readonly detection: StalenessMetrics;
	/** The Conflict Resolution Accuracy over the labeled-conflict subset ("pick the right winner?"). */
	readonly resolution: ConflictResolutionMetrics;
}

/**
 * Run the conflict slice (PRD-058b): for each labeled pair, ask the detection predictor whether the
 * detector flags it (reduced to contradiction-detection PR/F1 via {@link contradictionMetrics}), and — for
 * the GENUINE conflicts the detector also caught — ask the winner predictor whom the policy picked (reduced
 * to CRA via {@link conflictResolutionAccuracy}). Engine-agnostic: the unit suite injects deterministic
 * predictors, the live caller wires the real detector + resolver after seeding the memories and polling to
 * convergence. CRA is scored over the genuine-conflict subset (a non-conflict pair has no "right winner" to
 * pick). A pure score step: the caller owns seeding, this owns the scoring + the committed numbers.
 */
export async function runConflictSlice(
	pairs: readonly ConflictPair[],
	detect: ContradictionPredictor,
	pickWinner: ConflictWinnerPredictor,
): Promise<ConflictSliceReport> {
	const cases: ConflictCaseReport[] = [];
	const detectionScored: ContradictionCase[] = [];
	const resolutionScored: ConflictResolutionCase[] = [];
	for (const pair of pairs) {
		const predictedConflict = await detect(pair.aId, pair.bId);
		// CRA is scored only over GENUINE conflicts that were actually detected (a missed or non-conflict
		// pair has no winner to resolve). The detector must catch it before the resolver is asked.
		let predictedWinnerId = "";
		if (pair.labeledConflict && predictedConflict) {
			predictedWinnerId = await pickWinner(pair.aId, pair.bId);
			resolutionScored.push({ caseId: pair.key, expectedWinnerId: pair.expectedWinnerId, predictedWinnerId });
		}
		cases.push({
			key: pair.key,
			labeledConflict: pair.labeledConflict,
			predictedConflict,
			expectedWinnerId: pair.expectedWinnerId,
			predictedWinnerId,
		});
		detectionScored.push({ caseId: pair.key, labeledConflict: pair.labeledConflict, predictedConflict });
	}
	return {
		cases,
		detection: contradictionMetrics(detectionScored),
		resolution: conflictResolutionAccuracy(resolutionScored),
	};
}

// ── PRD-058 — useful-context@k (the scoring-doc HEADLINE end-to-end metric) ───

/**
 * One useful-context@k slice pair (the scoring-doc headline): a query plus the CORRECT answer ids and the
 * EXCLUDED ids (stale copies + open-conflict losers) that must NOT count even if surfaced. The slice asks
 * the end-to-end question the four per-term slices decompose — "does the top-k surface a memory that is
 * correct AND current AND non-conflicting?". The caller seeds the fresh/correct copy, the stale copy, and
 * the conflict loser, maps each to its landed id, and runs the query; the live numeric run injects the
 * real recall (and SKIPs without creds), the unit suite drives a deterministic fake. The CODE + its unit
 * coverage ship now (the live numeric run is creds-gated).
 */
export interface UsefulContextPair {
	/** A stable slug for the pair (the per-case report key). */
	readonly key: string;
	/** The natural-language query run through recall. */
	readonly query: string;
	/** The ids that are CORRECT, CURRENT, NON-CONFLICTING answers — a top-k hit on one is "useful". */
	readonly correctIds: readonly string[];
	/** The ids that must NOT count even when surfaced: stale/superseded copies + open-conflict losers. */
	readonly excludedIds: readonly string[];
}

/** One useful-context case's report line. */
export interface UsefulContextCaseReport {
	/** The pair key. */
	readonly key: string;
	/** The query text. */
	readonly query: string;
	/** useful-context@k keyed by k for THIS case (1 = the top-k surfaced a correct, non-excluded memory). */
	readonly usefulAtK: Readonly<Record<string, number>>;
}

/** The useful-context slice result: per-case lines + the aggregate useful-context@k. */
export interface UsefulContextSliceReport {
	/** One line per useful-context pair. */
	readonly cases: readonly UsefulContextCaseReport[];
	/** The aggregate useful-context@k over the slice (the headline numbers). */
	readonly metrics: UsefulContextMetrics;
}

/**
 * Run the useful-context@k slice (PRD-058 headline): for each pair, run the injected recall, reduce to a
 * ranked id list, and score whether the top-k surfaced a memory that is correct AND not excluded (not
 * stale, not a conflict loser) via {@link usefulContextAtK} / {@link aggregateUsefulContext}. This is the
 * end-to-end conjunction of the freshness / staleness / contradiction / CRA slices — the single number the
 * scoring doc commits as the headline. Engine-agnostic: the unit suite injects a deterministic fake, the
 * live caller injects `recallMemories` mapped to `hit.id`s after seeding the fresh/correct copy, the stale
 * copy, and the conflict loser, then polling to convergence. A pure score step: the caller owns seeding +
 * polling, this owns the scoring.
 */
export async function runUsefulContextSlice(
	pairs: readonly UsefulContextPair[],
	recall: SeededRecall,
): Promise<UsefulContextSliceReport> {
	const cases: UsefulContextCaseReport[] = [];
	const scored: { result: RankedResult; useful: UsefulContextCase }[] = [];
	for (const pair of pairs) {
		const ids = await recall(pair.query);
		const result: RankedResult = { ids };
		const useful: UsefulContextCase = { caseId: pair.key, correctIds: pair.correctIds, excludedIds: pair.excludedIds };
		const usefulAtK: Record<string, number> = {};
		for (const k of [1, 5, 10]) usefulAtK[String(k)] = usefulContextAtK(result, useful, k);
		cases.push({ key: pair.key, query: pair.query, usefulAtK });
		scored.push({ result, useful });
	}
	return { cases, metrics: aggregateUsefulContext(scored) };
}

// ── PRD-058e / IDX-5 — the ECE-over-time slice (the calibration trend curve) ──

/**
 * One ECE-over-time WINDOW (PRD-058e / IDX-5: "commit the ECE-over-time curve"): a labeled time window of
 * resolved calibration observations (`(f, y)` pairs — the raw confidence + the observed correctness the
 * lifecycle yields) plus the calibration MODEL in force during that window. The slice computes the
 * held-out ECE (and Brier) per window and reports the trend, so the scoring doc's claim that calibration
 * IMPROVES over time is MEASURED, not asserted. Windows are ordered oldest-first; the curve is the ECE per
 * window. The `model` is the curve fitted by the END of the window (the identity model for a cold-start
 * window); supplying it lets the slice show ECE FALLING as the fitted curve replaces the identity default.
 */
export interface EceWindow {
	/** A stable label for the window (e.g. an ISO date or a window index) — the per-point report key. */
	readonly label: string;
	/** The resolved `(f, y)` observations that landed in this window. */
	readonly samples: readonly CalibrationSample[];
	/** The calibration model in force during the window (default identity — the cold-start `C = f`). */
	readonly model?: CalibrationModel;
}

/** One ECE-over-time curve point: the window label, its sample count, its ECE, and its Brier score. */
export interface EceCurvePoint {
	/** The window label. */
	readonly label: string;
	/** How many `(f, y)` observations fell in the window. */
	readonly count: number;
	/** The window's Expected Calibration Error (lower = better calibrated). */
	readonly ece: number;
	/** The window's Brier score (lower = better). */
	readonly brier: number;
}

/** The ECE-over-time slice result: the per-window curve + whether the trend is non-worsening. */
export interface EceOverTimeReport {
	/** The ECE/Brier per window, oldest-first (the committed curve). */
	readonly curve: readonly EceCurvePoint[];
	/** The ECE of the FIRST window (the baseline, usually the cold-start identity model). */
	readonly firstEce: number;
	/** The ECE of the LAST window (the latest fitted curve). */
	readonly lastEce: number;
	/**
	 * `true` iff the LAST window's ECE is `≤` the FIRST window's (calibration did not get WORSE over time —
	 * the monotone-improvement property `shouldAdoptRefit` enforces, observed end-to-end). A single-window
	 * curve is trivially non-worsening. The eval reports this; it never silently fails a creds-gated run.
	 */
	readonly improved: boolean;
}

/**
 * Run the ECE-over-time slice (PRD-058e / IDX-5): for each window oldest-first, compute the held-out ECE
 * and Brier of its observations under the window's calibration model ({@link expectedCalibrationError} /
 * {@link brierScore} from `calibration.ts` — the SAME math the 58e gate uses), and reduce to the committed
 * curve + the "did it improve?" verdict (last-window ECE ≤ first-window ECE). This is the standalone trend
 * the per-fit `shouldAdoptRefit` gate implies, made into an eval-visible curve. Pure: the caller supplies
 * the windowed observations (the live numeric run reads resolved outcomes from `memory_history` and SKIPs
 * without creds); this owns the scoring. An empty window set → an empty curve with `improved: true`
 * (nothing measured, never NaN).
 */
export function runEceOverTimeSlice(windows: readonly EceWindow[]): EceOverTimeReport {
	const curve: EceCurvePoint[] = windows.map((w) => {
		const model = w.model ?? IDENTITY_MODEL;
		return {
			label: w.label,
			count: w.samples.length,
			ece: expectedCalibrationError(w.samples, model),
			brier: brierScore(w.samples, model),
		};
	});
	const firstEce = curve[0]?.ece ?? 0;
	const lastEce = curve[curve.length - 1]?.ece ?? 0;
	// Non-worsening: the latest ECE is at most the baseline ECE (calibration did not regress over time).
	const improved = curve.length === 0 ? true : lastEce <= firstEce;
	return { curve, firstEce, lastEce, improved };
}
