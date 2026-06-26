/**
 * PRD-058d — the single-sourced `memory.lifecycle.*` FLAG REFERENCE (symbol, default, effect).
 *
 * This is the ONE table the settings page renders AND the config-reference doc lists AND the daemon
 * config module re-exports, so the symbol / default / master-equation effect can never drift between
 * the operator surface and the documentation (AC-55d.1.3). It lives in `src/shared` (browser-safe, no
 * `zod`/`process.env`/daemon import) so the DASHBOARD bundle can render it without pulling daemon code
 * across the bundle boundary, while `src/daemon/runtime/memories/lifecycle-config.ts` re-exports it
 * (and OWNS the matching schema defaults, asserted in parity by the lifecycle-config spec).
 *
 * The defaults below are the documented values from `memory-lifecycle-scoring.md`'s "Parameters and
 * defaults" table; the daemon config module's `DEFAULT_*` constants resolve to these same values from
 * the owning engines, and the lifecycle-config spec asserts the two agree (so a future engine default
 * change is caught, not silently drifted).
 */

/** One row of the operator-facing flag reference. */
export interface LifecycleFlagRef {
	/** The mathematical symbol from the scoring doc (`a`, `h(memories)`, `θ_detect`, …). */
	readonly symbol: string;
	/** The `memory.lifecycle.*` config path. */
	readonly configPath: string;
	/** The `HONEYCOMB_LIFECYCLE_*` env override. */
	readonly envOverride: string;
	/** The documented default, rendered for display. */
	readonly defaultValue: string;
	/** The effect on the master equation `P = R · A^a · C^c · (1 − σ)^s · κ` / on detection. */
	readonly effect: string;
}

/**
 * The single source of the lifecycle flag reference (AC-55d.1.3). Every flag from the scoring-doc
 * parameter table plus the two posture flags, each with its symbol, default, config path, env
 * override, and master-equation effect. The settings page + the config-reference doc both read THIS.
 */
export const LIFECYCLE_FLAG_REFERENCE: readonly LifecycleFlagRef[] = Object.freeze([
	{ symbol: "a", configPath: "memory.lifecycle.activationExponent", envOverride: "HONEYCOMB_LIFECYCLE_ACTIVATION_EXPONENT", defaultValue: "1", effect: "exponent on the activation/freshness term A^a" },
	{ symbol: "c", configPath: "memory.lifecycle.confidenceExponent", envOverride: "HONEYCOMB_LIFECYCLE_CONFIDENCE_EXPONENT", defaultValue: "0", effect: "exponent on the calibrated-confidence term C^c (dormant until calibrated)" },
	{ symbol: "s", configPath: "memory.lifecycle.stalenessExponent", envOverride: "HONEYCOMB_LIFECYCLE_STALENESS_EXPONENT", defaultValue: "0", effect: "exponent on the staleness term (1 − σ)^s (0 under observe)" },
	{ symbol: "h(memories)", configPath: "memory.lifecycle.halfLifeDaysByClass.memories", envOverride: "HONEYCOMB_LIFECYCLE_HALFLIFE_MEMORIES_DAYS", defaultValue: "180 d", effect: "shapes A for distilled facts (slower decay)" },
	{ symbol: "h(memory)", configPath: "memory.lifecycle.halfLifeDaysByClass.memory", envOverride: "HONEYCOMB_LIFECYCLE_HALFLIFE_MEMORY_DAYS", defaultValue: "45 d", effect: "shapes A for session summaries" },
	{ symbol: "h(sessions)", configPath: "memory.lifecycle.halfLifeDaysByClass.sessions", envOverride: "HONEYCOMB_LIFECYCLE_HALFLIFE_SESSIONS_DAYS", defaultValue: "10 d", effect: "shapes A for raw dialogue (fastest decay)" },
	{ symbol: "d", configPath: "memory.lifecycle.actrDecay", envOverride: "HONEYCOMB_LIFECYCLE_ACTR_DECAY", defaultValue: "0.5", effect: "ACT-R decay shaping A (Stage 2)" },
	{ symbol: "A_min", configPath: "memory.lifecycle.activationFloor", envOverride: "HONEYCOMB_LIFECYCLE_ACTIVATION_FLOOR", defaultValue: "0.05", effect: "clamps A so a cold memory keeps a sliver of salience" },
	{ symbol: "h_verify", configPath: "memory.lifecycle.verificationHalfLifeDays", envOverride: "HONEYCOMB_LIFECYCLE_VERIFICATION_HALFLIFE_DAYS", defaultValue: "14 d", effect: "shapes σ via the verification-freshness factor v(m,t)" },
	{ symbol: "θ_detect", configPath: "memory.lifecycle.contradictionThreshold", envOverride: "HONEYCOMB_LIFECYCLE_CONTRADICTION_THRESHOLD", defaultValue: "0.6", effect: "gates conflict detection (Contra > θ_detect)" },
	{ symbol: "γ", configPath: "memory.lifecycle.corroborationWeight", envOverride: "HONEYCOMB_LIFECYCLE_CORROBORATION_WEIGHT", defaultValue: "0.5", effect: "shapes the conflict vote weight w_i" },
	{ symbol: "τ_supersede", configPath: "memory.lifecycle.supersedeMargin", envOverride: "HONEYCOMB_LIFECYCLE_SUPERSEDE_MARGIN", defaultValue: "0.5", effect: "conflict verdict cut (margin ≥ τ_supersede → supersede)" },
	{ symbol: "τ_review", configPath: "memory.lifecycle.reviewMargin", envOverride: "HONEYCOMB_LIFECYCLE_REVIEW_MARGIN", defaultValue: "0.15", effect: "conflict verdict cut (τ_review ≤ margin < τ_supersede → review)" },
	{ symbol: "ρ", configPath: "memory.lifecycle.openConflictSuppression", envOverride: "HONEYCOMB_LIFECYCLE_OPEN_CONFLICT_SUPPRESSION", defaultValue: "0", effect: "κ for the open-conflict loser (0 fully suppress, reversible)" },
	{ symbol: "auto-resolve", configPath: "memory.lifecycle.conflictAutoResolve", envOverride: "HONEYCOMB_LIFECYCLE_CONFLICT_AUTORESOLVE", defaultValue: "false", effect: "when off, conflicts are detected + queued only (human-in-the-loop)" },
	{ symbol: "posture", configPath: "memory.lifecycle.staleRefPosture", envOverride: "HONEYCOMB_LIFECYCLE_STALEREF_POSTURE", defaultValue: "observe", effect: "observe (s = 0, inert) vs execute (s > 0, demote)" },
]);
