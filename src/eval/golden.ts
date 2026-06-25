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
	aggregateMetrics,
	firstRelevantRank,
	type AggregateMetrics,
	type RankedResult,
	type RelevanceJudgements,
	type ScoredQuery,
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
		const judgements: RelevanceJudgements = Object.fromEntries(
			expectedSet.map((id) => [id, pair.relevance] as const),
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
		scored.push({ queryId: pair.key, result, judgements });
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
