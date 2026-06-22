/**
 * The PRIME-EVAL harness — PRD-046f (prove the prime, or pull it).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * This module measures whether SESSION PRIMING (the 046c digest injected at
 * SessionStart) changes what the agent retrieves versus a COLD start. It extends
 * the recall-eval discipline (`src/eval/golden.ts` + `src/eval/metrics.ts`) from
 * "is the right memory retrievable" to "does priming change what the agent does",
 * WITHOUT forking a second metrics module and WITHOUT any LLM judgement.
 *
 * Like `golden.ts`, it owns NO I/O: the agent's two behaviors are injected as a
 * `PrimedBehavior` (primed) and a `ColdBehavior` (cold) seam, so:
 *   - the unit tests drive a DETERMINISTIC fake (primed surfaces the target, cold
 *     does not) and hand-check the report;
 *   - the gated live itest injects the REAL prime digest (assembled from a seeded
 *     `honeycomb_ci` workspace) + the REAL recall engine.
 * One harness, two callers, pure signals.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── Why the signals are DETERMINISTIC (no LLM judge — f-AC-2) ─────────────────
 * The prime path is itself deterministic: `skimPrimeKeys` (pure SQL) →
 * `assemblePrimeDigest` (pure transform) yields a fixed list of `(key, ref)`
 * entries for a given seeded scope. So we never ask a model "did priming help" —
 * we measure two facts that fall straight out of the digest + the resolve/recall
 * outputs:
 *
 *   1. PULL-THROUGH — is the TARGET memory's ref present in the prime digest (so
 *      the agent CAN resolve it with one `hivemind_read`, with no blind search)?
 *      A key nobody can expand is a bad key — 046b's make-or-break, measured. A
 *      COLD start has no digest, so pull-through is structurally 0 for cold.
 *
 *   2. REDUNDANT-SEARCH REDUCTION — how many blind searches does each path need to
 *      REACH the target? The COLD path must search (`coldSearchCount`, the
 *      scenario's hand-estimated blind-search cost). The PRIMED path, when the
 *      target is in the digest, resolves it directly (`primedResolveCount`, ~1) and
 *      needs ZERO blind searches. The reduction is `coldSearchCount − primedSearches`.
 *
 * Both reduce to COUNTS and a SET-MEMBERSHIP test over ids — exactly the shape of
 * `metrics.ts` (pure, hand-verifiable). The scenario set commits the cold cost so
 * the comparison is reproducible; the live itest derives the PRIMED side from the
 * REAL assembled digest (the target's ref really is or is not in it), so the proof
 * is not circular — the digest is measured, not assumed.
 */

import { z } from "zod";

/**
 * One prime scenario: a TARGET memory whose prior-session decision answers `task`,
 * plus DISTRACTOR memories that share the digest but are not the answer (so
 * pull-through is a real discrimination), the COLD blind-search cost, and the
 * PRIMED resolve cost. See `eval/prime-golden.json` + `eval/README-prime.md`.
 */
export interface PrimeScenario {
	/** A stable slug; the harness uniquifies it per run ({@link uniquePrimeKeyFor}). */
	readonly key: string;
	/** The memory whose decision answers `task` — STORED so its Tier-1 key lands in the digest. */
	readonly targetMemoryText: string;
	/** Other memories seeded in the same scope (share the digest, not the answer). */
	readonly distractorMemoryTexts: readonly string[];
	/** The prompt the agent faces. */
	readonly task: string;
	/** Blind searches a COLD agent needs to reach the target with no prime (≥ 1). */
	readonly coldSearchCount: number;
	/** Resolve calls a PRIMED agent needs when the digest lists the target's key (≥ 1, normally 1). */
	readonly primedResolveCount: number;
}

/** The committed prime-scenario set: the validated scenarios. */
export interface PrimeScenarioSet {
	/** The scenarios to run primed-vs-cold. */
	readonly scenarios: readonly PrimeScenario[];
}

/** The zod shape of ONE scenario in the committed JSON. Keys beginning `//` are doc comments, ignored. */
const PrimeScenarioSchema = z.object({
	key: z.string().min(1),
	targetMemoryText: z.string().min(1),
	distractorMemoryTexts: z.array(z.string().min(1)).default([]),
	task: z.string().min(1),
	coldSearchCount: z.number().int().positive(),
	primedResolveCount: z.number().int().positive(),
});

/** The zod shape of the committed scenario-set JSON (only `scenarios` is load-bearing). */
const PrimeFileSchema = z.object({
	scenarios: z.array(PrimeScenarioSchema).min(1),
});

/**
 * Validate a parsed scenario-set JSON into a {@link PrimeScenarioSet}. Throws a zod error on a
 * malformed set (a missing field, an empty `scenarios`, a non-positive count) — a broken set is a
 * hard failure, never a silently-empty eval. The `key` uniqueness invariant is checked here too
 * (duplicate keys would collide on seed).
 */
export function parsePrimeScenarioSet(raw: unknown): PrimeScenarioSet {
	const parsed = PrimeFileSchema.parse(raw);
	const seen = new Set<string>();
	for (const sc of parsed.scenarios) {
		if (seen.has(sc.key)) {
			throw new Error(`prime-golden: duplicate scenario key "${sc.key}" (keys must be unique)`);
		}
		seen.add(sc.key);
	}
	return { scenarios: parsed.scenarios };
}

/**
 * Load + validate the scenario set from a JSON string (the file contents). Pure (string-in, not a
 * file read) so it is unit-testable; the script / itest read the file and pass the contents.
 * Throws on malformed JSON or a bad shape.
 */
export function loadPrimeScenarioSet(jsonText: string): PrimeScenarioSet {
	let raw: unknown;
	try {
		raw = JSON.parse(jsonText);
	} catch (err) {
		throw new Error(`prime-golden: not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
	}
	return parsePrimeScenarioSet(raw);
}

/** The per-run-unique seed key for a scenario: `key-runId`. Mirrors `golden.ts`'s {@link uniqueKeyFor}. */
export function uniquePrimeKeyFor(scenarioKey: string, runId: string): string {
	return `${scenarioKey}-${runId}`;
}

/**
 * The seed text for a scenario's TARGET memory under a run: the target text with the run id appended
 * so the stored memory is unique to this run (the same isolation `golden.ts`'s `seedTextFor` gives).
 * The task carries no run id, so it never trivially shares the run token with the target.
 */
export function targetSeedTextFor(scenario: PrimeScenario, runId: string): string {
	return `${scenario.targetMemoryText} [${runId}]`;
}

// ── The two behavior seams (injected; pure-fn callable) ──────────────────────

/**
 * The PRIMED behavior: given a scenario, return what the agent — armed with the session-start
 * digest — actually reaches. `digestRefs` is the set of ref ids the prime digest surfaced for this
 * scope (the `(key, ref)` entries' refs); `resolvedTargetId` is the target memory's storage id IFF
 * a `hivemind_read` of a primed ref resolved to it (null when the target was not in the digest, so
 * the primed agent could NOT pull it through). `blindSearches` is how many blind searches the primed
 * agent STILL had to run (0 when the digest carried the target).
 */
export interface PrimedOutcome {
	/** The target memory's storage id IFF a primed-ref resolve surfaced it; else null (no pull-through). */
	readonly resolvedTargetId: string | null;
	/** Blind searches the primed agent still ran to reach the target (0 when the digest carried it). */
	readonly blindSearches: number;
}

/**
 * The COLD behavior: given a scenario, return what the agent — with NO prime — reaches. `targetId`
 * is the target's storage id IFF blind search eventually surfaced it (it may, the prime is not the
 * only path); `blindSearches` is how many blind searches that cost (the scenario's `coldSearchCount`
 * in the deterministic model, or the real blind-search count in the live itest). A cold agent has NO
 * digest, so it can never PULL THROUGH a primed key — pull-through is structurally a primed-only win.
 */
export interface ColdOutcome {
	/** The target memory's id IFF blind search surfaced it; else null. */
	readonly targetId: string | null;
	/** Blind searches the cold agent ran to reach (or fail to reach) the target. */
	readonly blindSearches: number;
}

/** The injected primed-behavior seam: run the primed agent for a scenario, return its outcome. */
export type PrimedBehavior = (scenario: PrimeScenario) => Promise<PrimedOutcome>;
/** The injected cold-behavior seam: run the cold agent for a scenario, return its outcome. */
export type ColdBehavior = (scenario: PrimeScenario) => Promise<ColdOutcome>;

// ── The pure per-scenario signals (hand-verifiable, like metrics.ts) ─────────

/**
 * PULL-THROUGH for ONE scenario: `1` iff the PRIMED agent resolved the target through a primed key
 * (its `resolvedTargetId` is non-null), else `0`. This is the 046b make-or-break measured — a primed
 * key the agent can actually expand to the answer. A COLD start has no digest, so cold pull-through
 * is structurally `0` (see {@link scoreScenario}). Pure: a null check, no I/O, no model.
 */
export function pullThrough(primed: PrimedOutcome): number {
	return primed.resolvedTargetId !== null ? 1 : 0;
}

/**
 * REDUNDANT-SEARCH REDUCTION for ONE scenario: how many blind searches priming SAVED. The cold path
 * ran `cold.blindSearches`; the primed path ran `primed.blindSearches` (0 when the digest carried the
 * target). The reduction is `cold − primed`, clamped at `0` (priming never costs MORE blind searches —
 * a negative would mean the model is broken, so we floor it rather than reward a regression). Pure
 * subtraction. A larger reduction = priming reached the target with fewer blind searches.
 */
export function redundantSearchReduction(primed: PrimedOutcome, cold: ColdOutcome): number {
	return Math.max(0, cold.blindSearches - primed.blindSearches);
}

/** One scenario's per-scenario eval line (the report row). */
export interface PrimeScenarioReport {
	/** The scenario key (un-uniquified — the stable slug). */
	readonly key: string;
	/** The task text. */
	readonly task: string;
	/** `1` iff the primed agent pulled the target through a primed key, else `0`. */
	readonly pullThrough: number;
	/** Blind searches the primed agent ran (0 when the digest carried the target). */
	readonly primedBlindSearches: number;
	/** Blind searches the cold agent ran. */
	readonly coldBlindSearches: number;
	/** `cold − primed` blind searches saved by priming (≥ 0). */
	readonly searchReduction: number;
	/** The target id the primed agent resolved (null on a primed miss). */
	readonly primedTargetId: string | null;
	/** The target id the cold agent reached via blind search (null on a cold miss). */
	readonly coldTargetId: string | null;
}

/** The aggregate prime signals over a scenario set (the eval headline numbers). */
export interface PrimeAggregate {
	/** The number of scored scenarios (the denominator for every mean). */
	readonly scenarioCount: number;
	/** Mean pull-through over the scenarios (primed) — the headline signal. The cold mean is always 0. */
	readonly pullThroughRate: number;
	/** Mean blind searches the primed agent ran per scenario. */
	readonly primedBlindSearchMean: number;
	/** Mean blind searches the cold agent ran per scenario. */
	readonly coldBlindSearchMean: number;
	/** Mean redundant-search reduction (`cold − primed`) per scenario — the second headline signal. */
	readonly searchReductionMean: number;
}

/**
 * Score ONE scenario into a {@link PrimeScenarioReport}: pull-through (primed only) + the blind-search
 * counts + the reduction. Pure over the two injected outcomes — no I/O. (`scenario` supplies the slug
 * + task for the report line; the numeric signals come entirely from the outcomes.)
 */
export function scoreScenario(
	scenario: PrimeScenario,
	primed: PrimedOutcome,
	cold: ColdOutcome,
): PrimeScenarioReport {
	return {
		key: scenario.key,
		task: scenario.task,
		pullThrough: pullThrough(primed),
		primedBlindSearches: primed.blindSearches,
		coldBlindSearches: cold.blindSearches,
		searchReduction: redundantSearchReduction(primed, cold),
		primedTargetId: primed.resolvedTargetId,
		coldTargetId: cold.targetId,
	};
}

/**
 * Reduce a scored scenario set to the aggregate {@link PrimeAggregate}: the pull-through rate and the
 * mean blind-search counts + reduction, each the MEAN over the scenarios. An empty set yields all-zero
 * signals with `scenarioCount: 0` (never NaN) — the caller treats that as "nothing to measure", not a
 * passing eval. (The COLD pull-through rate is omitted because it is structurally 0 — a cold start has
 * no digest to pull through — so the primed `pullThroughRate` IS the primed-vs-cold pull-through delta.)
 */
export function aggregatePrime(reports: readonly PrimeScenarioReport[]): PrimeAggregate {
	const n = reports.length;
	if (n === 0) {
		return {
			scenarioCount: 0,
			pullThroughRate: 0,
			primedBlindSearchMean: 0,
			coldBlindSearchMean: 0,
			searchReductionMean: 0,
		};
	}
	let pull = 0;
	let primedSearch = 0;
	let coldSearch = 0;
	let reduction = 0;
	for (const r of reports) {
		pull += r.pullThrough;
		primedSearch += r.primedBlindSearches;
		coldSearch += r.coldBlindSearches;
		reduction += r.searchReduction;
	}
	return {
		scenarioCount: n,
		pullThroughRate: pull / n,
		primedBlindSearchMean: primedSearch / n,
		coldBlindSearchMean: coldSearch / n,
		searchReductionMean: reduction / n,
	};
}

/** The full prime-eval result: the per-scenario report + the aggregate signals for each arm. */
export interface PrimeEvalReport {
	/** One line per scenario. */
	readonly scenarios: readonly PrimeScenarioReport[];
	/** The aggregate prime signals over the scenario set. */
	readonly aggregate: PrimeAggregate;
}

/**
 * Run the prime eval: for each scenario, run the injected PRIMED + COLD behaviors, score the pure
 * signals, and reduce to per-scenario + aggregate. The caller has already seeded + (for a live run)
 * polled to convergence + assembled the real digest; this is the pure score step. Mirrors
 * `golden.ts`'s {@link import("./golden.js").runEval} exactly: inject the behavior, score the output.
 */
export async function runPrimeEval(
	set: PrimeScenarioSet,
	primedBehavior: PrimedBehavior,
	coldBehavior: ColdBehavior,
): Promise<PrimeEvalReport> {
	const scenarios: PrimeScenarioReport[] = [];
	for (const sc of set.scenarios) {
		const primed = await primedBehavior(sc);
		const cold = await coldBehavior(sc);
		scenarios.push(scoreScenario(sc, primed, cold));
	}
	return { scenarios, aggregate: aggregatePrime(scenarios) };
}

// ── The primed-vs-cold bar (f-AC-3) ──────────────────────────────────────────

/**
 * The primed-vs-cold verdict (f-AC-3, the behavioral bar): priming must BEAT a cold start on the
 * HEADLINE signal — pull-through and/or redundant-search reduction — with NO regression. Concretely:
 *   - pull-through: the primed agent pulls the target through a primed key at a positive rate, where
 *     a cold start is structurally 0 (no digest) → any positive primed rate is a strict win; AND
 *   - no regression: priming never ran MORE blind searches on average than cold.
 * A clean beat requires a positive pull-through rate AND the primed blind-search mean ≤ cold's (the
 * reduction mean ≥ 0). Returns the deltas so the caller can report them. The sharper live assertion
 * (primed pulls the target through, cold must blind-search) lives in the itest.
 */
export interface PrimeLiftVerdict {
	/** `true` iff priming beat cold on the headline signal with no regression. */
	readonly beats: boolean;
	/** The primed pull-through rate (the cold rate is structurally 0, so this IS the delta). */
	readonly pullThroughRate: number;
	/** The mean redundant-search reduction (`cold − primed`), the second headline delta. */
	readonly searchReductionMean: number;
}

/**
 * Compare the primed arm to the cold arm (f-AC-3). The bar: a positive pull-through rate (priming
 * surfaces targets a cold start cannot) AND no blind-search regression (the reduction mean ≥ 0).
 * This is the generalized, measured "priming helps" proof — the prime-eval analogue of
 * `golden.ts`'s {@link import("./golden.js").compareSemanticVsLexical}.
 */
export function comparePrimedVsCold(aggregate: PrimeAggregate): PrimeLiftVerdict {
	const noSearchRegression = aggregate.searchReductionMean >= 0;
	const positivePullThrough = aggregate.pullThroughRate > 0;
	return {
		beats: positivePullThrough && noSearchRegression,
		pullThroughRate: aggregate.pullThroughRate,
		searchReductionMean: aggregate.searchReductionMean,
	};
}

// ── The committed gate (f-AC-4) ──────────────────────────────────────────────

/**
 * The prime-gate tolerance (f-AC-4). A run PASSES when both the pull-through rate and the mean
 * search reduction are `≥ baseline − EPSILON_PRIME`. The epsilon absorbs run-to-run noise (DeepLake
 * eventual consistency, a digest entry shuffled out by the token budget under workspace churn) so
 * the gate fires only on a REAL regression, not a flake. Small + named + single-sourced; same
 * posture as `golden.ts`'s `EPSILON`. `0.05` ≈ "one of the ~10 scenarios may flap" without tripping.
 */
export const EPSILON_PRIME = 0.05;

/** The committed prime baseline the gate enforces: the pull-through / search-reduction floor. */
export interface PrimeBaseline {
	/** The committed pull-through-rate baseline (the floor minus EPSILON_PRIME). */
	readonly pullThroughRate: number;
	/** The committed mean-search-reduction baseline (the floor minus EPSILON_PRIME). */
	readonly searchReductionMean: number;
	/** `true` while the numbers are the pre-measurement placeholder (the gate is advisory, not enforced). */
	readonly placeholder: boolean;
}

/** The zod shape of `eval/prime-baseline.json`. */
const PrimeBaselineFileSchema = z.object({
	pullThroughRate: z.number().min(0).max(1),
	searchReductionMean: z.number().min(0),
	placeholder: z.boolean(),
});

/** Load + validate the committed prime baseline JSON (string in). Throws on a bad shape. */
export function loadPrimeBaseline(jsonText: string): PrimeBaseline {
	let raw: unknown;
	try {
		raw = JSON.parse(jsonText);
	} catch (err) {
		throw new Error(`prime-baseline: not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
	}
	return PrimeBaselineFileSchema.parse(raw);
}

/** The verdict of the prime baseline gate: pass/fail + the per-signal detail. */
export interface PrimeGateVerdict {
	/** `true` iff both signals cleared `baseline − EPSILON_PRIME` (or the baseline is a placeholder). */
	readonly passed: boolean;
	/** The pull-through rate measured this run. */
	readonly pullThroughRate: number;
	/** The mean search reduction measured this run. */
	readonly searchReductionMean: number;
	/** The pull-through floor (`baseline.pullThroughRate − EPSILON_PRIME`). */
	readonly pullThroughFloor: number;
	/** The search-reduction floor (`baseline.searchReductionMean − EPSILON_PRIME`). */
	readonly searchReductionFloor: number;
	/** `true` when the baseline is the placeholder → the gate is ADVISORY (never fails the run). */
	readonly advisory: boolean;
	/** Human-readable reasons for a failure (empty on pass). */
	readonly reasons: readonly string[];
}

/**
 * Gate a run's aggregate signals against the committed prime baseline (f-AC-4). Both the pull-through
 * rate and the mean search reduction must be `≥ baseline − EPSILON_PRIME`. When the baseline is the
 * pre-measurement PLACEHOLDER, the gate is ADVISORY: it computes the verdict + reasons but `passed` is
 * forced `true`, so the harness reports the comparison without failing a run before the real baseline
 * is committed. Once a measured baseline sets `placeholder: false`, the gate ENFORCES. Mirrors
 * `golden.ts`'s {@link import("./golden.js").gateAgainstBaseline} exactly (advisory → enforced).
 */
export function gatePrimeAgainstBaseline(aggregate: PrimeAggregate, baseline: PrimeBaseline): PrimeGateVerdict {
	const pullThroughFloor = baseline.pullThroughRate - EPSILON_PRIME;
	const searchReductionFloor = baseline.searchReductionMean - EPSILON_PRIME;
	const reasons: string[] = [];
	if (aggregate.pullThroughRate < pullThroughFloor) {
		reasons.push(
			`pull-through ${aggregate.pullThroughRate.toFixed(4)} < floor ${pullThroughFloor.toFixed(4)} ` +
				`(baseline ${baseline.pullThroughRate} − ε ${EPSILON_PRIME})`,
		);
	}
	if (aggregate.searchReductionMean < searchReductionFloor) {
		reasons.push(
			`search-reduction ${aggregate.searchReductionMean.toFixed(4)} < floor ${searchReductionFloor.toFixed(4)} ` +
				`(baseline ${baseline.searchReductionMean} − ε ${EPSILON_PRIME})`,
		);
	}
	const enforcedPass = reasons.length === 0;
	return {
		passed: baseline.placeholder ? true : enforcedPass,
		pullThroughRate: aggregate.pullThroughRate,
		searchReductionMean: aggregate.searchReductionMean,
		pullThroughFloor,
		searchReductionFloor,
		advisory: baseline.placeholder,
		reasons,
	};
}
