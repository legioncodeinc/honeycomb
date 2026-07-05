/**
 * PRD-058d — the single typed `memory.lifecycle.*` config module (the operator surface for the
 * four lifecycle engines: recency/activation 058a, conflicts 058b, stale-references 058c,
 * calibration 058e).
 *
 * This is the ONE place the lifecycle knobs live. It mirrors the recall `config.ts` /
 * pipeline `config.ts` precedent EXACTLY:
 *   - a provider SEAM ({@link LifecycleConfigProvider}) yields the raw, un-validated record;
 *   - ONE zod `safeParse` boundary ({@link resolveLifecycleConfig}) validates + coerces;
 *   - every knob is COERCE-AND-CLAMP (a fat-fingered env value falls back to its default or
 *     clamps to a floor — a typo is tuning noise, NEVER a daemon crash);
 *   - the env provider ({@link envLifecycleConfigProvider}) reads `HONEYCOMB_LIFECYCLE_*`,
 *     so env overrides yaml per-key and the documented defaults live in this one module.
 *
 * ── The precedence (mirrors `memory.pipelineV2` / `HONEYCOMB_PIPELINE_*` exactly) ───────────
 *   1. `HONEYCOMB_LIFECYCLE_*` env var  — wins per-key (the env provider reads it);
 *   2. `agent.yaml` `memory.lifecycle.*` value — the yaml-sourced provider supplies it;
 *   3. the documented default in THIS module — the schema `.default(...)` last.
 * There is no second precedence model and no scattered toggle. The yaml provider and the env
 * provider both yield a {@link RawLifecycleConfig}; {@link mergeRawLifecycle} layers env OVER
 * yaml per-key, and the schema fills any still-absent key with its documented default.
 *
 * ── NON-DESTRUCTIVE defaults (AC-55d.1.1) ───────────────────────────────────────────────────
 * A fresh install demotes NOTHING: `a = 1` (recency live but neutral-shaped), `c = 0` (confidence
 * dormant until calibrated), `s = 0` (stale-ref posture `observe` — visible but inert), and
 * conflict auto-resolve OFF (detect + queue only, never auto-supersede without a human). Every
 * term that can demote ships behind an exponent that defaults to the identity, so turning a term
 * ON is a deliberate, reversible operator action.
 *
 * ── Single-sourced WITHOUT duplicating the clamp logic (058d Technical Considerations) ──────
 * Where a knob ALSO exists on the recall config (the activation exponent `a`, the per-class
 * half-lives), this module is the lifecycle-FACING source of those values: {@link lifecycleRecency}
 * projects them into the {@link import("../recall/config.js").RecencyConfig} shape so the recall
 * stage consumes them through its OWN schema (which owns the clamp), with NO second competing
 * precedence model. The lifecycle module governs the knob; the recall schema still does the final
 * clamp at the recall boundary, so the clamp logic is not copy-pasted.
 */

import { z } from "zod";

import {
	DEFAULT_RECENCY_ACTIVATION_EXPONENT,
	DEFAULT_RECENCY_HALF_LIFE_DAYS_BY_CLASS,
	RecencyConfigSchema,
	type RecencyConfig,
} from "../recall/config.js";
import {
	DEFAULT_GAMMA,
	DEFAULT_RHO,
	DEFAULT_TAU_REVIEW,
	DEFAULT_TAU_SUPERSEDE,
} from "./conflict-resolve.js";
import { DEFAULT_THETA_DETECT } from "./conflict-detect.js";
import { DEFAULT_ACTR_PARAMS } from "./activation.js";
import { DEFAULT_H_VERIFY_DAYS } from "../maintenance/stale-ref-diagnostic.js";

// ── Documented defaults (the scoring-doc "Parameters and defaults" table, single-sourced) ────
//
// Every default below is re-exported from the OWNING module where one exists (so the lifecycle
// surface can never drift from the engine that consumes the value), or declared here when 058d
// is the first place a knob is named (the posture flags + the confidence/staleness exponents).

/** Activation exponent `a` in `A^a` (058a). `1.0` = raw activation, `0` = neutral. Default `1.0`. */
export const DEFAULT_ACTIVATION_EXPONENT = DEFAULT_RECENCY_ACTIVATION_EXPONENT; // 1.0
/** Confidence exponent `c` in `C^c` (058e). DORMANT (`0`) until calibration is proven. */
export const DEFAULT_CONFIDENCE_EXPONENT = 0;
/** Staleness exponent `s` in `(1 − σ)^s` (058c). `0` under `observe` (inert), `> 0` under `execute`. */
export const DEFAULT_STALENESS_EXPONENT = 0;
/** The `s` value applied once the stale-ref posture flips to `execute` (the scoring doc's `1`). */
export const EXECUTE_STALENESS_EXPONENT = 1;

/** Per-class half-lives `h(class)` in DAYS (058a): distilled 180 / summary 45 / raw 10. */
export const DEFAULT_HALF_LIFE_DAYS_BY_CLASS = DEFAULT_RECENCY_HALF_LIFE_DAYS_BY_CLASS;

/** ACT-R decay `d` (058e). Larger forgets faster. Default `0.5`. */
export const DEFAULT_ACTR_DECAY = DEFAULT_ACTR_PARAMS.decay; // 0.5
/** Activation floor `A_min` (058e) — even a cold memory keeps a sliver of salience. Default `0.05`. */
export const DEFAULT_ACTIVATION_FLOOR = DEFAULT_ACTR_PARAMS.aMin; // 0.05
/** Verification half-life `h_verify` in DAYS (058c) — decays trust in the last σ check. Default `14`. */
export const DEFAULT_VERIFICATION_HALF_LIFE_DAYS = DEFAULT_H_VERIFY_DAYS; // 14

/** Contradiction threshold `θ_detect` (058b) — gates conflict detection. Default `0.6`. */
export const DEFAULT_CONTRADICTION_THRESHOLD = DEFAULT_THETA_DETECT; // 0.6
/** Corroboration weight `γ` (058b) — shapes the conflict vote `w_i`. Default `0.5`. */
export const DEFAULT_CORROBORATION_WEIGHT = DEFAULT_GAMMA; // 0.5
/** Supersede margin `τ_supersede` (058b) — the conflict verdict cut. Default `0.5`. */
export const DEFAULT_SUPERSEDE_MARGIN = DEFAULT_TAU_SUPERSEDE; // 0.5
/** Review margin `τ_review` (058b) — the conflict verdict cut. Default `0.15`. */
export const DEFAULT_REVIEW_MARGIN = DEFAULT_TAU_REVIEW; // 0.15
/** Open-conflict suppression `ρ` (058b) — `κ` for the open-conflict loser. Default `0` (fully suppress, reversible). */
export const DEFAULT_OPEN_CONFLICT_SUPPRESSION = DEFAULT_RHO; // 0

/** Conflict auto-resolve posture (058b): OFF → detect + queue only (human-in-the-loop). Default OFF. */
export const DEFAULT_CONFLICT_AUTO_RESOLVE = false;
/** The stale-ref posture tokens (058c): `observe` (s = 0, inert) or `execute` (s > 0, demote). */
export const STALE_REF_POSTURES = Object.freeze(["observe", "execute"] as const);
/** One {@link STALE_REF_POSTURES} token. */
export type StaleRefPosture = (typeof STALE_REF_POSTURES)[number];
/** The default stale-ref posture: `observe` (compute σ, keep `s = 0`, visible but inert). */
export const DEFAULT_STALE_REF_POSTURE: StaleRefPosture = "observe";

// ── Coerce-and-clamp helpers (the SAME shapes the recall/pipeline configs use) ───────────────
//
// These are small and local on purpose: copy-pasting the recall module's `ClampedFloat`/`BoolFlag`
// wholesale would trip jscpd; re-deriving the tiny preprocess here keeps each config module
// self-contained while every knob still degrades on a typo rather than throwing.

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
 * A clamped float knob: a non-numeric value falls back to the default; an out-of-range value is
 * clamped into `[min, max]`. `min` defaults to `0`; `max` to `+∞` (exponents have no ceiling, the
 * `[0,1]`-bounded knobs pass `max = 1`). A typo is tuning noise, never a config failure.
 */
function ClampedFloat(def: number, max = Number.POSITIVE_INFINITY, min = 0) {
	return z.preprocess((raw) => {
		const n = typeof raw === "number" ? raw : Number(raw);
		if (!Number.isFinite(n)) return def;
		return Math.min(Math.max(min, n), max);
	}, z.number());
}

/** A positive-day knob (half-lives): non-numeric → default; a value below `1` clamps up to `1` (no div-by-zero). */
function ClampedDays(def: number) {
	return z.preprocess((raw) => {
		const n = typeof raw === "number" ? raw : Number(raw);
		if (!Number.isFinite(n)) return def;
		return Math.max(1, n);
	}, z.number());
}

/** The stale-ref posture, coerced: an unrecognized value falls back to `observe` (the safe default). */
const PostureFlag = z.preprocess((raw) => {
	return raw === "execute" ? "execute" : "observe";
}, z.enum(STALE_REF_POSTURES));

// ── The per-class half-life sub-schema (058a, every class optional → documented default) ─────

/** Per-class half-lives in DAYS (058a); an absent class falls back to its documented default at projection. */
export const LifecycleHalfLifeByClassSchema = z.object({
	memories: ClampedDays(DEFAULT_HALF_LIFE_DAYS_BY_CLASS.memories).default(DEFAULT_HALF_LIFE_DAYS_BY_CLASS.memories),
	memory: ClampedDays(DEFAULT_HALF_LIFE_DAYS_BY_CLASS.memory).default(DEFAULT_HALF_LIFE_DAYS_BY_CLASS.memory),
	sessions: ClampedDays(DEFAULT_HALF_LIFE_DAYS_BY_CLASS.sessions).default(DEFAULT_HALF_LIFE_DAYS_BY_CLASS.sessions),
});

// ── The validated lifecycle config every operator surface reads ──────────────────────────────

/**
 * The validated `memory.lifecycle.*` config. Resolved ONCE and injected; a surface takes the
 * resolved {@link LifecycleConfig} as a dep, never re-resolves it. Every exponent, every parameter
 * from the scoring-doc table, and the two posture flags live here, each defaulting non-destructively.
 */
export const LifecycleConfigSchema = z.object({
	/** Activation exponent `a` in `A^a` (058a); `1.0` default, `0` neutral, clamped `≥ 0`. */
	activationExponent: ClampedFloat(DEFAULT_ACTIVATION_EXPONENT).default(DEFAULT_ACTIVATION_EXPONENT),
	/** Confidence exponent `c` in `C^c` (058e); DORMANT `0` default, clamped `≥ 0`. */
	confidenceExponent: ClampedFloat(DEFAULT_CONFIDENCE_EXPONENT).default(DEFAULT_CONFIDENCE_EXPONENT),
	/** Staleness exponent `s` in `(1 − σ)^s` (058c); `0` default under `observe`, clamped `≥ 0`. */
	stalenessExponent: ClampedFloat(DEFAULT_STALENESS_EXPONENT).default(DEFAULT_STALENESS_EXPONENT),
	/** Per-class half-lives `h(class)` in DAYS (058a): distilled 180 / summary 45 / raw 10. */
	halfLifeDaysByClass: LifecycleHalfLifeByClassSchema.default(() => LifecycleHalfLifeByClassSchema.parse({})),
	/** ACT-R decay `d` (058e); `0.5` default, clamped `≥ 0`. */
	actrDecay: ClampedFloat(DEFAULT_ACTR_DECAY).default(DEFAULT_ACTR_DECAY),
	/** Activation floor `A_min` (058e); `0.05` default, clamped into `[0,1]`. */
	activationFloor: ClampedFloat(DEFAULT_ACTIVATION_FLOOR, 1).default(DEFAULT_ACTIVATION_FLOOR),
	/** Verification half-life `h_verify` in DAYS (058c); `14` default. */
	verificationHalfLifeDays: ClampedDays(DEFAULT_VERIFICATION_HALF_LIFE_DAYS).default(DEFAULT_VERIFICATION_HALF_LIFE_DAYS),
	/** Contradiction threshold `θ_detect` (058b); `0.6` default, clamped into `[0,1]`. */
	contradictionThreshold: ClampedFloat(DEFAULT_CONTRADICTION_THRESHOLD, 1).default(DEFAULT_CONTRADICTION_THRESHOLD),
	/** Corroboration weight `γ` (058b); `0.5` default, clamped `≥ 0`. */
	corroborationWeight: ClampedFloat(DEFAULT_CORROBORATION_WEIGHT).default(DEFAULT_CORROBORATION_WEIGHT),
	/** Supersede margin `τ_supersede` (058b); `0.5` default, clamped into `[0,1]`. */
	supersedeMargin: ClampedFloat(DEFAULT_SUPERSEDE_MARGIN, 1).default(DEFAULT_SUPERSEDE_MARGIN),
	/** Review margin `τ_review` (058b); `0.15` default, clamped into `[0,1]`. */
	reviewMargin: ClampedFloat(DEFAULT_REVIEW_MARGIN, 1).default(DEFAULT_REVIEW_MARGIN),
	/** Open-conflict suppression `ρ` (058b); `0` default (fully suppress, reversible), clamped into `[0,1]`. */
	openConflictSuppression: ClampedFloat(DEFAULT_OPEN_CONFLICT_SUPPRESSION, 1).default(DEFAULT_OPEN_CONFLICT_SUPPRESSION),
	/** Conflict auto-resolve (058b); OFF by default (detect + queue only, human-in-the-loop). */
	conflictAutoResolve: BoolFlag.default(DEFAULT_CONFLICT_AUTO_RESOLVE),
	/** Stale-ref posture (058c); `observe` by default (`s = 0`, inert). */
	staleRefPosture: PostureFlag.default(DEFAULT_STALE_REF_POSTURE),
});

/** The validated lifecycle config object every operator surface consumes. */
export type LifecycleConfig = z.infer<typeof LifecycleConfigSchema>;
/** The validated per-class half-life sub-config. */
export type LifecycleHalfLifeByClass = z.infer<typeof LifecycleHalfLifeByClassSchema>;

/**
 * Structured lifecycle-config error. Carries the flattened zod issues so the daemon logs exactly
 * which knob failed. Distinct type so a lifecycle-config failure is never mistaken for a runtime
 * request failure (mirrors `RecallConfigError` / `PipelineConfigError`).
 */
export class LifecycleConfigError extends Error {
	readonly issues: string[];
	constructor(issues: string[]) {
		super(`Invalid memory-lifecycle config: ${issues.join("; ")}`);
		this.name = "LifecycleConfigError";
		this.issues = issues;
	}
}

// ── The provider seam (mirrors RecallConfigProvider / PipelineConfigProvider) ────────────────

/** The raw, un-validated lifecycle-config shape a provider yields (every key optional → defaulted). */
export interface RawLifecycleConfig {
	readonly activationExponent?: unknown;
	readonly confidenceExponent?: unknown;
	readonly stalenessExponent?: unknown;
	readonly halfLifeDaysByClass?: {
		readonly memories?: unknown;
		readonly memory?: unknown;
		readonly sessions?: unknown;
	};
	readonly actrDecay?: unknown;
	readonly activationFloor?: unknown;
	readonly verificationHalfLifeDays?: unknown;
	readonly contradictionThreshold?: unknown;
	readonly corroborationWeight?: unknown;
	readonly supersedeMargin?: unknown;
	readonly reviewMargin?: unknown;
	readonly openConflictSuppression?: unknown;
	readonly conflictAutoResolve?: unknown;
	readonly staleRefPosture?: unknown;
}

/** The lifecycle-config provider seam. Returns the raw record so validation is the schema's job (one boundary). */
export interface LifecycleConfigProvider {
	/** Read the raw lifecycle-config record. Missing keys yield undefined. */
	read(): RawLifecycleConfig;
}

/**
 * The env provider: reads `HONEYCOMB_LIFECYCLE_*` from the environment. Daemon-only code (never
 * bundled into the OpenClaw target, which forbids `process.env`), so a direct env read is correct
 * here — mirrors `envRecallConfigProvider`. The flag names map to env keys with the
 * `HONEYCOMB_LIFECYCLE_` prefix; the per-class half-lives flatten to `HALFLIFE_<CLASS>_DAYS`.
 */
export function envLifecycleConfigProvider(env: NodeJS.ProcessEnv = process.env): LifecycleConfigProvider {
	return {
		read(): RawLifecycleConfig {
			return {
				activationExponent: env.HONEYCOMB_LIFECYCLE_ACTIVATION_EXPONENT,
				confidenceExponent: env.HONEYCOMB_LIFECYCLE_CONFIDENCE_EXPONENT,
				stalenessExponent: env.HONEYCOMB_LIFECYCLE_STALENESS_EXPONENT,
				halfLifeDaysByClass: {
					memories: env.HONEYCOMB_LIFECYCLE_HALFLIFE_MEMORIES_DAYS,
					memory: env.HONEYCOMB_LIFECYCLE_HALFLIFE_MEMORY_DAYS,
					sessions: env.HONEYCOMB_LIFECYCLE_HALFLIFE_SESSIONS_DAYS,
				},
				actrDecay: env.HONEYCOMB_LIFECYCLE_ACTR_DECAY,
				activationFloor: env.HONEYCOMB_LIFECYCLE_ACTIVATION_FLOOR,
				verificationHalfLifeDays: env.HONEYCOMB_LIFECYCLE_VERIFICATION_HALFLIFE_DAYS,
				contradictionThreshold: env.HONEYCOMB_LIFECYCLE_CONTRADICTION_THRESHOLD,
				corroborationWeight: env.HONEYCOMB_LIFECYCLE_CORROBORATION_WEIGHT,
				supersedeMargin: env.HONEYCOMB_LIFECYCLE_SUPERSEDE_MARGIN,
				reviewMargin: env.HONEYCOMB_LIFECYCLE_REVIEW_MARGIN,
				openConflictSuppression: env.HONEYCOMB_LIFECYCLE_OPEN_CONFLICT_SUPPRESSION,
				conflictAutoResolve: env.HONEYCOMB_LIFECYCLE_CONFLICT_AUTORESOLVE,
				staleRefPosture: env.HONEYCOMB_LIFECYCLE_STALEREF_POSTURE,
			};
		},
	};
}

/** A provider over a fixed record (the `agent.yaml` `memory.lifecycle.*` block, or a test fixture). */
export function staticLifecycleConfigProvider(raw: RawLifecycleConfig): LifecycleConfigProvider {
	return { read: () => raw };
}

/**
 * Layer the ENV raw record OVER the YAML raw record per-key (env wins), so the merged record carries
 * the env value where set and the yaml value otherwise; a key absent in BOTH stays undefined → the
 * schema fills the documented default. This is the SINGLE place the env-over-yaml precedence lives
 * (the `HONEYCOMB_PIPELINE_*` precedent), so there is no second precedence model. Pure.
 */
export function mergeRawLifecycle(yaml: RawLifecycleConfig, env: RawLifecycleConfig): RawLifecycleConfig {
	const pick = <T>(e: T | undefined, y: T | undefined): T | undefined => (e !== undefined ? e : y);
	return {
		activationExponent: pick(env.activationExponent, yaml.activationExponent),
		confidenceExponent: pick(env.confidenceExponent, yaml.confidenceExponent),
		stalenessExponent: pick(env.stalenessExponent, yaml.stalenessExponent),
		halfLifeDaysByClass: {
			memories: pick(env.halfLifeDaysByClass?.memories, yaml.halfLifeDaysByClass?.memories),
			memory: pick(env.halfLifeDaysByClass?.memory, yaml.halfLifeDaysByClass?.memory),
			sessions: pick(env.halfLifeDaysByClass?.sessions, yaml.halfLifeDaysByClass?.sessions),
		},
		actrDecay: pick(env.actrDecay, yaml.actrDecay),
		activationFloor: pick(env.activationFloor, yaml.activationFloor),
		verificationHalfLifeDays: pick(env.verificationHalfLifeDays, yaml.verificationHalfLifeDays),
		contradictionThreshold: pick(env.contradictionThreshold, yaml.contradictionThreshold),
		corroborationWeight: pick(env.corroborationWeight, yaml.corroborationWeight),
		supersedeMargin: pick(env.supersedeMargin, yaml.supersedeMargin),
		reviewMargin: pick(env.reviewMargin, yaml.reviewMargin),
		openConflictSuppression: pick(env.openConflictSuppression, yaml.openConflictSuppression),
		conflictAutoResolve: pick(env.conflictAutoResolve, yaml.conflictAutoResolve),
		staleRefPosture: pick(env.staleRefPosture, yaml.staleRefPosture),
	};
}

/**
 * Resolve a raw record into a validated {@link LifecycleConfig} — the SINGLE boundary where untrusted
 * env/yaml crosses into typed lifecycle config (zod-at-boundary discipline). The schema defaults every
 * knob non-destructively and clamps every numeric value, so resolution succeeds for nearly any input;
 * a structurally-impossible value still throws {@link LifecycleConfigError} listing every issue. Pass
 * a single provider, or use {@link resolveLifecycleConfigLayered} for the env-over-yaml precedence.
 */
export function resolveLifecycleConfig(provider: LifecycleConfigProvider = envLifecycleConfigProvider()): LifecycleConfig {
	const parsed = LifecycleConfigSchema.safeParse(provider.read());
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
		throw new LifecycleConfigError(issues);
	}
	return parsed.data;
}

/**
 * Resolve with the documented `env > yaml > default` precedence (AC-55d.1.2): the yaml provider
 * supplies the `agent.yaml` `memory.lifecycle.*` block, the env provider supplies `HONEYCOMB_LIFECYCLE_*`,
 * {@link mergeRawLifecycle} layers env OVER yaml per-key, and the schema fills any still-absent key
 * with its documented default. The defaults live LAST. A bare call (no yaml) is env-over-default.
 */
export function resolveLifecycleConfigLayered(
	yamlProvider: LifecycleConfigProvider = staticLifecycleConfigProvider({}),
	envProvider: LifecycleConfigProvider = envLifecycleConfigProvider(),
): LifecycleConfig {
	return resolveLifecycleConfig(staticLifecycleConfigProvider(mergeRawLifecycle(yamlProvider.read(), envProvider.read())));
}

// ── Posture projection: feed the recall consumer WITHOUT a second clamp model ────────────────

/**
 * The effective staleness exponent `s` given the resolved config (058c posture). Under `observe`
 * `s` is forced to `0` (visible but inert, AC-55d.1.1); under `execute` the configured
 * `stalenessExponent` applies (defaulting to {@link EXECUTE_STALENESS_EXPONENT} when it is still the
 * dormant `0`, so flipping the posture actually demotes, AC-55d.1.4). No other term changes.
 */
export function effectiveStalenessExponent(config: LifecycleConfig): number {
	if (config.staleRefPosture !== "execute") return 0;
	return config.stalenessExponent > 0 ? config.stalenessExponent : EXECUTE_STALENESS_EXPONENT;
}

/**
 * Project the lifecycle config's recency-facing knobs into the recall {@link RecencyConfig} shape so
 * the recall stage consumes the SAME `a` + per-class half-lives the operator governs here — WITHOUT a
 * second clamp model. The values are routed through {@link RecencyConfigSchema} (which owns the recall
 * boundary's clamp), so the clamp logic is not duplicated: the lifecycle module owns the knob, the
 * recall schema owns the final clamp. This is the "wire it so it feeds those consumers without
 * duplicating the clamp logic; do not create a second competing precedence model" rule (058d Implement #1).
 */
export function lifecycleRecency(config: LifecycleConfig): RecencyConfig {
	return RecencyConfigSchema.parse({
		halfLifeDaysByClass: config.halfLifeDaysByClass,
		activationExponent: config.activationExponent,
	});
}

// ── The single-sourced flag reference (the settings page + the config doc both read THIS) ────
//
// The reference table itself lives in `src/shared/lifecycle-flags.ts` (browser-safe, no daemon import)
// so the DASHBOARD bundle can render it; the daemon RE-EXPORTS it here so a daemon-side consumer reads
// the SAME source. The lifecycle-config spec asserts every reference default equals the schema default
// resolved from the owning engine, so the two can never silently drift (AC-55d.1.3).
export { type LifecycleFlagRef, LIFECYCLE_FLAG_REFERENCE } from "../../../shared/lifecycle-flags.js";
