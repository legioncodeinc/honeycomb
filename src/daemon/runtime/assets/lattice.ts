/**
 * PRD-033a — The tier × style lattice state machine (FR-7 / a-AC-5).
 *
 * Every artifact resolves to EXACTLY ONE of 6 cells: tier ∈ {Local, Device, Team}
 * × style ∈ {Repository, User} (a-AC-5). The tier is the propagation RADIUS
 * (Local = unmanaged, never synced; Device = my other devices; Team = my
 * workspace); the style is the KEYING axis (Repository = per-project; User =
 * global), ORTHOGONAL to the tier.
 *
 * Transitions (FR-7):
 *   - The TIER axis is an ordered ladder `Local → Device → Team` (+ the inverse,
 *     and jumps are allowed — `Local → Team` and `Team → Local` are both legal):
 *     a tier change always moves along (or jumps along) that single axis, so it
 *     is always legal. A "same-cell" tier move (Local→Local) is also legal (a
 *     no-op).
 *   - The STYLE axis is ORTHOGONAL: a Repository↔User flip is always legal and
 *     independent of the tier.
 *
 * In v1 every (from, to) pair is a legal transition: tier moves slide/jump along
 * the one ordered axis and style flips are orthogonal. {@link isLegalTransition}
 * encodes the rule explicitly (and rejects an INVALID cell — a bad tier/style
 * string) so the lifecycle (033b) has ONE authority to gate on, and a future
 * version that wants to forbid a jump changes ONE function.
 *
 * Pure (D-6): no I/O. The cell vocabulary is shared from `contracts.ts` (the
 * single source for Wave 2).
 */

import { type LatticeCell, STYLES, type Style, TIERS, type Tier } from "./contracts.js";

export { type LatticeCell, STYLES, type Style, TIERS, type Tier } from "./contracts.js";

/** The tier's rung on the `Local(0) → Device(1) → Team(2)` ladder (the radius order). */
export const TIER_RANK: Readonly<Record<Tier, number>> = Object.freeze({
	Local: 0,
	Device: 1,
	Team: 2,
});

/** True when `value` is a valid {@link Tier}. */
export function isTier(value: unknown): value is Tier {
	return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

/** True when `value` is a valid {@link Style}. */
export function isStyle(value: unknown): value is Style {
	return typeof value === "string" && (STYLES as readonly string[]).includes(value);
}

/** True when `cell` is one of the 6 valid lattice cells (a-AC-5). */
export function isLatticeCell(cell: unknown): cell is LatticeCell {
	if (typeof cell !== "object" || cell === null) return false;
	const c = cell as Record<string, unknown>;
	return isTier(c.tier) && isStyle(c.style);
}

/**
 * Enumerate ALL 6 lattice cells (a-AC-5). The product of the 3 tiers × 2 styles,
 * in a stable order. Used by the lifecycle + the tests to prove every artifact
 * resolves to exactly one of these and no other.
 */
export const ALL_CELLS: readonly LatticeCell[] = Object.freeze(
	TIERS.flatMap((tier) => STYLES.map((style): LatticeCell => ({ tier, style }))),
);

/** A stable `"<tier>/<style>"` label for a cell (registry keys, logs, test names). */
export function cellLabel(cell: LatticeCell): string {
	return `${cell.tier}/${cell.style}`;
}

/** Cell equality by value (tier + style). */
export function sameCell(a: LatticeCell, b: LatticeCell): boolean {
	return a.tier === b.tier && a.style === b.style;
}

/**
 * Decide whether a transition `from → to` is legal (FR-7 / a-AC-5). The rule:
 *
 *   - BOTH cells must be valid (a malformed tier/style is never a legal endpoint).
 *   - The TIER move is along the single ordered `Local↔Device↔Team` axis — any
 *     move (up, down, jump, or same) is legal because there is exactly one axis to
 *     move on; there is no "illegal" tier pair in v1.
 *   - The STYLE move is orthogonal — a Repository↔User flip (or no flip) is always
 *     legal, independent of the tier.
 *
 * So in v1 every (valid-from → valid-to) pair is legal; the only rejection is an
 * invalid endpoint. This is the ONE gate the lifecycle (033b) consults, so a
 * later policy that forbids (say) a Local→Team jump is a one-line change here.
 */
export function isLegalTransition(from: LatticeCell, to: LatticeCell): boolean {
	if (!isLatticeCell(from) || !isLatticeCell(to)) return false;
	// Tier axis: ordered ladder, all moves (incl. jumps + same) legal in v1.
	// Style axis: orthogonal, all flips legal. Both are unconditionally true here,
	// stated explicitly so the policy surface is visible and easy to tighten later.
	const tierMoveLegal = TIER_RANK[from.tier] >= 0 && TIER_RANK[to.tier] >= 0;
	const styleMoveLegal = isStyle(from.style) && isStyle(to.style);
	return tierMoveLegal && styleMoveLegal;
}

/**
 * The DIRECTION of a tier transition (promotion widens the blast radius; demotion
 * narrows it). The lifecycle (033b) uses this to decide publish-vs-tombstone:
 * a `promote` widens reach → publish at the new radius; a `demote` narrows it →
 * tombstone the wider tiers being left behind.
 */
export type TierDirection = "promote" | "demote" | "none";

/** Classify a tier move by its rung delta (promote = wider, demote = narrower). */
export function tierDirection(from: Tier, to: Tier): TierDirection {
	const delta = TIER_RANK[to] - TIER_RANK[from];
	if (delta > 0) return "promote";
	if (delta < 0) return "demote";
	return "none";
}

/** True when the tier is `Local` — UNMANAGED, never synced to DeepLake (FR-7). */
export function isUnmanaged(cell: LatticeCell): boolean {
	return cell.tier === "Local";
}
