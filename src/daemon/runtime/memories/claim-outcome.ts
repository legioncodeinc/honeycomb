/**
 * PRD-058b — claim-OUTCOME derivation for the live conflict hook (C-1).
 *
 * The resolver ({@link import("./conflict-resolve.js").resolveConflict}) groups voters by their
 * `outcome` string: voters with the SAME outcome AGREE (their weights sum on one side), voters with
 * DISTINCT outcomes COMPETE (the winner is the argmax side, the loser is suppressed). The detector
 * ({@link import("./conflict-detect.js").detectConflicts}) decides WHETHER a pair conflicts (its
 * `Contra` score); the outcome string decides which SIDE each memory votes for once a pair is flagged.
 *
 * For the live hook, the outcome must be derived DETERMINISTICALLY from a memory's content so that:
 *   - two contradictory memories ("we deploy on fridays" vs "we never deploy on fridays") land DISTINCT
 *     outcomes → they compete → the resolver picks a winner and the loser is suppressed; and
 *   - two agreeing memories land the SAME outcome → they reinforce (no false competition).
 *
 * The derivation is a POLARITY token: the count of negation markers (negation words + antonym "negative"
 * poles) modulo 2. An affirmative claim → `"affirm"`; a negated claim → `"negate"`. This is intentionally
 * a CHEAP, lexical signal — the detector's `Contra` already carries the semantic contradiction weight; the
 * outcome only needs to split the two flagged sides. Reuses the SAME {@link NEGATION_TOKENS} /
 * {@link ANTONYM_PAIRS} / {@link tokenize} the write-time check and the detector use (one token source of
 * truth). Pure + deterministic; never throws.
 */

import {
	ANTONYM_PAIRS,
	NEGATION_TOKENS,
	tokenize,
} from "../pipeline/controlled-writes.js";

/** The affirmative-polarity outcome token (an un-negated claim). */
export const OUTCOME_AFFIRM = "affirm" as const;
/** The negated-polarity outcome token (a claim carrying a polarity flip). */
export const OUTCOME_NEGATE = "negate" as const;

/** The "negative pole" half of each antonym pair — its presence flips a claim's polarity. */
const NEGATIVE_POLES: ReadonlySet<string> = new Set(ANTONYM_PAIRS.map(([, negative]) => negative));

/**
 * Derive a memory's claim OUTCOME (PRD-058b LIVE / C-1): the polarity token the resolver groups votes by.
 * Counts the polarity-flipping markers in the content — negation words ({@link NEGATION_TOKENS}) plus the
 * "negative pole" of each antonym pair ({@link ANTONYM_PAIRS}) — and returns {@link OUTCOME_NEGATE} when
 * that count is ODD (a net polarity flip) else {@link OUTCOME_AFFIRM}. So an affirmative claim and its
 * single-negation contradiction land OPPOSITE outcomes (they compete), while two affirmations (or two
 * double-negations) land the SAME outcome (they agree). Pure + deterministic; an empty/garbage string →
 * {@link OUTCOME_AFFIRM} (the conservative default: an un-negated, non-competing claim).
 */
export function deriveClaimOutcome(content: string): string {
	const tokens = tokenize(content);
	if (tokens.length === 0) return OUTCOME_AFFIRM;
	let flips = 0;
	for (const token of tokens) {
		if (NEGATION_NOT.has(token) || NEGATIVE_POLES.has(token)) flips += 1;
	}
	return flips % 2 === 1 ? OUTCOME_NEGATE : OUTCOME_AFFIRM;
}

/** The negation-token set as a `Set` for O(1) membership (the array is the source of truth). */
const NEGATION_NOT: ReadonlySet<string> = new Set(NEGATION_TOKENS);
