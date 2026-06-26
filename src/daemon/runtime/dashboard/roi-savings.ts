/**
 * The cost & savings calculation ENGINE — PRD-060b (b-AC-2 .. b-AC-7).
 *
 * This is the arithmetic between captured token counts (060a, persisted on the `sessions` group) and
 * the dollar figures 060e renders. It owns the **measured-vs-modeled honesty contract**: measured and
 * modeled are DIFFERENT KINDS of number, computed by SEPARATE functions, returned in SEPARATELY-TAGGED
 * wrappers, and the modeled tag TAINTS any aggregate it touches. A modeled number that renders as if
 * billed is the single worst failure this module can have — so the contract is enforced by the RETURN
 * TYPE, not by a naming convention (b-AC-4).
 *
 * ── The honesty contract, structurally ──────────────────────────────────────
 *   - {@link Measured}`<T>` and {@link Modeled}`<T>` are distinct tagged wrappers.
 *   - {@link measuredCacheSavings} takes RAW token counts + a rate row and returns `Measured<…>`. Its
 *     parameters are primitives + a rate — there is NO way to pass a `Modeled` value in, so a measured
 *     figure CANNOT be derived from a modeled input (the type system forbids it).
 *   - {@link modeledMemoryInjectionSavings} returns `Modeled<…>` carrying its ASSUMPTION as a data
 *     field ({@link MemoryInjectionAssumption}). The assumption object is the SINGLE source 060e's
 *     disclosure copy reads.
 *   - {@link netRoi} folds a `Modeled` term, so it can ONLY return `Modeled` — the `est.` taint
 *     propagates through the type, enforced by construction.
 *
 * ── Integer cents end to end (b-AC-6) ────────────────────────────────────────
 * Every value crossing the module boundary is INTEGER cents. The per-Mtok rates divide by `1e6` at the
 * arithmetic edge and `Math.round` carries the result back to an integer cent. {@link isIntegerCents}
 * is the boundary guard a test asserts against.
 *
 * ── Capture-absent honesty (b-AC-5 / b-AC-7) ─────────────────────────────────
 * 060a's token columns are NULLABLE: a SQL NULL = "token data absent", a real `0` = a measured zero.
 * The engine takes `number | null` per count and reports a {@link CaptureStatus}
 * (`measured` | `partial` | `absent`) the read-model maps — it NEVER returns `0`-as-measured for an
 * absent capture, and {@link blendedCentsPerMtok} returns `null` (not `$0.00`) when the mix is absent.
 *
 * Pure functions only — NO I/O, NO storage, NO clock. The daemon read-model (Wave 4) feeds persisted
 * rows in and composes the tagged outputs into the RoiView; this module decides numbers + tags, never
 * pixels and never reads.
 */

import { type RateRow, resolveRate } from "./roi-rates.js";

// ─────────────────────────────────────────────────────────────────────────────
// The honesty-contract tags (b-AC-4) — the structural spine.
// ─────────────────────────────────────────────────────────────────────────────

/** The two KINDS of number this module produces. `measured` = billed fact; `modeled` = counterfactual estimate. */
export type Tag = "measured" | "modeled";

/**
 * A MEASURED value: arithmetic over billed fact (b-AC-2). The literal `tag: "measured"` is the
 * compile-time witness. Only {@link measuredCacheSavings} (and pure measured aggregations) can mint one
 * — and because those take raw counts, no modeled input can ever flow into a measured result (b-AC-4).
 */
export interface Measured<T> {
	readonly tag: "measured";
	readonly value: T;
}

/**
 * A MODELED value: a counterfactual estimate (b-AC-3), NOT a billed fact. Carries its
 * {@link MemoryInjectionAssumption} so 060e can disclose exactly what the estimate rests on. The
 * `tag: "modeled"` literal taints any aggregate that folds it (b-AC-4).
 */
export interface Modeled<T> {
	readonly tag: "modeled";
	readonly value: T;
	/** The assumption the estimate rests on — the SINGLE source the disclosure copy reads (b-AC-3). */
	readonly assumption: MemoryInjectionAssumption;
}

/** Mint a {@link Measured} wrapper (internal — the only callers are the measured pure functions). */
function measured<T>(value: T): Measured<T> {
	return { tag: "measured", value };
}

/** Mint a {@link Modeled} wrapper carrying its assumption (internal). */
function modeled<T>(value: T, assumption: MemoryInjectionAssumption): Modeled<T> {
	return { tag: "modeled", value, assumption };
}

// ─────────────────────────────────────────────────────────────────────────────
// Integer-cents discipline (b-AC-6).
// ─────────────────────────────────────────────────────────────────────────────

/** True when `n` is a finite INTEGER cent (the boundary guard b-AC-6 asserts). */
export function isIntegerCents(n: number): boolean {
	return Number.isInteger(n);
}

/** Cents-per-Mtok × tokens → integer cents, rounding at the arithmetic edge (b-AC-6). */
function tokensAtRate(tokens: number, centsPerMtok: number): number {
	return Math.round((tokens * centsPerMtok) / 1_000_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// b-AC-2 — MEASURED cache savings (the headline, defensible, billed fact).
// ─────────────────────────────────────────────────────────────────────────────

/** Capture state the read-model maps (b-AC-7): a measured zero is DISTINCT from absent. */
export type CaptureStatus = "measured" | "partial" | "absent";

/**
 * One captured turn's token counts (060a). Each is `number | null`: a SQL NULL = "token data absent"
 * (the column was never produced), a real `0` = a measured zero. `provider`/`model` resolve the rate
 * row (defaulting via {@link resolveRate}); `sourceTool` is 060a's capture discriminant (a-AC-7).
 */
export interface CapturedTurn {
	readonly input_tokens: number | null;
	readonly output_tokens: number | null;
	readonly cache_read_input_tokens: number | null;
	readonly cache_creation_input_tokens: number | null;
	readonly provider?: string;
	readonly model?: string;
	readonly sourceTool?: string;
}

/** The measured cache-savings result (b-AC-2) — integer cents, plus the absent/partial honesty flag (b-AC-7). */
export interface CacheSavings {
	/** Σ cache_read_tokens × (input_rate − cache_read_rate) / 1e6 over captured turns — integer cents. */
	readonly savingsCents: number;
	/** Turns that contributed a measured `cache_read_input_tokens` (NULL turns are excluded, never zeroed). */
	readonly measuredTurns: number;
	/** Total turns seen (so the read-model can compute a partial ratio). */
	readonly totalTurns: number;
	/** `measured` (all turns had data) | `partial` (some) | `absent` (none) — NEVER `0`-as-measured (b-AC-7). */
	readonly status: CaptureStatus;
}

/**
 * MEASURED cache savings (b-AC-2): `Σ cache_read_tokens × (input_rate − cache_read_rate) / 1e6` over
 * captured turns, in INTEGER cents, returned TAGGED `measured`.
 *
 * This is arithmetic over billed fact — what the user ACTUALLY saved because cached tokens billed at
 * the cache-read rate instead of the full input rate. A turn whose `cache_read_input_tokens` is NULL
 * (absent) is SKIPPED, never counted as `0` (b-AC-7): the result's {@link CacheSavings.status} reports
 * `absent`/`partial`/`measured` so the read-model shows the right state instead of a fabricated zero.
 *
 * Honesty contract (b-AC-4): the parameters are RAW token counts + rate rows — there is no `Modeled`
 * input in the signature, so a measured figure can never be derived from a modeled one.
 */
export function measuredCacheSavings(turns: readonly CapturedTurn[]): Measured<CacheSavings> {
	let savingsCents = 0;
	let measuredTurns = 0;

	for (const turn of turns) {
		// NULL = absent (skip, never zero). A measured 0 (nothing read from cache) contributes 0 honestly.
		if (turn.cache_read_input_tokens === null) continue;
		measuredTurns += 1;
		const rate: RateRow = resolveRate(turn.provider, turn.model);
		const deltaCentsPerMtok = rate.input_cents_per_mtok - rate.cache_read_cents_per_mtok;
		savingsCents += tokensAtRate(turn.cache_read_input_tokens, deltaCentsPerMtok);
	}

	const totalTurns = turns.length;
	const status: CaptureStatus =
		totalTurns === 0 || measuredTurns === 0 ? "absent" : measuredTurns < totalTurns ? "partial" : "measured";

	return measured({ savingsCents, measuredTurns, totalTurns, status });
}

// ─────────────────────────────────────────────────────────────────────────────
// b-AC-5 — effective blended $/Mtok (null when capture absent).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The effective blended rate (b-AC-5): the realized integer cents-per-Mtok across the actual
 * input / output / cache-read / cache-write token mix. Returns `null` when token capture is ABSENT
 * (every count NULL, or no tokens at all) so 060e renders a placeholder, NOT a fabricated `$0.00`.
 *
 * `blended = round( totalCents / totalTokens × 1e6 )` where each token bucket is priced at its own
 * rate column and summed in integer cents. A turn's NULL count contributes nothing to either the cost
 * or the token denominator (absent, not zero).
 */
export function blendedCentsPerMtok(turns: readonly CapturedTurn[]): number | null {
	let totalCents = 0;
	let totalTokens = 0;

	for (const turn of turns) {
		const rate = resolveRate(turn.provider, turn.model);
		if (turn.input_tokens !== null) {
			totalCents += tokensAtRate(turn.input_tokens, rate.input_cents_per_mtok);
			totalTokens += turn.input_tokens;
		}
		if (turn.output_tokens !== null) {
			totalCents += tokensAtRate(turn.output_tokens, rate.output_cents_per_mtok);
			totalTokens += turn.output_tokens;
		}
		if (turn.cache_read_input_tokens !== null) {
			totalCents += tokensAtRate(turn.cache_read_input_tokens, rate.cache_read_cents_per_mtok);
			totalTokens += turn.cache_read_input_tokens;
		}
		if (turn.cache_creation_input_tokens !== null) {
			totalCents += tokensAtRate(turn.cache_creation_input_tokens, rate.cache_write_cents_per_mtok);
			totalTokens += turn.cache_creation_input_tokens;
		}
	}

	// Capture absent (no priced tokens) → null, never a fabricated 0 (b-AC-5).
	if (totalTokens === 0) return null;
	return Math.round((totalCents / totalTokens) * 1_000_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// b-AC-3 — MODELED memory-injection savings (the estimate, assumption-as-data).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The memory-injection model's ASSUMPTION, carried as a DATA FIELD (b-AC-3). This object is the SINGLE
 * source 060e's disclosure copy (the ⓘ / footnote) reads — the engine never hand-writes prose, it
 * emits this structured assumption and the page renders it.
 *
 * The constants here are a PLACEHOLDER pending an operator decision (the gating open question in the
 * PRD). They live in ONE editable place ({@link MEMORY_INJECTION_ASSUMPTION}); when the signed-off
 * model + string land, edit that constant ONLY.
 */
export interface MemoryInjectionAssumption {
	/** A short machine id for the model kind (so 060e can branch if more models are added later). */
	readonly kind: "turns-saved-per-session";
	/** Modeled turns of re-explaining saved per session by injecting memory (the counterfactual lever). */
	readonly turnsSavedPerSession: number;
	/** Modeled average tokens a saved turn would have re-spent (prompt re-explaining + the model's reply). */
	readonly avgTokensPerSavedTurn: number;
	/** Whether the estimate claims OUTPUT-token savings too (fewer turns → fewer completions). */
	readonly includesOutputTokens: boolean;
	/** Whether this is a signed-off operator decision or still the placeholder. `false` until sign-off. */
	readonly signedOff: boolean;
	/** The human-readable assumption string 060e surfaces verbatim — the SINGLE disclosure source (b-AC-3). */
	readonly assumptionText: string;
}

// TODO(roi-assumption-signoff): these constants + `assumptionText` are a PLACEHOLDER. The exact
// memory-injection model (turns-saved × avg-turn-cost vs % of measured spend vs recall-hit-rate × per-hit
// tokens), its constants, and the operator-signed-off disclosure string are a PENDING operator decision
// (the gating open question in PRD-060b). Edit THIS ONE constant when the signed-off values land, and flip
// `signedOff` to `true`. Nothing else in the engine encodes the assumption — it flows from here.
/**
 * THE memory-injection assumption (b-AC-3) — the single editable place the modeled estimate and 060e's
 * disclosure both read. PLACEHOLDER until sign-off (`signedOff: false`).
 */
export const MEMORY_INJECTION_ASSUMPTION: MemoryInjectionAssumption = Object.freeze({
	kind: "turns-saved-per-session",
	turnsSavedPerSession: 2,
	avgTokensPerSavedTurn: 4_000,
	includesOutputTokens: false,
	signedOff: false,
	assumptionText:
		"PLACEHOLDER (pending operator sign-off): estimates that injecting memory saves ~2 turns of " +
		"re-explaining per session, at ~4,000 input tokens per saved turn, priced at the session's input rate. " +
		"Output-token savings are NOT yet claimed. This is a model, not a billed figure.",
});

/** The modeled memory-injection result (b-AC-3) — integer cents, ALWAYS carries its assumption. */
export interface MemoryInjectionSavings {
	/** The modeled counterfactual saving in INTEGER cents (what would have been spent WITHOUT injection). */
	readonly estimatedCents: number;
	/** The number of sessions the estimate was modeled over. */
	readonly sessions: number;
}

/**
 * MODELED memory-injection savings (b-AC-3): a COUNTERFACTUAL estimate of what the user would have
 * spent WITHOUT memory injection (more turns, more re-explaining), returned TAGGED `modeled` and
 * carrying its {@link MemoryInjectionAssumption} as a data field.
 *
 * This is NOT a billed fact. It is `sessions × turnsSavedPerSession × avgTokensPerSavedTurn` priced at
 * the input rate (plus output if the assumption claims it), in integer cents. The assumption rides in
 * the returned `Modeled.assumption` so 060e discloses exactly what it rests on — and because the
 * function returns `Modeled`, the value is poison to any measured line (b-AC-4).
 *
 * @param sessions     the count of captured sessions to model over.
 * @param rate         the rate row to price the modeled tokens at (defaults to the engine default).
 * @param assumption   the model's assumption (defaults to {@link MEMORY_INJECTION_ASSUMPTION}).
 */
export function modeledMemoryInjectionSavings(
	sessions: number,
	rate: RateRow = resolveRate(undefined, undefined),
	assumption: MemoryInjectionAssumption = MEMORY_INJECTION_ASSUMPTION,
): Modeled<MemoryInjectionSavings> {
	const savedTokens = Math.max(0, sessions) * assumption.turnsSavedPerSession * assumption.avgTokensPerSavedTurn;
	let estimatedCents = tokensAtRate(savedTokens, rate.input_cents_per_mtok);
	if (assumption.includesOutputTokens) {
		estimatedCents += tokensAtRate(savedTokens, rate.output_cents_per_mtok);
	}
	return modeled({ estimatedCents, sessions: Math.max(0, sessions) }, assumption);
}

// ─────────────────────────────────────────────────────────────────────────────
// b-AC-4 — the net (folds a modeled term → itself MODELED / `est.`).
// ─────────────────────────────────────────────────────────────────────────────

/** The net-ROI figure (b-AC-4): measured savings + modeled savings − infra cost, in INTEGER cents. */
export interface NetRoi {
	/** The measured cache-savings cents that fed the net (the defensible half). */
	readonly measuredSavingsCents: number;
	/** The modeled memory-injection cents that fed the net (the estimated half — why the net is tainted). */
	readonly modeledSavingsCents: number;
	/** Optional infra cost (060c) subtracted, in integer cents; `0` when not supplied. */
	readonly infraCostCents: number;
	/** measured + modeled − infra, in INTEGER cents. */
	readonly netCents: number;
}

/**
 * The Net-ROI hero (b-AC-4): folds the MEASURED cache savings, the MODELED memory-injection savings,
 * and (optionally) the 060c infra cost into one figure. Because a `Modeled` term is an INPUT, the
 * return type is `Modeled<NetRoi>` — the `est.` taint propagates THROUGH THE TYPE, so any consumer
 * that renders the net is forced to treat it as an estimate. It is structurally IMPOSSIBLE to get a
 * `Measured`-tagged net out of this function (the honesty contract, enforced by construction).
 *
 * The returned assumption is inherited from the modeled term, so 060e's disclosure on the net reads
 * the SAME single assumption source (b-AC-3).
 */
export function netRoi(
	measuredCacheSavingsCents: Measured<CacheSavings>,
	modeledInjectionSavings: Modeled<MemoryInjectionSavings>,
	infraCostCents = 0,
): Modeled<NetRoi> {
	const measuredSavingsCents = measuredCacheSavingsCents.value.savingsCents;
	const modeledSavingsCents = modeledInjectionSavings.value.estimatedCents;
	const netCents = measuredSavingsCents + modeledSavingsCents - infraCostCents;
	return modeled(
		{ measuredSavingsCents, modeledSavingsCents, infraCostCents, netCents },
		modeledInjectionSavings.assumption,
	);
}
