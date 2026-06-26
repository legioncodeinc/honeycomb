/**
 * The maintained provider→model RATE TABLE — PRD-060b (b-AC-1), single-sourced in source.
 *
 * ── What this is ─────────────────────────────────────────────────────────────
 * The ONE module that names the per-Mtok billing rates the savings engine (`roi-savings.ts`)
 * prices captured token counts against. It mirrors the `vault/catalog.ts` single-sourced-catalog
 * pattern (D-6 there): a rate is a ONE-LINE edit HERE and every consumer reflects it. There is NO
 * runtime pricing fetch (a module Non-Goal) — the table is curated, versioned with the code, and
 * carries a visible {@link RATES_AS_OF} stamp so a stale rate is auditable on the page, not buried.
 *
 * ── Integer cents per Mtok (b-AC-6) ──────────────────────────────────────────
 * Every rate column is INTEGER cents-per-million-tokens. The engine divides by `1e6` only at the
 * arithmetic edge and carries integer cents; nothing here is a float-dollar.
 *
 * ── The Anthropic cache multipliers (b-AC-1, first-class) ────────────────────
 * Anthropic bills cache READS at 0.1× the input rate and cache WRITES at 1.25× the input rate. Those
 * are encoded as FIRST-CLASS columns (`cache_read_cents_per_mtok`, `cache_write_cents_per_mtok`), not
 * a fudge factor applied at read time — {@link ANTHROPIC_CACHE_READ_MULTIPLIER} /
 * {@link ANTHROPIC_CACHE_WRITE_MULTIPLIER} are the documented derivation, and a test asserts the
 * encoded rows honor them.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The Anthropic cache-pricing multipliers (b-AC-1) — the documented derivation.
// ─────────────────────────────────────────────────────────────────────────────

/** Anthropic bills a cache READ at 0.1× the input rate (the headline measured-savings lever). */
export const ANTHROPIC_CACHE_READ_MULTIPLIER = 0.1 as const;
/** Anthropic bills a cache WRITE (cache creation) at 1.25× the input rate. */
export const ANTHROPIC_CACHE_WRITE_MULTIPLIER = 1.25 as const;

/**
 * Derive an Anthropic cache rate from the input rate via a multiplier, rounded to INTEGER
 * cents-per-Mtok (b-AC-6 — the table never carries a float column). Used to encode the rows below so
 * the 0.1× / 1.25× relationship is expressed once and is self-evidently correct.
 */
export function anthropicCacheRate(inputCentsPerMtok: number, multiplier: number): number {
	return Math.round(inputCentsPerMtok * multiplier);
}

// ─────────────────────────────────────────────────────────────────────────────
// The rate-row shape.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One provider→model rate row (b-AC-1). All four rate columns are INTEGER cents-per-million-tokens.
 * `cache_read` / `cache_write` are first-class columns (not derived at read time) so a provider that
 * does NOT follow Anthropic's 0.1×/1.25× shape (or a future Anthropic repricing) is one row edit.
 */
export interface RateRow {
	/** The provider id (mirrors `vault/catalog.ts` provider ids where they overlap). */
	readonly provider: string;
	/** The model id. */
	readonly model: string;
	/** Input (uncached prompt) tokens — integer cents per million tokens. */
	readonly input_cents_per_mtok: number;
	/** Output (completion) tokens — integer cents per million tokens. */
	readonly output_cents_per_mtok: number;
	/** Cache-READ (cache hit) tokens — integer cents per million tokens (Anthropic: 0.1× input). */
	readonly cache_read_cents_per_mtok: number;
	/** Cache-WRITE (cache creation) tokens — integer cents per million tokens (Anthropic: 1.25× input). */
	readonly cache_write_cents_per_mtok: number;
}

/**
 * The "rates as of" stamp (b-AC-1). Surfaced by 060e so a stale or wrong rate is auditable on the
 * page. Updating a rate is a maintenance task that bumps THIS date alongside the row edit.
 */
export const RATES_AS_OF = "2026-06-26" as const;

// ─────────────────────────────────────────────────────────────────────────────
// The rate table (single-sourced; edit a rate HERE and every surface reflects it).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE rate table (b-AC-1). Integer cents-per-Mtok. The Anthropic rows encode cache-read at
 * {@link ANTHROPIC_CACHE_READ_MULTIPLIER}× input and cache-write at
 * {@link ANTHROPIC_CACHE_WRITE_MULTIPLIER}× input via {@link anthropicCacheRate}, so the multiplier
 * relationship is expressed in the data, not buried in the engine.
 *
 * Anthropic public per-Mtok pricing (USD → integer cents): Sonnet $3 in / $15 out;
 * Opus $15 in / $75 out. (Cache columns derived from input via the multipliers above.)
 */
export const RATE_TABLE: readonly RateRow[] = Object.freeze([
	Object.freeze({
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		input_cents_per_mtok: 300,
		output_cents_per_mtok: 1500,
		cache_read_cents_per_mtok: anthropicCacheRate(300, ANTHROPIC_CACHE_READ_MULTIPLIER),
		cache_write_cents_per_mtok: anthropicCacheRate(300, ANTHROPIC_CACHE_WRITE_MULTIPLIER),
	}),
	Object.freeze({
		provider: "anthropic",
		model: "claude-opus-4-8",
		input_cents_per_mtok: 1500,
		output_cents_per_mtok: 7500,
		cache_read_cents_per_mtok: anthropicCacheRate(1500, ANTHROPIC_CACHE_READ_MULTIPLIER),
		cache_write_cents_per_mtok: anthropicCacheRate(1500, ANTHROPIC_CACHE_WRITE_MULTIPLIER),
	}),
]);

/**
 * The DEFAULT rate row used when a captured turn's model is unknown/absent. Anthropic Sonnet is the
 * conservative default: it is the Claude-Code capture source (a-AC-7's `source_tool='claude-code'`),
 * so an unattributed turn prices against the cheaper Claude tier rather than overstating savings.
 */
export const DEFAULT_RATE_PROVIDER = "anthropic" as const;
/** The default model id (Sonnet) — see {@link DEFAULT_RATE_PROVIDER}. */
export const DEFAULT_RATE_MODEL = "claude-sonnet-4-6" as const;

/**
 * Look up a rate row by provider+model, or `undefined` when the pair is not in the table. Exact match
 * on both columns; the engine falls back to {@link defaultRateRow} when this returns `undefined` so an
 * unknown model never crashes the savings math.
 */
export function rateRowFor(provider: string, model: string): RateRow | undefined {
	return RATE_TABLE.find((r) => r.provider === provider && r.model === model);
}

/** The default rate row ({@link DEFAULT_RATE_PROVIDER}/{@link DEFAULT_RATE_MODEL}). Always present. */
export function defaultRateRow(): RateRow {
	const row = rateRowFor(DEFAULT_RATE_PROVIDER, DEFAULT_RATE_MODEL);
	// Invariant: the default row is in the table. The non-null is checked by `roi-rates.test.ts`.
	if (row === undefined) {
		throw new Error("roi-rates: the default rate row must exist in RATE_TABLE");
	}
	return row;
}

/**
 * Resolve the rate row for a turn (provider+model), falling back to {@link defaultRateRow} for an
 * unknown/absent pair so the engine always has a rate to price against (never a crash, never a `0`
 * rate masquerading as a real price).
 */
export function resolveRate(provider: string | undefined, model: string | undefined): RateRow {
	if (provider === undefined || model === undefined || provider.length === 0 || model.length === 0) {
		return defaultRateRow();
	}
	return rateRowFor(provider, model) ?? defaultRateRow();
}
