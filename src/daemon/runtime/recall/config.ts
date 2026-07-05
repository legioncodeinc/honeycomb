/**
 * Recall config — PRD-007 Wave 1 (the single config module every recall phase reads).
 *
 * Resolves the recall engine's tuning knobs from the environment, validated by
 * zod, mirroring the pipeline `config.ts` pattern exactly: a provider seam, one
 * `safeParse` boundary, coerce/clamp tuning knobs rather than reject the whole
 * config on a fat-fingered number. This is the ONE place the recall engine's
 * knobs live; a phase NEVER reads `process.env` directly.
 *
 * ── The knobs (ledger D-1..D-6 + graph gate) ────────────────────────────────
 * - `overFetchMultiplier`   D-1: 3x — the vector channel over-fetches so the
 *                           authorization phase (007c) still has survivors after
 *                           the scope clause prunes (a-AC-2 / FR-5).
 * - `hintCap`               D-2: ≤3 hint-only candidates — a memory matched only
 *                           by hints cannot ride into the pool (a-AC-4 / FR-7).
 * - `keywordExpansion`      D-2: OFF by default — keyword expansion widens
 *                           class→instance gaps for the LEXICAL path only (FR-2).
 * - `traversal.*`           D-3: aspects/entity 10, attrs/aspect 20, branching 5,
 *                           total IDs 100, min edge strength×confidence 0.3, hard
 *                           timeout 500ms (007b consumes; Wave-1 stub).
 * - `reranker.*`            D-4: embedding-cosine default, 300ms timeout, keep
 *                           original order on timeout (007d consumes; Wave-1 stub).
 * - `dampening.*`           D-5: gravity/hub/resolution + rehearsal-boost windows
 *                           (007d consumes; Wave-1 stub).
 * - `minInjectionScore`     D-6: 0.6 default, per-agent tunable — the gate (007e)
 *                           injects only above this calibrated score.
 * - `graphEnabled`          master graph switch for the traversal channel/phase.
 *
 * ── Why coerce-and-clamp, not hard-reject (mirrors pipeline/config.ts) ──────
 * The booleans default false-safe; the numeric knobs are tuning, so a non-numeric
 * value falls back to its default and an out-of-range value is clamped — a typo
 * never takes the daemon down, it just runs with the documented default.
 *
 * ── No-touch (CONVENTIONS §shared) ──────────────────────────────────────────
 * Wave-2 phases CONSUME this config; they do not edit it. A new knob a phase
 * needs is added here once, defaulted, and documented — never read off env in the
 * phase module.
 */

import { z } from "zod";
import { DEFAULT_OVERFETCH_MULTIPLIER } from "../../storage/vector.js";

// ── D-1 over-fetch ──────────────────────────────────────────────────────────
/** Over-fetch multiplier for scoped vector recalls (D-1 / a-AC-2 / FR-5). */
export const DEFAULT_OVER_FETCH_MULTIPLIER = DEFAULT_OVERFETCH_MULTIPLIER; // 3

// ── D-2 hint cap + keyword expansion ────────────────────────────────────────
/** Max hint-only candidates so a memory can't ride in on hints alone (D-2 / a-AC-4 / FR-7). */
export const DEFAULT_HINT_CAP = 3;

// ── Base per-channel result limits (pre over-fetch) ─────────────────────────
/** Default per-channel candidate limit (FTS / vector base, before over-fetch). */
export const DEFAULT_CHANNEL_LIMIT = 20;

// ── D-3 traversal budgets (007b) ────────────────────────────────────────────
/** Max aspects walked per focal entity (D-3). */
export const DEFAULT_TRAVERSAL_ASPECTS_PER_ENTITY = 10;
/** Max attributes walked per aspect (D-3). */
export const DEFAULT_TRAVERSAL_ATTRS_PER_ASPECT = 20;
/** Max branching factor per node (D-3). */
export const DEFAULT_TRAVERSAL_BRANCHING = 5;
/** Hard cap on total IDs the walk may collect (D-3). */
export const DEFAULT_TRAVERSAL_TOTAL_IDS = 100;
/** Minimum edge strength×confidence to follow an edge (D-3). */
export const DEFAULT_TRAVERSAL_MIN_EDGE_WEIGHT = 0.3;
/** Hard traversal timeout in ms (D-3). */
export const DEFAULT_TRAVERSAL_TIMEOUT_MS = 500;

// ── D-4 reranker (007d / PRD-047b) ──────────────────────────────────────────
/**
 * The default reranker strategy. PRD-047b shipped the embedding-cosine rerank stage
 * fully wired + tested, then MEASURED it on the live graded golden set (b-AC-3,
 * 2026-06-24): rerank-on recall@5/MRR/nDCG sat INSIDE the RRF-only noise band
 * (recall@5 0.611 vs RRF 0.611–0.639) — i.e. ~0 lift on the synthetic instrument,
 * exactly the risk b-AC-3 pre-registered ("cosine rerank ≈ the `<#>` arm signal; if
 * the lift is ~0, drop rerank to `none` by default — the eval decides"). So the
 * DEFAULT is `none` (keep the proven RRF order; don't pay a per-recall embedding
 * batch-fetch + cosine for no measured gain). `embedding-cosine` and `llm` remain
 * fully implemented + activatable via config/env; revisit when a stronger instrument
 * (graded multi-id eval or dogfood) demonstrates the lift. See
 * `reports/2026-06-24-reranker-activation-eval.md`.
 */
export const DEFAULT_RERANKER = "none" as const;
/** Reranker timeout in ms; on timeout the original order is kept (D-4 / d-AC-2 / b-AC-2). */
export const DEFAULT_RERANKER_TIMEOUT_MS = 300;
/**
 * The PROVIDER-reranker timeout in ms (PRD-063c / c-AC-3). The local `embedding-cosine` rerank is a
 * single in-process DeepLake batch-fetch + cosine, so {@link DEFAULT_RERANKER_TIMEOUT_MS} = 300ms is
 * a tight, correct budget. The `cohere` strategy instead makes an OUTBOUND HTTP round-trip to the
 * Portkey gateway on EVERY recall, which needs more headroom, so it carries its OWN, larger budget.
 * `1000ms` is the documented default (the conscious latency/cost trade-off of an external reranker —
 * a slow gateway adds AT MOST this to a recall, then FAILS SOFT to the RRF order, never a hang); it
 * is env-overridable (`HONEYCOMB_RECALL_RERANKER_PROVIDER_TIMEOUT_MS`) + clamped, and is tuned by the
 * recall-quality eval (c-OQ-2) against a real Portkey+Cohere round-trip. The local-cosine path keeps
 * the 300ms budget unchanged (c-AC-4: byte-identical when the strategy is not `cohere`).
 */
export const DEFAULT_RERANKER_PROVIDER_TIMEOUT_MS = 1000;
/**
 * The Cohere rerank `model` id sent to Portkey's `POST /v1/rerank` when the strategy is `cohere`
 * (PRD-063c / c-D-1). The operator ULTIMATELY configures the rerank model inside Portkey (the
 * gateway may route/override it), but Honeycomb still sends a concrete, named default so the wire
 * shape is honest and a fake-fetch test can assert it; it is env-overridable
 * (`HONEYCOMB_RECALL_RERANKER_COHERE_MODEL`).
 *
 * `rerank-v3.5` is the current stable GA Cohere rerank model id. CONFIRM vs the live Cohere/Portkey
 * docs at build: Cohere also publishes a `rerank-v4.0` family (e.g. `rerank-v4.0-pro`); when the
 * operator wants v4 they set the env override (or configure it in Portkey). The request/response
 * shape (`{ model, query, documents, top_n }` → `{ results: [{ index, relevance_score }] }`) is
 * identical across the v3.5 / v4.0 ids, so the default choice is a tuning/cost decision, not a
 * wire-compat one.
 */
export const DEFAULT_RERANKER_COHERE_MODEL = "rerank-v3.5";
/**
 * The rerank WINDOW N (PRD-047b): the count of fused top-N candidates the reranker
 * re-scores. A tuned knob — large enough to recover the magnitude RRF discarded
 * across a realistic recall window, small enough that the one guarded embedding
 * batch-fetch stays cheap. 50 is the documented default; env-overridable + clamped.
 */
export const DEFAULT_RERANKER_WINDOW = 50;

// ── PRD-047c — semantic / near-duplicate dedup ──────────────────────────────
/**
 * Semantic dedup is ON by default (PRD-047c / c-AC-3). It is the direct fix for the
 * eval's known ~12-clone problem and is neutral-or-better: the recall-eval scores a
 * relevance CLASS, so collapsing a class of paraphrases to its ONE highest-provenance
 * copy keeps recall@5/MRR/nDCG at-or-above baseline while freeing top-k slots for
 * distinct facts. A caller passes `{ enabled: false }` for the escape hatch.
 */
export const DEFAULT_DEDUP_ENABLED = true;
/**
 * The cosine-similarity threshold (0..1, the normalized {@link cosineSimilarity} range)
 * above which two candidate embeddings are treated as the SAME fact and collapsed
 * (PRD-047c / c-AC-1). Tuned HIGH by design (err toward NOT merging): only obvious
 * paraphrases exceed ~0.9, so two semantically DISTINCT facts stay below it and BOTH
 * survive (the c-AC-2 false-merge guard). An eval-tunable named knob, mirroring the
 * rerank window; env-overridable + clamped to `[0,1]`.
 */
export const DEFAULT_DEDUP_SIMILARITY_THRESHOLD = 0.9;

// ── PRD-047d — recency dampening (multiplicative age-decay on the fused score) ─
/**
 * The recency half-life in DAYS (PRD-047d / d-AC-4): the age at which a hit's fused
 * score is multiplied by 0.5 under `decay = 0.5 ^ (age_days / half_life_days)`. A
 * single named, eval-tunable knob (like {@link DEFAULT_RERANKER_WINDOW} / the dedup
 * threshold), env-overridable + clamped.
 *
 * The DEFAULT is OFF-EQUIVALENT by design (d-AC-4): `36500` days (100 years) makes the
 * decay multiplier ≈ 1 for every realistic row — even a year-old row is demoted by only
 * `1 - 0.5^(365/36500) = 1 - 0.5^0.01 ≈ 0.0069` (< 0.7%), i.e. NEUTRAL on the age-agnostic
 * synthetic golden set, so recall@5/MRR/nDCG hold at-or-above baseline BY CONSTRUCTION until
 * the eval picks a real value ("defaulting to OFF-equivalent … so the change is measured
 * before it bites"). A small positive half-life (e.g. 30/90 days) is the live tuning lever.
 * `0` / negative / non-numeric is clamped UP to {@link MIN_RECENCY_HALF_LIFE_DAYS} so the
 * dampener can never divide by zero or invert (a typo never bites; it just runs near-off).
 */
export const DEFAULT_RECENCY_HALF_LIFE_DAYS = 36_500;
/** The floor for the recency half-life: a sub-1-day half-life is clamped up (no div-by-zero / inversion). */
export const MIN_RECENCY_HALF_LIFE_DAYS = 1;

// ── PRD-058a, class-aware recency activation (the `A(m,t)` Stage-1 term) ──────
/**
 * The per-CLASS recency half-lives in DAYS (PRD-058a, AC-55a.2.1 / 55a.2.3). PRD-058a promotes
 * recency from the OFF-equivalent neutral knob (PRD-047d, {@link DEFAULT_RECENCY_HALF_LIFE_DAYS})
 * into a measured, class-aware default: a hit's half-life is chosen by the TABLE that surfaced it
 * ({@link import("../memories/recall.js").RecallSource}), so durable distilled facts decay slower
 * than ephemeral raw dialogue.
 *
 *  - `memories` (kept, distilled facts): the slowest decay, `180 d`.
 *  - `memory` (AI session summaries): faster, `45 d`.
 *  - `sessions` (raw captured turns): the fastest, `10 d`.
 *
 * The ordering `h(sessions) < h(memory) < h(memories)` is the load-bearing invariant (AC-55a.2.1):
 * at equal age a raw `sessions` hit is penalized harder than a distilled `memories` hit. These are
 * the STARTING points from the scoring model; the eval sweep (PRD-058a Test Plan) finalizes them.
 * A class with NO configured half-life falls back to ITS documented default here, NEVER to the
 * 100-year neutral value (AC-55a.2.3).
 */
export const DEFAULT_RECENCY_HALF_LIFE_DAYS_BY_CLASS = Object.freeze({
	memories: 180,
	memory: 45,
	sessions: 10,
} as const);

/**
 * The default activation exponent `a` in the master equation's `A^a` contribution (PRD-058a). `1.0`
 * applies the raw activation multiplier; `0` is neutral (`A^0 = 1`, recency off); a value in `(0,1)`
 * gentles the demotion. The eval freshness-slice sweep decides whether `1.0` ships or a softer value
 * does (PRD-058a open question). A single named, eval-tunable knob, env-overridable + clamped `≥ 0`.
 */
export const DEFAULT_RECENCY_ACTIVATION_EXPONENT = 1.0;

// ── PRD-047e — token-budget + MMR context assembly ───────────────────────────
/**
 * The MMR relevance/diversity trade-off knob λ (PRD-047e / e-AC-2). MMR selects the next
 * hit by `argmax [ λ·rel(d) − (1−λ)·max_{s∈selected} sim(d,s) ]`: λ near 1 favors pure
 * relevance (the fused/dampened score), λ near 0 favors maximal diversity from what is
 * already selected. The DEFAULT is `0.7` — relevance-favoring by design, the PRD risk
 * mitigation ("λ tuned high (relevance-favoring)") so diversity only re-orders the tail,
 * never the head. A single named, eval-tunable knob (like the dedup threshold / recency
 * half-life); env-overridable + clamped to `[0,1]`. It bites ONLY when the caller supplies
 * a `tokenBudget` — the row-`limit` path never builds an MMR selection (e-AC-4).
 */
export const DEFAULT_MMR_LAMBDA = 0.7;

// ── D-5 dampening (007d) ────────────────────────────────────────────────────
/** Gravity dampening factor for a semantic hit sharing no query terms (D-5 / d-AC-4). */
export const DEFAULT_GRAVITY_DAMPENING = 0.5;
/** Hub dampening factor for a result off a very high-degree entity (D-5 / d-AC-5). */
export const DEFAULT_HUB_DAMPENING = 0.5;
/** Resolution boost for a decision/constraint memory (D-5 / d-AC-6). */
export const DEFAULT_RESOLUTION_BOOST = 1.25;
/** Bounded rehearsal boost for a recently-accessed memory (D-5). */
export const DEFAULT_REHEARSAL_BOOST = 1.1;
/** "Recent" window for the rehearsal boost in ms (7d, D-5). */
export const DEFAULT_REHEARSAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

// ── D-6 injection gate (007e) ───────────────────────────────────────────────
/** Minimum calibrated score for injection (D-6 / e-AC-1); per-agent tunable. */
export const DEFAULT_MIN_INJECTION_SCORE = 0.6;

/**
 * The reranker strategies the gate/shaper recognize (D-4 + PRD-063c).
 *   - `embedding-cosine` — the LOCAL in-process cosine rerank (PRD-047b), fully wired + tested.
 *   - `llm`              — a measured follow-up token (not built; falls through to RRF until it lands).
 *   - `cohere`           — the FIRST provider reranker (PRD-063c): Cohere via the Portkey gateway. It
 *                          activates ONLY when `portkey.enabled` AND the strategy is `cohere`; any
 *                          failure (timeout, HTTP error, unreachable, malformed, missing key) FAILS
 *                          SOFT to the RRF order (c-AC-3).
 *   - `none`             — the RRF-only escape hatch (the {@link DEFAULT_RERANKER}).
 */
export const RERANKER_STRATEGIES = Object.freeze(["embedding-cosine", "llm", "cohere", "none"] as const);
/** A reranker strategy token. */
export type RerankerStrategy = (typeof RERANKER_STRATEGIES)[number];

/** A boolean flag read from an env string: `true`/`1` → true, anything else → false. */
const BoolFlag = z.preprocess((raw) => {
	if (typeof raw === "boolean") return raw;
	// TRIM before comparing: env values routinely arrive with surrounding whitespace (a Windows
	// scheduled-task `set "VAR=true" && …` chain) — without it an exact `=== "true"` read `"true "` as
	// FALSE (the same trailing-space class as the APIARY_HOME bug). Duplicated helper; shared-helper follow-up.
	const s = typeof raw === "string" ? raw.trim() : raw;
	return s === "true" || s === "1";
}, z.boolean());

/**
 * A non-negative-integer tuning knob: a non-numeric value falls back to the
 * default, a value below `min` is clamped up to `min`. Used for caps/limits/
 * windows — a typo is tuning noise, never a config failure.
 */
function ClampedInt(def: number, min = 0) {
	return z.preprocess((raw) => {
		const n = typeof raw === "number" ? raw : Number(raw);
		if (!Number.isFinite(n)) return def;
		return Math.max(min, Math.trunc(n));
	}, z.number().int());
}

/**
 * A `[0, ceil]` float knob (scores/weights): a non-numeric value falls back to
 * the default; an out-of-range value is clamped. `ceil` defaults to 1 (a score)
 * but boosts use a higher ceiling.
 */
function ClampedFloat(def: number, ceil = 1) {
	return z.preprocess((raw) => {
		const n = typeof raw === "number" ? raw : Number(raw);
		if (!Number.isFinite(n)) return def;
		return Math.min(Math.max(0, n), ceil);
	}, z.number());
}

/**
 * The recency half-life knob (PRD-047d): a float in `[min, +∞)` DAYS. A non-numeric
 * value falls back to the default; a value below `min` is clamped UP to `min` so the
 * decay function can never divide by zero or invert (`0`/negative → near-off, not a
 * crash). No upper clamp — a very large half-life IS the OFF-equivalent default.
 */
function ClampedHalfLifeDays(def: number, min: number) {
	return z.preprocess((raw) => {
		const n = typeof raw === "number" ? raw : Number(raw);
		if (!Number.isFinite(n)) return def;
		return Math.max(min, n);
	}, z.number());
}

/**
 * An OPTIONAL per-class half-life knob (PRD-058a): a positive float in DAYS, or `undefined` when the
 * class is not configured. UNLIKE {@link ClampedHalfLifeDays} this carries NO numeric default, an
 * absent or unparseable value resolves to `undefined`, which the runtime reads as "use the DOCUMENTED
 * per-class default" ({@link DEFAULT_RECENCY_HALF_LIFE_DAYS_BY_CLASS}, AC-55a.2.3), never the neutral
 * 100-year value. A present-but-too-small value is clamped UP to `min` so the decay can never divide
 * by zero or invert (a typo never bites).
 */
function OptionalClampedHalfLifeDays(min: number) {
	return z.preprocess((raw) => {
		if (raw === undefined || raw === null || raw === "") return undefined;
		const n = typeof raw === "number" ? raw : Number(raw);
		if (!Number.isFinite(n)) return undefined; // unparseable → fall back to the documented default.
		return Math.max(min, n);
	}, z.number().positive().optional());
}

/** D-3 traversal budgets, grouped so the traversal phase reads one object. */
export const TraversalConfigSchema = z.object({
	/** Max aspects per focal entity. */
	aspectsPerEntity: ClampedInt(DEFAULT_TRAVERSAL_ASPECTS_PER_ENTITY, 1).default(DEFAULT_TRAVERSAL_ASPECTS_PER_ENTITY),
	/** Max attributes per aspect. */
	attrsPerAspect: ClampedInt(DEFAULT_TRAVERSAL_ATTRS_PER_ASPECT, 1).default(DEFAULT_TRAVERSAL_ATTRS_PER_ASPECT),
	/** Max branching factor per node. */
	branching: ClampedInt(DEFAULT_TRAVERSAL_BRANCHING, 1).default(DEFAULT_TRAVERSAL_BRANCHING),
	/** Hard cap on total IDs the walk may collect. */
	totalIds: ClampedInt(DEFAULT_TRAVERSAL_TOTAL_IDS, 1).default(DEFAULT_TRAVERSAL_TOTAL_IDS),
	/** Minimum edge strength×confidence to follow an edge. */
	minEdgeWeight: ClampedFloat(DEFAULT_TRAVERSAL_MIN_EDGE_WEIGHT).default(DEFAULT_TRAVERSAL_MIN_EDGE_WEIGHT),
	/** Hard traversal timeout in ms. */
	timeoutMs: ClampedInt(DEFAULT_TRAVERSAL_TIMEOUT_MS, 1).default(DEFAULT_TRAVERSAL_TIMEOUT_MS),
});

/** D-4 reranker config, grouped so the shaping phase reads one object. */
export const RerankerConfigSchema = z.object({
	/** The reranker strategy (D-4 + PRD-063c). */
	strategy: z.enum(RERANKER_STRATEGIES).default(DEFAULT_RERANKER),
	/** Reranker timeout in ms; on timeout keep the original order (d-AC-2 / b-AC-2). LOCAL-cosine budget. */
	timeoutMs: ClampedInt(DEFAULT_RERANKER_TIMEOUT_MS, 1).default(DEFAULT_RERANKER_TIMEOUT_MS),
	/**
	 * The PROVIDER-rerank timeout in ms (PRD-063c / c-AC-3): the budget for the `cohere` outbound
	 * Portkey round-trip, larger than the local-cosine {@link timeoutMs} because it crosses the
	 * network. A `cohere` call that exceeds it FAILS SOFT to the RRF order. Defaults to
	 * {@link DEFAULT_RERANKER_PROVIDER_TIMEOUT_MS} (1000ms); the local-cosine path never reads it.
	 */
	providerTimeoutMs: ClampedInt(DEFAULT_RERANKER_PROVIDER_TIMEOUT_MS, 1).default(DEFAULT_RERANKER_PROVIDER_TIMEOUT_MS),
	/** Rerank window N: how many fused top-N candidates to re-score (PRD-047b). */
	window: ClampedInt(DEFAULT_RERANKER_WINDOW, 1).default(DEFAULT_RERANKER_WINDOW),
	/**
	 * The Cohere rerank `model` id sent to Portkey when the strategy is `cohere` (PRD-063c / c-D-1).
	 * Defaults to {@link DEFAULT_RERANKER_COHERE_MODEL}; the operator may override it (or configure
	 * the model inside Portkey). A non-string env value falls back to the default. Only the `cohere`
	 * strategy reads it.
	 */
	cohereModel: z.string().min(1).catch(DEFAULT_RERANKER_COHERE_MODEL).default(DEFAULT_RERANKER_COHERE_MODEL),
});

/** PRD-047c dedup config, grouped so the recall adapter reads one object. */
export const DedupConfigSchema = z.object({
	/** Whether semantic near-duplicate dedup runs; ON by default (PRD-047c / c-AC-3). */
	enabled: BoolFlag.default(DEFAULT_DEDUP_ENABLED),
	/** The cosine-similarity collapse threshold in `[0,1]` (PRD-047c / c-AC-1). */
	similarityThreshold: ClampedFloat(DEFAULT_DEDUP_SIMILARITY_THRESHOLD).default(DEFAULT_DEDUP_SIMILARITY_THRESHOLD),
});

/**
 * The per-class half-life sub-config (PRD-058a, AC-55a.2.1 / 55a.2.2). Every class is OPTIONAL: a
 * configured class uses its value, an UNCONFIGURED class falls back at runtime to the documented
 * default ({@link DEFAULT_RECENCY_HALF_LIFE_DAYS_BY_CLASS}, AC-55a.2.3), never the neutral 100-year
 * value. A caller's `memory.lifecycle.halfLifeDaysByClass` override (or the per-request override)
 * is honored over the defaults (AC-55a.2.2).
 */
export const RecencyHalfLifeByClassSchema = z.object({
	/** Half-life in DAYS for the `memories` (kept, distilled facts) class; absent → documented default. */
	memories: OptionalClampedHalfLifeDays(MIN_RECENCY_HALF_LIFE_DAYS),
	/** Half-life in DAYS for the `memory` (AI session summaries) class; absent → documented default. */
	memory: OptionalClampedHalfLifeDays(MIN_RECENCY_HALF_LIFE_DAYS),
	/** Half-life in DAYS for the `sessions` (raw captured turns) class; absent → documented default. */
	sessions: OptionalClampedHalfLifeDays(MIN_RECENCY_HALF_LIFE_DAYS),
});

/**
 * PRD-047d + PRD-058a recency config, grouped so the recall adapter reads one object.
 *
 * PRD-058a (the `A(m,t)` Stage-1 term) layers CLASS-AWARE decay on top of the original PRD-047d flat
 * knob. The live recency stage prefers `halfLifeDaysByClass[class]` (or the documented per-class
 * default when a class is unconfigured), and applies the contribution `A^activationExponent`. The
 * legacy flat {@link halfLifeDays} remains a BACK-COMPAT fallback only (consumed by the original
 * {@link import("../memories/recall.js").applyRecencyDampening} path + its suite); it is NOT the live
 * default anymore (AC-55a.2.3 forbids the 100-year neutral as a class fallback).
 */
export const RecencyConfigSchema = z.object({
	/**
	 * The legacy flat recency half-life in DAYS (PRD-047d / d-AC-4); OFF-equivalent by default. Retained
	 * as a back-compat fallback for the flat {@link import("../memories/recall.js").applyRecencyDampening}
	 * path only, the live PRD-058a stage reads {@link halfLifeDaysByClass} + the documented per-class
	 * defaults instead, so this neutral value is never a CLASS fallback (AC-55a.2.3).
	 */
	halfLifeDays: ClampedHalfLifeDays(DEFAULT_RECENCY_HALF_LIFE_DAYS, MIN_RECENCY_HALF_LIFE_DAYS).default(
		DEFAULT_RECENCY_HALF_LIFE_DAYS,
	),
	/** Per-class half-lives (PRD-058a); an unconfigured class falls back to its documented default. */
	halfLifeDaysByClass: RecencyHalfLifeByClassSchema.default(() => RecencyHalfLifeByClassSchema.parse({})),
	/** The activation exponent `a` in `A^a` (PRD-058a); `1.0` default, `0` neutral, clamped `≥ 0`. */
	activationExponent: ClampedFloat(DEFAULT_RECENCY_ACTIVATION_EXPONENT, Number.POSITIVE_INFINITY).default(
		DEFAULT_RECENCY_ACTIVATION_EXPONENT,
	),
});

/** PRD-047e context-assembly config (token-budget + MMR), grouped so the recall adapter reads one object. */
export const ContextAssemblyConfigSchema = z.object({
	/** The MMR relevance/diversity λ in `[0,1]` (PRD-047e / e-AC-2); relevance-favoring by default. */
	mmrLambda: ClampedFloat(DEFAULT_MMR_LAMBDA).default(DEFAULT_MMR_LAMBDA),
});

/** D-5 dampening/boost factors, grouped so the shaping phase reads one object. */
export const DampeningConfigSchema = z.object({
	/** Gravity dampening for a semantic hit sharing no query terms (d-AC-4). */
	gravity: ClampedFloat(DEFAULT_GRAVITY_DAMPENING).default(DEFAULT_GRAVITY_DAMPENING),
	/** Hub dampening for a result off a very high-degree entity (d-AC-5). */
	hub: ClampedFloat(DEFAULT_HUB_DAMPENING).default(DEFAULT_HUB_DAMPENING),
	/** Resolution boost for a decision/constraint memory (d-AC-6). Ceiling 4. */
	resolutionBoost: ClampedFloat(DEFAULT_RESOLUTION_BOOST, 4).default(DEFAULT_RESOLUTION_BOOST),
	/** Bounded rehearsal boost for a recently-accessed memory. Ceiling 4. */
	rehearsalBoost: ClampedFloat(DEFAULT_REHEARSAL_BOOST, 4).default(DEFAULT_REHEARSAL_BOOST),
	/** "Recent" window for the rehearsal boost in ms (7d). */
	rehearsalWindowMs: ClampedInt(DEFAULT_REHEARSAL_WINDOW_MS, 1).default(DEFAULT_REHEARSAL_WINDOW_MS),
});

/**
 * The validated recall config every phase reads. Resolved once and injected; a
 * phase takes the resolved `RecallConfig` as a dep, never re-resolves it.
 */
export const RecallConfigSchema = z.object({
	/** Over-fetch multiplier for scoped vector recalls (D-1 / a-AC-2 / FR-5). */
	overFetchMultiplier: ClampedInt(DEFAULT_OVER_FETCH_MULTIPLIER, 1).default(DEFAULT_OVER_FETCH_MULTIPLIER),
	/** Base per-channel candidate limit (FTS/vector base, pre over-fetch). */
	channelLimit: ClampedInt(DEFAULT_CHANNEL_LIMIT, 1).default(DEFAULT_CHANNEL_LIMIT),
	/** Hint cap so a memory can't ride in on hints alone (D-2 / a-AC-4 / FR-7). */
	hintCap: ClampedInt(DEFAULT_HINT_CAP, 0).default(DEFAULT_HINT_CAP),
	/** Keyword expansion for the LEXICAL path only; OFF by default (D-2 / FR-2). */
	keywordExpansion: BoolFlag.default(false),
	/** Minimum calibrated injection score (D-6 / e-AC-1); per-agent tunable. */
	minInjectionScore: ClampedFloat(DEFAULT_MIN_INJECTION_SCORE).default(DEFAULT_MIN_INJECTION_SCORE),
	/** Master graph switch for the traversal channel/phase (007b). */
	graphEnabled: BoolFlag.default(false),
	/** D-3 traversal budgets (007b). */
	traversal: TraversalConfigSchema.default(() => TraversalConfigSchema.parse({})),
	/** D-4 reranker config (007d). */
	reranker: RerankerConfigSchema.default(() => RerankerConfigSchema.parse({})),
	/** D-5 dampening/boost factors (007d). */
	dampening: DampeningConfigSchema.default(() => DampeningConfigSchema.parse({})),
	/** PRD-047c semantic near-duplicate dedup (ON by default). */
	dedup: DedupConfigSchema.default(() => DedupConfigSchema.parse({})),
	/** PRD-047d recency dampening (OFF-equivalent half-life by default). */
	recency: RecencyConfigSchema.default(() => RecencyConfigSchema.parse({})),
	/** PRD-047e token-budget + MMR context assembly (engages only when a tokenBudget is supplied). */
	contextAssembly: ContextAssemblyConfigSchema.default(() => ContextAssemblyConfigSchema.parse({})),
});

/** The validated recall config object every phase consumes. */
export type RecallConfig = z.infer<typeof RecallConfigSchema>;
/** The validated traversal sub-config. */
export type TraversalConfig = z.infer<typeof TraversalConfigSchema>;
/** The validated reranker sub-config. */
export type RerankerConfig = z.infer<typeof RerankerConfigSchema>;
/** The validated dampening sub-config. */
export type DampeningConfig = z.infer<typeof DampeningConfigSchema>;
/** The validated dedup sub-config (PRD-047c). */
export type DedupConfig = z.infer<typeof DedupConfigSchema>;
/** The validated recency sub-config (PRD-047d + PRD-058a). */
export type RecencyConfig = z.infer<typeof RecencyConfigSchema>;
/** The validated per-class half-life sub-config (PRD-058a). */
export type RecencyHalfLifeByClass = z.infer<typeof RecencyHalfLifeByClassSchema>;
/** The validated context-assembly sub-config (PRD-047e). */
export type ContextAssemblyConfig = z.infer<typeof ContextAssemblyConfigSchema>;

/**
 * Structured recall-config error. Carries the flattened zod issues so the daemon
 * logs exactly which knob failed. Distinct type so a recall-config failure is
 * never mistaken for a runtime request failure (mirrors `PipelineConfigError`).
 */
export class RecallConfigError extends Error {
	readonly issues: string[];
	constructor(issues: string[]) {
		super(`Invalid recall config: ${issues.join("; ")}`);
		this.name = "RecallConfigError";
		this.issues = issues;
	}
}

/**
 * The recall-config provider seam (mirrors `PipelineConfigProvider`). Returns the
 * raw, un-validated record so validation is the schema's job (one boundary). The
 * env provider is the default; a test injects a fixed record.
 */
export interface RecallConfigProvider {
	/** Read the raw recall-config record. Missing keys yield undefined. */
	read(): RawRecallConfig;
}

/** The raw, un-validated shape the provider yields. */
export interface RawRecallConfig {
	readonly overFetchMultiplier?: unknown;
	readonly channelLimit?: unknown;
	readonly hintCap?: unknown;
	readonly keywordExpansion?: unknown;
	readonly minInjectionScore?: unknown;
	readonly graphEnabled?: unknown;
	readonly traversal?: {
		readonly aspectsPerEntity?: unknown;
		readonly attrsPerAspect?: unknown;
		readonly branching?: unknown;
		readonly totalIds?: unknown;
		readonly minEdgeWeight?: unknown;
		readonly timeoutMs?: unknown;
	};
	readonly reranker?: {
		readonly strategy?: unknown;
		readonly timeoutMs?: unknown;
		readonly providerTimeoutMs?: unknown;
		readonly window?: unknown;
		readonly cohereModel?: unknown;
	};
	readonly dampening?: {
		readonly gravity?: unknown;
		readonly hub?: unknown;
		readonly resolutionBoost?: unknown;
		readonly rehearsalBoost?: unknown;
		readonly rehearsalWindowMs?: unknown;
	};
	readonly dedup?: {
		readonly enabled?: unknown;
		readonly similarityThreshold?: unknown;
	};
	readonly recency?: {
		readonly halfLifeDays?: unknown;
		readonly halfLifeDaysByClass?: {
			readonly memories?: unknown;
			readonly memory?: unknown;
			readonly sessions?: unknown;
		};
		readonly activationExponent?: unknown;
	};
	readonly contextAssembly?: {
		readonly mmrLambda?: unknown;
	};
}

/**
 * Default provider: reads `HONEYCOMB_RECALL_*` from the environment. Daemon-only
 * code (never bundled into the OpenClaw target, which forbids `process.env`), so
 * a direct env read is correct here — mirrors `envPipelineConfigProvider`.
 */
export function envRecallConfigProvider(env: NodeJS.ProcessEnv = process.env): RecallConfigProvider {
	return {
		read(): RawRecallConfig {
			return {
				overFetchMultiplier: env.HONEYCOMB_RECALL_OVER_FETCH_MULTIPLIER,
				channelLimit: env.HONEYCOMB_RECALL_CHANNEL_LIMIT,
				hintCap: env.HONEYCOMB_RECALL_HINT_CAP,
				keywordExpansion: env.HONEYCOMB_RECALL_KEYWORD_EXPANSION,
				minInjectionScore: env.HONEYCOMB_RECALL_MIN_INJECTION_SCORE,
				graphEnabled: env.HONEYCOMB_RECALL_GRAPH_ENABLED,
				traversal: {
					aspectsPerEntity: env.HONEYCOMB_RECALL_TRAVERSAL_ASPECTS_PER_ENTITY,
					attrsPerAspect: env.HONEYCOMB_RECALL_TRAVERSAL_ATTRS_PER_ASPECT,
					branching: env.HONEYCOMB_RECALL_TRAVERSAL_BRANCHING,
					totalIds: env.HONEYCOMB_RECALL_TRAVERSAL_TOTAL_IDS,
					minEdgeWeight: env.HONEYCOMB_RECALL_TRAVERSAL_MIN_EDGE_WEIGHT,
					timeoutMs: env.HONEYCOMB_RECALL_TRAVERSAL_TIMEOUT_MS,
				},
				reranker: {
					strategy: env.HONEYCOMB_RECALL_RERANKER,
					timeoutMs: env.HONEYCOMB_RECALL_RERANKER_TIMEOUT_MS,
					providerTimeoutMs: env.HONEYCOMB_RECALL_RERANKER_PROVIDER_TIMEOUT_MS,
					window: env.HONEYCOMB_RECALL_RERANKER_WINDOW,
					cohereModel: env.HONEYCOMB_RECALL_RERANKER_COHERE_MODEL,
				},
				dampening: {
					gravity: env.HONEYCOMB_RECALL_DAMPENING_GRAVITY,
					hub: env.HONEYCOMB_RECALL_DAMPENING_HUB,
					resolutionBoost: env.HONEYCOMB_RECALL_RESOLUTION_BOOST,
					rehearsalBoost: env.HONEYCOMB_RECALL_REHEARSAL_BOOST,
					rehearsalWindowMs: env.HONEYCOMB_RECALL_REHEARSAL_WINDOW_MS,
				},
				dedup: {
					enabled: env.HONEYCOMB_RECALL_DEDUP_ENABLED,
					similarityThreshold: env.HONEYCOMB_RECALL_DEDUP_SIMILARITY_THRESHOLD,
				},
				recency: {
					halfLifeDays: env.HONEYCOMB_RECALL_RECENCY_HALF_LIFE_DAYS,
					// PRD-058a: per-class half-lives + the activation exponent. Each is optional, an
					// unset class env var resolves to undefined → the documented per-class default.
					halfLifeDaysByClass: {
						memories: env.HONEYCOMB_RECALL_RECENCY_HALF_LIFE_DAYS_MEMORIES,
						memory: env.HONEYCOMB_RECALL_RECENCY_HALF_LIFE_DAYS_MEMORY,
						sessions: env.HONEYCOMB_RECALL_RECENCY_HALF_LIFE_DAYS_SESSIONS,
					},
					activationExponent: env.HONEYCOMB_RECALL_RECENCY_ACTIVATION_EXPONENT,
				},
				contextAssembly: {
					mmrLambda: env.HONEYCOMB_RECALL_MMR_LAMBDA,
				},
			};
		},
	};
}

/**
 * Resolve the raw record into a validated `RecallConfig`. The schema defaults
 * every flag false-safe and clamps every knob, so resolution succeeds for nearly
 * any input — but a structurally-impossible value (e.g. an out-of-enum reranker
 * strategy passed explicitly) still throws `RecallConfigError` listing every
 * issue. This is the single boundary where untrusted env crosses into typed
 * recall config (zod-at-boundary discipline).
 */
export function resolveRecallConfig(provider: RecallConfigProvider = envRecallConfigProvider()): RecallConfig {
	const parsed = RecallConfigSchema.safeParse(provider.read());
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
		throw new RecallConfigError(issues);
	}
	return parsed.data;
}
