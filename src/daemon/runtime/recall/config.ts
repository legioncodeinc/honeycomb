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

// ── D-4 reranker (007d) ─────────────────────────────────────────────────────
/** The default reranker strategy (D-4): embedding-cosine. LLM rerank is opt-in. */
export const DEFAULT_RERANKER = "embedding-cosine" as const;
/** Reranker timeout in ms; on timeout the original order is kept (D-4 / d-AC-2). */
export const DEFAULT_RERANKER_TIMEOUT_MS = 300;

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

/** The reranker strategies the gate/shaper recognize (D-4). */
export const RERANKER_STRATEGIES = Object.freeze(["embedding-cosine", "llm", "none"] as const);
/** A reranker strategy token. */
export type RerankerStrategy = (typeof RERANKER_STRATEGIES)[number];

/** A boolean flag read from an env string: `true`/`1` → true, anything else → false. */
const BoolFlag = z.preprocess((raw) => {
	if (typeof raw === "boolean") return raw;
	return raw === "true" || raw === "1";
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
	/** The reranker strategy (D-4). */
	strategy: z.enum(RERANKER_STRATEGIES).default(DEFAULT_RERANKER),
	/** Reranker timeout in ms; on timeout keep the original order (d-AC-2). */
	timeoutMs: ClampedInt(DEFAULT_RERANKER_TIMEOUT_MS, 1).default(DEFAULT_RERANKER_TIMEOUT_MS),
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
});

/** The validated recall config object every phase consumes. */
export type RecallConfig = z.infer<typeof RecallConfigSchema>;
/** The validated traversal sub-config. */
export type TraversalConfig = z.infer<typeof TraversalConfigSchema>;
/** The validated reranker sub-config. */
export type RerankerConfig = z.infer<typeof RerankerConfigSchema>;
/** The validated dampening sub-config. */
export type DampeningConfig = z.infer<typeof DampeningConfigSchema>;

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
	};
	readonly dampening?: {
		readonly gravity?: unknown;
		readonly hub?: unknown;
		readonly resolutionBoost?: unknown;
		readonly rehearsalBoost?: unknown;
		readonly rehearsalWindowMs?: unknown;
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
				},
				dampening: {
					gravity: env.HONEYCOMB_RECALL_DAMPENING_GRAVITY,
					hub: env.HONEYCOMB_RECALL_DAMPENING_HUB,
					resolutionBoost: env.HONEYCOMB_RECALL_RESOLUTION_BOOST,
					rehearsalBoost: env.HONEYCOMB_RECALL_REHEARSAL_BOOST,
					rehearsalWindowMs: env.HONEYCOMB_RECALL_REHEARSAL_WINDOW_MS,
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
