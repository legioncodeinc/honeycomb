/**
 * The POLLINATION COST composer — PRD-060d (d-AC-2 .. d-AC-6).
 *
 * ── What "pollination cost" is ───────────────────────────────────────────────
 * What Honeycomb's OWN machinery costs to run, from two different cost worlds:
 *
 *   1. **Honeycomb's own Haiku skillify token cost.** The skillify KEEP/MERGE/SKIP gate
 *      runs Honeycomb's own inference; the transport ({@link transport-anthropic.ts}) now
 *      surfaces the `usage` it discarded, the {@link SkillifyUsageMeter} accumulates it, and
 *      THIS module prices those tokens with 060b's rate table (the Haiku row, resolved by the
 *      exact skillify model id) — the token half of pollination (d-AC-2).
 *   2. **The DeepLake embedding / ingestion / query GPU-session cost.** 060c's billing
 *      read-model already itemizes GPU sessions by `session_type`; THIS module COMPOSES that
 *      breakdown into the total WITHOUT a second billing read (d-AC-3) — the infra half.
 *
 *   pollination = haikuSkillifyCents + deeplakeSessionCents  (d-AC-4, itemized)
 *
 * ── No second billing egress (d-AC-3) ────────────────────────────────────────
 * This module takes the ALREADY-READ {@link InfraCostReadModel} (the caller passes the
 * snapshot from 060c's `read()`); it NEVER constructs a billing client, never calls
 * `read()`, never touches the network. The DeepLake half is pure arithmetic over the
 * passed snapshot's `sessionTypes` + `sessionTypeTotalCents`. A test asserts no outbound
 * billing call originates here by passing a snapshot and observing zero fetches.
 *
 * ── Integer cents end to end (d-AC-6) ────────────────────────────────────────
 * Every value this module emits is INTEGER cents. The Haiku pricing divides per-Mtok rates
 * by `1e6` and `Math.round`s at the arithmetic edge (reusing the SAME edge discipline as
 * `roi-savings.ts`); the DeepLake half is already integer cents from 060c. Nothing here
 * carries a float-cent toward the read-model.
 *
 * ── Fail-soft, worst-status propagation (d-AC-5) ─────────────────────────────
 * A MISSING Haiku meter (no calls recorded yet) yields an `absent` Haiku contribution —
 * NOT `0` — so the page never shows a confident-but-wrong low number. An `unreachable`
 * (or `unauthenticated`/`partial`) billing read yields a correspondingly degraded DeepLake
 * contribution. The pollination TOTAL carries the WORST contributing status: a confident
 * total is emitted only when BOTH halves are confident. This is the dishonest-direction
 * guard — understating cost overstates net ROI, so pollination degrades loudly.
 *
 * Pure over its inputs (a usage SNAPSHOT + a billing SNAPSHOT) — NO I/O, NO storage, NO
 * clock. The Wave-4 read-model in `api.ts` feeds the live meter + the live 060c read-model
 * in and folds the returned figure into the composite `RoiView`.
 */

import type { BillingStatus, InfraCostReadModel, SessionType, SessionTypeLine } from "./roi-billing.js";
import { sessionTypeTotalCents } from "./roi-billing.js";
import { resolveRate } from "./roi-rates.js";
import type { SkillifyUsageSnapshot, SkillifyUsageSource } from "./roi-skillify-meter.js";

// ─────────────────────────────────────────────────────────────────────────────
// The skillify model identity (d-AC-2 / open-question answer).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The provider the skillify gate's own inference runs under (d-AC-2). Anthropic — the
 * skillify KEEP/MERGE/SKIP gate is a Haiku call (see `skillify/miner.ts` + the skillify
 * pipeline doc: `--model haiku`, hermes `anthropic/claude-haiku-4-5`).
 */
export const SKILLIFY_PROVIDER = "anthropic" as const;

/**
 * The exact Haiku model id the skillify path prices against (d-AC-2 / the 060d open question
 * "Haiku model identity in the rate table"). The skillify gate runs Haiku
 * (`anthropic/claude-haiku-4-5` per the hermes default + the skillify-pipeline doc); this is
 * the rate-table KEY 060b's {@link resolveRate} resolves. When 060b's table gains an explicit
 * Haiku row, pricing snaps to it automatically; until then {@link resolveRate} falls back to
 * the conservative default row (it NEVER crashes or zero-prices — the savings/cost engines
 * share this fallback). The transport ALSO reports the live model id per call, so a router
 * model swap is reflected without editing this constant — this is the documented default.
 */
export const SKILLIFY_HAIKU_MODEL = "claude-haiku-4-5" as const;

// ─────────────────────────────────────────────────────────────────────────────
// The contribution statuses + the itemized result shape (d-AC-4 / d-AC-5).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The status of the Haiku token half (d-AC-5). `measured` = the meter recorded ≥1 call
 * (a real, billed token figure — possibly a measured zero); `absent` = NO calls recorded
 * yet (no data — the page must NOT show `$0.00`).
 */
export type HaikuContributionStatus = "measured" | "absent";

/**
 * The status of the DeepLake half (d-AC-5) — derived from 060c's {@link BillingStatus}:
 *   - `ok`              → the GPU-session breakdown is complete + confident.
 *   - `partial`         → some billing endpoints read, some missing (degraded but populated).
 *   - `unreachable`     → billing could not be read (no confident figure).
 *   - `unauthenticated` → no billing credentials (no figure; a Settings-CTA state on the page).
 * This mirrors 060c's union verbatim so the page maps a single vocabulary.
 */
export type DeeplakeContributionStatus = BillingStatus;

/**
 * The pollination-total status (d-AC-5) — the WORST of the two contributing statuses, ranked
 * so a confident total is emitted ONLY when BOTH halves are confident:
 *   `ok` (best) > `measured` (Haiku ok) > `partial` > `absent` > `unreachable` > `unauthenticated` (worst).
 * Both contribution vocabularies fold into this single union so the page reads one status on
 * the total (and never renders a confident number atop a degraded contributor).
 */
export type PollinationStatus = "ok" | "measured" | "partial" | "absent" | "unreachable" | "unauthenticated";

/**
 * The Haiku token half of pollination (d-AC-2 / d-AC-4), itemized. `cents` is the priced
 * integer-cents figure; `status` distinguishes a measured figure from `absent` (no data);
 * the token sums + `model` are surfaced so the page can show WHY (and so the figure is
 * auditable against the rate row). When `status: "absent"`, `cents` is `0` but the status —
 * not the number — is what the page renders (it shows a dash, not `$0.00`).
 */
export interface HaikuSkillifyContribution {
	readonly status: HaikuContributionStatus;
	/** The priced integer-cents Haiku token cost (`0` when `absent` — read the STATUS, not this). */
	readonly cents: number;
	/** How many own-inference calls were metered (the absent discriminant; `0` ⇒ `absent`). */
	readonly recorded: number;
	/** Σ input tokens priced (non-negative integer). */
	readonly inputTokens: number;
	/** Σ output tokens priced (non-negative integer). */
	readonly outputTokens: number;
	/** Σ cache-read tokens priced (non-negative integer). */
	readonly cacheReadInputTokens: number;
	/** Σ cache-write tokens priced (non-negative integer). */
	readonly cacheCreationInputTokens: number;
	/** The model id priced against (the 060b rate-table key the figure was computed with). */
	readonly model: string;
}

/**
 * The DeepLake GPU-session half of pollination (d-AC-3 / d-AC-4), itemized. `cents` is the
 * integer-cents total summed from 060c's `session_type` breakdown; `bySessionType` is the
 * per-type split (query / embedding / ingestion) the page shows so a user can see e.g. that
 * embeddings dominate; `status` is 060c's billing status carried through.
 */
export interface DeeplakeSessionContribution {
	readonly status: DeeplakeContributionStatus;
	/** Σ session-type cost in integer cents (`0` when the breakdown is empty/missing — read STATUS). */
	readonly cents: number;
	/** The itemized `session_type` lines (the 060c breakdown, carried through verbatim). */
	readonly bySessionType: readonly SessionTypeLine[];
	/** The session-type total broken out per type (the readable split the page renders). */
	readonly perTypeCents: Readonly<Record<SessionType, number>>;
}

/**
 * The itemized pollination figure (d-AC-4) — `pollination = haikuSkillifyCents +
 * deeplakeSessionCents`, with BOTH contributors AND the session-type split individually
 * readable, and the TOTAL carrying the WORST contributing status (d-AC-5). Every cents value
 * is an integer (d-AC-6).
 */
export interface PollinationCost {
	/** The pollination total in INTEGER cents (`haiku.cents + deeplake.cents`). */
	readonly pollinationCents: number;
	/** The worst-of-the-two contributing status (d-AC-5) — never confident atop a degraded half. */
	readonly status: PollinationStatus;
	/** The Haiku token half, itemized (d-AC-2). */
	readonly haiku: HaikuSkillifyContribution;
	/** The DeepLake GPU-session half, itemized (d-AC-3). */
	readonly deeplake: DeeplakeSessionContribution;
}

// ─────────────────────────────────────────────────────────────────────────────
// Integer-cents pricing edge (d-AC-2 / d-AC-6) — shared discipline with roi-savings.
// ─────────────────────────────────────────────────────────────────────────────

/** Cents-per-Mtok × tokens → integer cents, rounding at the arithmetic edge (d-AC-6). */
function tokensAtRate(tokens: number, centsPerMtok: number): number {
	return Math.round((tokens * centsPerMtok) / 1_000_000);
}

/**
 * Price a skillify usage snapshot's token mix against the Haiku rate row (d-AC-2), in
 * INTEGER cents. Each of the four token buckets is priced at its OWN rate column
 * (input / output / cache-read / cache-write) and summed — the same per-bucket pricing the
 * savings engine uses, so the figure is consistent with the rest of PRD-060. The rate row is
 * resolved by the snapshot's live model id when present (a router model swap is reflected),
 * else the canonical {@link SKILLIFY_HAIKU_MODEL} — both go through {@link resolveRate}, which
 * falls back to the conservative default row when the table has no Haiku entry (never crashes,
 * never zero-prices a real token count via a `0` rate).
 */
export function priceHaikuTokens(snapshot: SkillifyUsageSnapshot): number {
	const rate = resolveRate(SKILLIFY_PROVIDER, snapshot.model ?? SKILLIFY_HAIKU_MODEL);
	return (
		tokensAtRate(snapshot.inputTokens, rate.input_cents_per_mtok) +
		tokensAtRate(snapshot.outputTokens, rate.output_cents_per_mtok) +
		tokensAtRate(snapshot.cacheReadInputTokens, rate.cache_read_cents_per_mtok) +
		tokensAtRate(snapshot.cacheCreationInputTokens, rate.cache_write_cents_per_mtok)
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The Haiku half (d-AC-2 / d-AC-5).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compose the Haiku token half from a skillify usage snapshot (d-AC-2 / d-AC-5). A snapshot
 * with `recorded === 0` (no own-inference call metered yet) is `absent` — the figure is `0`
 * but the STATUS says "no data", so the page renders a dash, never `$0.00`. A snapshot with
 * ≥1 recorded call is `measured` — a real, billed token figure (even when the tokens summed
 * to zero, which is an honest measured zero distinct from absent).
 */
export function composeHaikuContribution(snapshot: SkillifyUsageSnapshot): HaikuSkillifyContribution {
	const model = snapshot.model ?? SKILLIFY_HAIKU_MODEL;
	if (snapshot.recorded === 0) {
		// No data yet → `absent`, NOT a confident `0` (d-AC-5).
		return {
			status: "absent",
			cents: 0,
			recorded: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			model,
		};
	}
	return {
		status: "measured",
		cents: priceHaikuTokens(snapshot),
		recorded: snapshot.recorded,
		inputTokens: snapshot.inputTokens,
		outputTokens: snapshot.outputTokens,
		cacheReadInputTokens: snapshot.cacheReadInputTokens,
		cacheCreationInputTokens: snapshot.cacheCreationInputTokens,
		model,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// The DeepLake half (d-AC-3 / d-AC-4) — compose, NEVER re-read billing.
// ─────────────────────────────────────────────────────────────────────────────

/** Zeroed per-type split (so every session_type is a readable key even when absent). */
function emptyPerType(): Record<SessionType, number> {
	return { query: 0, embedding: 0, ingestion: 0 };
}

/**
 * Compose the DeepLake GPU-session half from 060c's ALREADY-READ infra snapshot (d-AC-3).
 * Sums the `session_type` breakdown via 060c's own {@link sessionTypeTotalCents} (integer
 * cents) and folds the per-type split so the page can show which type dominates. The
 * billing `status` is carried through verbatim. CRITICAL: this takes the read-model SNAPSHOT
 * — it does NOT call `read()` and never originates a billing egress (the no-second-read
 * contract, d-AC-3).
 */
export function composeDeeplakeContribution(infra: InfraCostReadModel): DeeplakeSessionContribution {
	const perTypeCents = emptyPerType();
	for (const line of infra.sessionTypes) {
		perTypeCents[line.session_type] += line.cost_cents;
	}
	return {
		status: infra.status,
		cents: sessionTypeTotalCents(infra.sessionTypes),
		bySessionType: infra.sessionTypes,
		perTypeCents,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Worst-status propagation (d-AC-5).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The status severity ladder (d-AC-5) — LOWER rank is WORSE. The total inherits the worst
 * (lowest-rank) of the two contributions, so a confident total appears ONLY when BOTH halves
 * are confident. Both contribution vocabularies (`measured`/`absent` for Haiku, the billing
 * union for DeepLake) live on this single ladder.
 */
const STATUS_SEVERITY: Readonly<Record<PollinationStatus, number>> = Object.freeze({
	unauthenticated: 0, // worst — no credentials, no figure.
	unreachable: 1, // billing could not be read.
	absent: 2, // Haiku has no data yet.
	partial: 3, // billing partially read.
	measured: 4, // Haiku ok (a real token figure).
	ok: 5, // best — billing fully read.
});

/**
 * Fold a Haiku status + a DeepLake status into the worst pollination status (d-AC-5). Both
 * map onto {@link STATUS_SEVERITY}; the lower severity (worse) wins. When BOTH are at their
 * best (`measured` Haiku + `ok` DeepLake) the total is `ok` — the only fully-confident state.
 */
export function worstPollinationStatus(
	haiku: HaikuContributionStatus,
	deeplake: DeeplakeContributionStatus,
): PollinationStatus {
	// Promote a `measured` Haiku + `ok` DeepLake to the single fully-confident `ok` total.
	if (haiku === "measured" && deeplake === "ok") return "ok";
	const haikuStatus: PollinationStatus = haiku;
	const deeplakeStatus: PollinationStatus = deeplake;
	return STATUS_SEVERITY[haikuStatus] <= STATUS_SEVERITY[deeplakeStatus] ? haikuStatus : deeplakeStatus;
}

// ─────────────────────────────────────────────────────────────────────────────
// The composer (d-AC-4) — pollination = haiku + deeplake, itemized, worst-status.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compose the itemized pollination figure (d-AC-2 .. d-AC-6):
 *   - prices the Haiku token half from the skillify usage snapshot (d-AC-2),
 *   - composes the DeepLake session half from 060c's already-read snapshot, with NO second
 *     billing read (d-AC-3),
 *   - sums them into `pollinationCents` with BOTH contributors AND the session-type split
 *     individually readable (d-AC-4),
 *   - carries the WORST contributing status on the total (d-AC-5),
 *   - keeps every cents value an integer (d-AC-6).
 *
 * @param usage  the skillify usage source (the live meter, or a static snapshot in tests).
 * @param infra  060c's ALREADY-READ infra cost snapshot (NOT a client — no read() here).
 */
export function composePollinationCost(usage: SkillifyUsageSource, infra: InfraCostReadModel): PollinationCost {
	const haiku = composeHaikuContribution(usage.snapshot());
	const deeplake = composeDeeplakeContribution(infra);
	return {
		pollinationCents: haiku.cents + deeplake.cents,
		status: worstPollinationStatus(haiku.status, deeplake.status),
		haiku,
		deeplake,
	};
}
