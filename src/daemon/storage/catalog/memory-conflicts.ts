/**
 * PRD-058b, the semantic-conflict table (the `κ(m,t)` gate's durable projection).
 *
 * `memory_conflicts` is the queryable CURRENT-STATE projection over the conflict
 * lifecycle: detection records a candidate pair, resolution stamps its verdict +
 * the `κ` it assigned the loser, and recall reads the OPEN projection to suppress a
 * `κ = ρ` loser. The append-only EVENT log is the existing `memory_history` table
 * (every detection and every resolution appends an actor/reason/confidence row);
 * `memory_conflicts` is the de-normalized "what is the current verdict for this
 * pair" view over that log (PRD-058b Data Model: "memory_conflicts is the queryable
 * current-state projection"). A status change is a fresh append to `memory_history`
 * plus a projection refresh here, NEVER an in-place mutation a DeepLake UPDATE could
 * coalesce.
 *
 * ── Scope (D-2: engine table) ────────────────────────────────────────────────
 * An `agent`-scoped engine table, exactly like `memory_access` / `memory_calibration`
 * (`memory-lifecycle.ts`) and `memories` itself: it carries `agent_id` + `visibility`,
 * and org/workspace isolation is the STORAGE PARTITION boundary
 * ({@link import("../client.js").QueryScope}), not a column (catalog/types.ts D-2,
 * index AC-3). The PRD-058b data-model sketch lists `org`/`workspace`/`agent_id` as
 * the conflict scope; per the codebase engine-table convention 058e set, the
 * partition supplies org/workspace and the row carries `agent_id` (and `visibility`),
 * so a conflict is reachable transitively by its two `memory_*_id`s under the same
 * partition the memories live in. Cross-workspace conflict detection is explicitly
 * out of scope (PRD-058b Out of scope), so the partition boundary IS the conflict
 * boundary.
 *
 * ── Normalized (sorted) pair (PRD-058b Data Model) ───────────────────────────
 * `(memory_a_id, memory_b_id)` is the NORMALIZED (lexicographically sorted) pair, so a
 * pair is recorded ONCE regardless of which order detection encountered the two
 * memories. {@link normalizeConflictPair} is the single canonicalizer both the
 * detector (the `keep-both` memoization key, AC-55b.2.4) and the writer use, so the
 * memoization is stable and a duplicate pair never lands twice.
 *
 * ── Append-only / lazy-heal (PRD-058b Schema changes) ────────────────────────
 * NEW table, created lazily by the heal pass on first write; every `NOT NULL`
 * column carries a `DEFAULT` so a later additive column heals in via
 * `ALTER TABLE ADD COLUMN` with a clean backfill (PRD-002c). No migration, no
 * backfill: a partition with no conflicts simply has no rows (recall's κ gate is
 * fail-soft against the missing table — see `recall.ts`).
 *
 * ── Enums encoded as TEXT (DeepLake has no ENUM DDL) ─────────────────────────
 * `signal`, `verdict`, and `status` are logical enums stored as TEXT and constrained
 * IN CODE by {@link CONFLICT_SIGNALS} / {@link CONFLICT_VERDICTS} / {@link CONFLICT_STATUSES},
 * mirroring the `ref_status` / `MEMORY_ACCESS_KINDS` discipline in the rest of the
 * catalog (a writer stamps a member, a reader narrows against the set).
 */

import { sqlIdent, sLiteral } from "../sql.js";
import { type CatalogTable, defineGroup } from "./types.js";

/**
 * The DECIDING-SIGNAL tokens recorded in `memory_conflicts.signal` (PRD-058b §1). The
 * cheapest signal that flagged the pair is recorded so an operator can see WHY a pair
 * was caught:
 *   - `lexical`   → the existing negation/antonym/overlap heuristic flagged it (no model
 *                   call was needed, AC-55b.2.2).
 *   - `embedding` → the claim-slot cosine `sim` carried the flag (high similarity, the
 *                   lexical signal alone inconclusive but no model verdict consulted).
 *   - `model`     → the NLI-style `P_contradiction` verdict (the `memory_extraction`
 *                   router workload) decided it (AC-55b.2.1).
 */
export const CONFLICT_SIGNALS = Object.freeze(["lexical", "embedding", "model"] as const);
/** One `memory_conflicts.signal` token. */
export type ConflictSignal = (typeof CONFLICT_SIGNALS)[number];

/** Is `value` a recognized {@link ConflictSignal}? (defense-in-depth narrow, mirrors `isMemoryAccessKind`). */
export function isConflictSignal(value: string): value is ConflictSignal {
	return (CONFLICT_SIGNALS as readonly string[]).includes(value);
}

/**
 * The VERDICT tokens recorded in `memory_conflicts.verdict` (PRD-058b §2 verdict table).
 * The default OPEN verdict is `review` (NOT `supersede`) — the safety default the PRD
 * mandates, since `κ` is the only term that can zero retrieval priority:
 *   - `supersede` → `margin ≥ τ_supersede`: the winner clearly dominates; the loser is
 *                   superseded (`κ = 0`, excluded by `MAX(version)`).
 *   - `review`    → `τ_review ≤ margin < τ_supersede`: ambiguous; a human decides; the
 *                   loser is soft-suppressed (`κ = ρ`, reversible).
 *   - `keep-both` → `margin < τ_review` AND low `Contra`: a false positive; both stay
 *                   live (`κ = 1`) and the normalized pair is memoized.
 */
export const CONFLICT_VERDICTS = Object.freeze(["supersede", "keep-both", "review"] as const);
/** One `memory_conflicts.verdict` token. */
export type ConflictVerdict = (typeof CONFLICT_VERDICTS)[number];

/** Is `value` a recognized {@link ConflictVerdict}? */
export function isConflictVerdict(value: string): value is ConflictVerdict {
	return (CONFLICT_VERDICTS as readonly string[]).includes(value);
}

/**
 * The lifecycle STATUS tokens recorded in `memory_conflicts.status` (PRD-058b §3/§4):
 *   - `open`     → detected, not yet resolved; recall suppresses a `review` loser at
 *                  `κ = ρ` via this open projection.
 *   - `resolved` → an operator (or the auto-supersede path) applied a verdict.
 *   - `reversed` → a prior `supersede` was undone by a new append-only version bump,
 *                  restoring the loser to `κ = 1` (AC-55b.4.2).
 */
export const CONFLICT_STATUSES = Object.freeze(["open", "resolved", "reversed"] as const);
/** One `memory_conflicts.status` token. */
export type ConflictStatus = (typeof CONFLICT_STATUSES)[number];

/** Is `value` a recognized {@link ConflictStatus}? */
export function isConflictStatus(value: string): value is ConflictStatus {
	return (CONFLICT_STATUSES as readonly string[]).includes(value);
}

/** The default open verdict for a freshly-detected conflict (the SAFETY default, never `supersede`). */
export const DEFAULT_CONFLICT_VERDICT: ConflictVerdict = "review";
/** The default status for a freshly-detected conflict. */
export const DEFAULT_CONFLICT_STATUS: ConflictStatus = "open";

/**
 * Normalize a conflict pair to its canonical (lexicographically sorted) order so a pair
 * is recorded / memoized ONCE regardless of detection order (PRD-058b Data Model). The
 * SINGLE canonicalizer the detector's `keep-both` memoization (AC-55b.2.4) and the
 * projection writer both call, so the normalized key is identical on every path. Pure.
 */
export function normalizeConflictPair(a: string, b: string): { readonly aId: string; readonly bId: string } {
	return a <= b ? { aId: a, bId: b } : { aId: b, bId: a };
}

/**
 * `memory_conflicts` — the conflict current-state projection (PRD-058b Data Model). One row
 * per NORMALIZED memory pair:
 *
 *   - `id`            the conflict identity (a UUID the writer mints).
 *   - `memory_a_id`   / `memory_b_id`  the NORMALIZED (sorted) pair (recorded once).
 *   - `claim_slot`    the claim-slot key the two memories speak to (nullable: a non-entity
 *                     fact may fall back to a subject hash — PRD-058b open question).
 *   - `signal`        the deciding {@link ConflictSignal} (TEXT, default `'lexical'`).
 *   - `contra_score`  the `Contra(a,b) ∈ [0,1]` that cleared `θ_detect` (the audit trail).
 *   - `margin`        the resolution `margin ∈ [0,1]` (nullable: unset until resolved).
 *   - `verdict`       the {@link ConflictVerdict} (TEXT, default `'review'` — the SAFETY default).
 *   - `winner_id`     the winning memory id (nullable: unset for `keep-both` / pre-resolution).
 *   - `kappa_loser`   the `κ` assigned to the loser (`0` supersede / `ρ` review / `1` keep-both;
 *                     nullable until resolved).
 *   - `status`        the {@link ConflictStatus} (TEXT, default `'open'`).
 *   - `confidence`    the detection/resolution confidence (mirrors the `memory_history` audit field).
 *   - `created_at`    the detection time (ISO-8601 TEXT, like every other catalog stamp).
 *   - `agent_id` / `visibility`  the engine scope (D-2).
 *   - `version`       the version-bump column (a status change appends a new version; the live
 *                     row is `ORDER BY version DESC LIMIT 1`), so the projection refresh is the
 *                     same append-only shape the rest of the catalog uses — never an in-place UPDATE.
 *
 * Every `NOT NULL` column carries a `DEFAULT` so the heal `ALTER ADD COLUMN` backfills cleanly
 * (PRD-002c). `margin` / `winner_id` / `kappa_loser` are NULLABLE (NULL = not-yet-resolved), the
 * heal-safe "no default needed, NULL is the implicit default" shape `memories.last_reinforced_at`
 * uses.
 */
export const MEMORY_CONFLICTS_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "memory_a_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "memory_b_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "claim_slot", sql: "TEXT" },
	{ name: "signal", sql: "TEXT NOT NULL DEFAULT 'lexical'" },
	{ name: "contra_score", sql: "FLOAT4 NOT NULL DEFAULT 0.0" },
	{ name: "margin", sql: "FLOAT4" },
	{ name: "verdict", sql: "TEXT NOT NULL DEFAULT 'review'" },
	{ name: "winner_id", sql: "TEXT" },
	{ name: "kappa_loser", sql: "FLOAT4" },
	{ name: "status", sql: "TEXT NOT NULL DEFAULT 'open'" },
	{ name: "confidence", sql: "FLOAT4 NOT NULL DEFAULT 0.0" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT 'default'" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'global'" },
	// The version-bump column: a status change APPENDS a new version (the live row is
	// MAX(version)); a wrong resolution is reversible by another bump (AC-55b.4.2/4.3),
	// never an in-place UPDATE DeepLake can coalesce. Mirrors `skills`/`entity_attributes`.
	{ name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
]);

/** The bare table identifier, exported so the runtime modules name it without re-stating a literal. */
export const MEMORY_CONFLICTS_TABLE = "memory_conflicts" as const;

/**
 * The 058b group, spread into `CATALOG` by the barrel. `version-bumped` so a status change
 * appends a fresh version row (the live verdict is `ORDER BY version DESC LIMIT 1`) and a wrong
 * resolution is reversible by another bump, never an in-place UPDATE DeepLake can coalesce
 * (PRD-058b Technical Considerations: append-only supersession).
 */
export const MEMORY_CONFLICTS_TABLES: readonly CatalogTable[] = defineGroup([
	{
		name: MEMORY_CONFLICTS_TABLE,
		columns: MEMORY_CONFLICTS_COLUMNS,
		pattern: "version-bumped",
		embeddingColumns: [],
		scope: "agent",
	},
]);

/**
 * Build the OPEN-conflict loser projection read (PRD-058b recall-time suppression): the
 * `memory_*_id` + `winner_id` + `kappa_loser` of every conflict whose live version is `open`
 * for the scope. Recall reads this to suppress a `κ = ρ` loser (the non-winner side of an open
 * `review` conflict). `version-bumped` semantics: the live row per pair is the highest version,
 * so the read takes the MAX(version) row per `(memory_a_id, memory_b_id)`. Every identifier
 * routes through `sqlIdent` (SQL-safety floor); no value is interpolated here (the scope rides
 * the partition + the ANDed scope clause the caller appends). FAIL-SOFT at the call site: a
 * missing table degrades to "no suppression" (recall returns both sides), never a throw.
 */
export function buildOpenConflictProjectionSql(): string {
	const tbl = sqlIdent(MEMORY_CONFLICTS_TABLE);
	const aCol = sqlIdent("memory_a_id");
	const bCol = sqlIdent("memory_b_id");
	const winnerCol = sqlIdent("winner_id");
	const kappaCol = sqlIdent("kappa_loser");
	const verdictCol = sqlIdent("verdict");
	const statusCol = sqlIdent("status");
	const versionCol = sqlIdent("version");
	// The live version per pair is the MAX(version) row; a sub-select pins it so a superseded /
	// reversed earlier version never leaks into the open projection.
	return (
		`SELECT ${aCol} AS memory_a_id, ${bCol} AS memory_b_id, ${winnerCol} AS winner_id, ` +
		`${kappaCol} AS kappa_loser, ${verdictCol} AS verdict, ${statusCol} AS status, ${versionCol} AS version ` +
		`FROM "${tbl}" t ` +
		`WHERE ${versionCol} = ( ` +
		`SELECT MAX(${versionCol}) FROM "${tbl}" i ` +
		`WHERE i.${aCol} = t.${aCol} AND i.${bCol} = t.${bCol} ) ` +
		`AND ${statusCol} = ${sLiteral(DEFAULT_CONFLICT_STATUS)}`
	);
}

/**
 * Build the SCOPED, PAGINATED list of conflicts whose LIVE (highest-version) row matches the given
 * status (PRD-058d read API — `GET /api/memories/conflicts?status=open`). The dashboard + CLI read
 * this to render the conflict queue: each row carries the pair, the verdict, and the status. Mirrors
 * {@link buildOpenConflictProjectionSql}'s MAX(version) sub-select so a superseded/reversed earlier
 * version never leaks. The org/workspace partition rides the `storage.query` scope (the engine-table
 * convention, D-2); `status` routes through `sLiteral`; `limit` is a clamped integer interpolated as
 * a bare numeral (the same audit-safe LIMIT shape the rest of the data layer uses). Every identifier
 * routes through `sqlIdent` (SQL-safety floor).
 */
export function buildConflictListSql(status: ConflictStatusLike, limit: number): string {
	const tbl = sqlIdent(MEMORY_CONFLICTS_TABLE);
	const idCol = sqlIdent("id");
	const aCol = sqlIdent("memory_a_id");
	const bCol = sqlIdent("memory_b_id");
	const verdictCol = sqlIdent("verdict");
	const winnerCol = sqlIdent("winner_id");
	const statusCol = sqlIdent("status");
	const contraCol = sqlIdent("contra_score");
	const marginCol = sqlIdent("margin");
	const createdCol = sqlIdent("created_at");
	const versionCol = sqlIdent("version");
	const safeLimit = Math.max(1, Math.trunc(limit));
	return (
		`SELECT ${idCol} AS id, ${aCol} AS memory_a_id, ${bCol} AS memory_b_id, ${verdictCol} AS verdict, ` +
		`${winnerCol} AS winner_id, ${statusCol} AS status, ${contraCol} AS contra_score, ${marginCol} AS margin, ` +
		`${createdCol} AS created_at ` +
		`FROM "${tbl}" t ` +
		`WHERE ${versionCol} = ( ` +
		`SELECT MAX(${versionCol}) FROM "${tbl}" i ` +
		`WHERE i.${idCol} = t.${idCol} ) ` +
		`AND ${statusCol} = ${sLiteral(status)} ` +
		`ORDER BY ${createdCol} DESC LIMIT ${safeLimit}`
	);
}

/** A conflict status the list filter accepts (a member of {@link CONFLICT_STATUSES}, kept loose for the API boundary). */
export type ConflictStatusLike = ConflictStatus;

/**
 * Build the by-id lookup of a conflict's LIVE (highest-version) row (PRD-058b resolve endpoint).
 * The endpoint reads its target conflict by `id` at MAX(version) so a prior version (an earlier
 * detection or a since-reversed resolution) never shadows the current verdict. Every identifier
 * routes through `sqlIdent`, the id through `sLiteral`.
 */
export function buildConflictByIdSql(conflictId: string): string {
	const tbl = sqlIdent(MEMORY_CONFLICTS_TABLE);
	const idCol = sqlIdent("id");
	const versionCol = sqlIdent("version");
	return (
		`SELECT * FROM "${tbl}" ` +
		`WHERE ${idCol} = ${sLiteral(conflictId)} ` +
		`ORDER BY ${versionCol} DESC LIMIT 1`
	);
}
