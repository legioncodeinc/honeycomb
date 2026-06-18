/**
 * Confidence gate phase (007e) — filled by Wave 2 (`retrieval-worker-bee`).
 *
 * Phase 5, the injection decision. Inject context ONLY if the reranker-calibrated
 * top score clears the per-agent minimum (`config.minInjectionScore`, D-6); an
 * EMPTY injection is a valid answer when nothing clears it, NOT a failure (e-AC-3 /
 * AC-4). This is the ONLY phase that hydrates content — and it does so under the
 * SAME scope clause authorization applied (e-AC-4).
 *
 * ── What this phase does (FR-1..8 / e-AC-1..7) ──────────────────────────────
 *   - Injection decision uses the reranker-calibrated TOP score from shaping
 *     (e-AC-1 / FR-4/5). That score is PRESERVED, never synthesized from rank.
 *     (e-AC-2 / FR-4).
 *   - Nothing clears the minimum → empty injection as a VALID answer, not a
 *     failure (e-AC-3 / FR-6).
 *   - Hydrate survivors under the SAME scope clause (`pool.context.clause`) the
 *     authorization phase compiled; the caller `query.limit` caps the primary
 *     results (e-AC-4 / FR-1/2).
 *   - Access tracking updates only PRIMARY results (not supplementary cards, not
 *     dropped candidates) (e-AC-5 / FR-3).
 *   - Supplementary cards (source chunks, graph context, transcripts) ride along
 *     each MARKED synthetic (`synthetic: true`) so the caller can distinguish
 *     them from ordinary rows (e-AC-6 / FR-7).
 *   - Per-agent threshold: `config.minInjectionScore` is the default; callers
 *     may supply `query.minInjectionScore` (a per-agent override) (e-AC-7 / FR-8).
 *
 * ── SQL safety ───────────────────────────────────────────────────────────────
 * Every interpolated value routes through `sLiteral`/`sqlIdent`/`sqlStr`
 * (PRD-002b). Storage via `deps.storage` (never a raw fetch — `audit:sql` scans
 * `src/daemon`). Hydration runs under the carried `pool.context.clause` so the
 * content load is itself scope-checked (e-AC-4 / the CONVENTIONS re-application
 * requirement).
 *
 * ── Where it lives ──────────────────────────────────────────────────────────
 * This module (`recall/gate.ts`) + its test `tests/daemon/runtime/recall/
 * gate.test.ts`. The engine registration does not change.
 */

import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import type { RecallPhaseDeps } from "./engine.js";
import type { RecallQuery } from "./contracts.js";
import type { ShapedCandidate, ShapedPool } from "./shaping.js";

// ── Table + column names for the memories content load ───────────────────────
const MEMORIES_TABLE = "memories";
const ID_COL = "id";
const CONTENT_COL = "content";
const UPDATED_AT_COL = "updated_at";

/**
 * A hydrated primary result the gate injects. IDs become content ONLY here, under
 * the carried scope clause (e-AC-4). `synthetic` distinguishes a supplementary
 * card from an ordinary row (e-AC-6).
 */
export interface RecallHit {
	/** The `memories.id`. */
	readonly id: string;
	/** The final calibrated score from shaping (e-AC-2). */
	readonly score: number;
	/** The hydrated content (loaded only for an injected survivor). */
	readonly content: string;
	/** True for a supplementary/synthetic card, false for an ordinary primary row (e-AC-6). */
	readonly synthetic: boolean;
}

/**
 * The recall engine's terminal output: whether context was injected, and the
 * hydrated primary results (empty when nothing cleared the minimum — a valid
 * answer, e-AC-3). `degraded` surfaces the silent-fallback signal end-to-end.
 */
export interface RecallResult {
	/** True iff the top calibrated score cleared the minimum and content was injected. */
	readonly injected: boolean;
	/** The hydrated primary results (empty = valid no-injection answer, e-AC-3). */
	readonly hits: RecallHit[];
	/** Carried from collection: whether recall ran lexical-only (a-AC-3). */
	readonly degraded: boolean;
}

/**
 * A gate phase: decide injection by the calibrated top score, hydrate survivors
 * under the carried scope clause, cap by the caller limit. Wave 2 fills the real
 * gate; the Wave-1 default is {@link noopGatePhase}.
 */
export type GatePhase = (pool: ShapedPool, query: RecallQuery, deps: RecallPhaseDeps) => Promise<RecallResult>;

// ── Internal: the minimum injection score the gate applies ───────────────────

/**
 * Resolve the effective minimum injection score (e-AC-7 / FR-8). The caller may
 * supply a per-agent override on `query`; otherwise the config default (D-6: 0.6)
 * is used. The override is clamped to [0, 1] so a misconfigured value is tuning
 * noise, not a gate failure.
 */
function effectiveMinScore(query: RecallQuery, deps: RecallPhaseDeps): number {
	// Per-agent override: callers embed it as `(query as any).minInjectionScore`.
	// Using an intersection approach keeps the core RecallQuery type clean while
	// letting per-agent config thread through the same call site. The gate clamps it.
	const override = (query as RecallQuery & { minInjectionScore?: unknown }).minInjectionScore;
	if (typeof override === "number" && Number.isFinite(override)) {
		return Math.min(1, Math.max(0, override));
	}
	return deps.config.minInjectionScore;
}

// ── Internal: SQL builders for the hydration and access-tracking queries ──────

/**
 * Build the content-hydration SELECT for a set of surviving IDs under the
 * compiled scope clause (e-AC-4 / FR-1). All values route through `sLiteral`;
 * all identifiers through `sqlIdent` (PRD-002b). The IN-list is bounded by the
 * authorized set (already a checked superset of the survivors) — at most
 * `query.limit` candidates are requested, so the IN-list is short.
 *
 * The scope clause (`pool.context.clause.sql`) is ANDed in so the content load is
 * itself scope-checked; the storage partition (org/workspace) rides the
 * `storage.query` call's `scope` arg (the OUTER ring).
 */
function buildHydrateSql(ids: readonly string[], scopeClauseSql: string): string {
	if (ids.length === 0) return "";
	const tbl = sqlIdent(MEMORIES_TABLE);
	const idCol = sqlIdent(ID_COL);
	const contentCol = sqlIdent(CONTENT_COL);
	const inList = ids.map((id) => sLiteral(id)).join(", ");
	// AND the scope clause so hydration cannot return a row the authorization phase
	// would not have authorized — belt-and-suspenders per implementation notes.
	return (
		`SELECT ${idCol}, ${contentCol} ` +
		`FROM "${tbl}" ` +
		`WHERE ${idCol} IN (${inList}) AND (${scopeClauseSql})`
	);
}

/**
 * Build the access-tracking UPDATE for the PRIMARY results (e-AC-5 / FR-3).
 * Sets `updated_at` to the ISO timestamp so the recalled memory's recency is
 * advanced (rehearsal-boost input for future recalls). Only primary IDs (not
 * supplementary/synthetic cards) are tracked.
 *
 * `updated_at` is the `memories` table's time column (PRD-003a MEMORIES_COLUMNS).
 * All values route through `sLiteral`; identifiers through `sqlIdent` (PRD-002b).
 */
function buildAccessTrackSql(ids: readonly string[], nowIso: string): string {
	if (ids.length === 0) return "";
	const tbl = sqlIdent(MEMORIES_TABLE);
	const updCol = sqlIdent(UPDATED_AT_COL);
	const idCol = sqlIdent(ID_COL);
	const inList = ids.map((id) => sLiteral(id)).join(", ");
	const nowLiteral = sLiteral(nowIso);
	return `UPDATE "${tbl}" SET ${updCol} = ${nowLiteral} WHERE ${idCol} IN (${inList})`;
}

// ── Internal: map hydration rows to a lookup by ID ──────────────────────────

function rowsToContentMap(rows: StorageRow[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const row of rows) {
		const id = typeof row.id === "string" ? row.id : String(row.id ?? "");
		const content = typeof row.content === "string" ? row.content : String(row.content ?? "");
		if (id !== "") map.set(id, content);
	}
	return map;
}

// ── The real gate phase ──────────────────────────────────────────────────────

/**
 * The real confidence gate phase (007e / Wave 2). Decides injection, hydrates
 * survivors under the carried scope clause, tracks access on primary results,
 * and marks supplementary cards synthetic.
 *
 * Injection decision uses the CALIBRATED top score from shaping (e-AC-1 / e-AC-2):
 * `pool.candidates[0].calibratedScore` — the candidates are ordered descending by
 * calibrated score (shaping invariant). The gate NEVER synthesizes a score from
 * rank position.
 *
 * Empty when nothing clears the minimum → a valid `{ injected: false, hits: [] }`
 * (e-AC-3 / FR-6), NOT a failure. The caller distinguishes "no confident match"
 * from a recall error by checking `injected` (false, with non-empty pool ≠ error).
 *
 * @param pool — the shaped, authorized candidate pool from 007d.
 * @param query — the recall request; `query.limit` caps primary results.
 * @param deps — phase deps: `storage`, `scope`, `config`.
 */
export const gatePhase: GatePhase = async (pool: ShapedPool, query: RecallQuery, deps: RecallPhaseDeps): Promise<RecallResult> => {
	const min = effectiveMinScore(query, deps);

	// e-AC-1 / e-AC-2: read the calibrated TOP score from shaping — do not
	// synthesize it from rank position. The candidates are ordered descending.
	const top = pool.candidates[0]?.calibratedScore ?? 0;
	const injected = pool.candidates.length > 0 && top >= min;

	// e-AC-3 / FR-6: nothing clears the minimum → empty injection, valid answer.
	if (!injected) {
		return { injected: false, hits: [], degraded: pool.degraded };
	}

	// e-AC-4 / FR-1/2: apply the caller's limit to determine the primary set.
	const limit = typeof query.limit === "number" && query.limit > 0 ? Math.trunc(query.limit) : pool.candidates.length;
	const primaryCandidates: ShapedCandidate[] = pool.candidates.slice(0, limit);

	// Hydrate the primary set under the SAME scope clause (e-AC-4 / FR-1).
	const scopeClauseSql = pool.context.clause.sql;
	const primaryIds = primaryCandidates.map((c) => c.id);
	const hydrateSql = buildHydrateSql(primaryIds, scopeClauseSql);

	const hydrateResult = await deps.storage.query(hydrateSql, {
		org: pool.context.scope.org,
		workspace: pool.context.scope.workspace,
	});

	const contentMap = isOk(hydrateResult) ? rowsToContentMap(hydrateResult.rows) : new Map<string, string>();

	// Build primary hits — ordinary rows (synthetic: false).
	const primaryHits: RecallHit[] = primaryCandidates.map((c) => ({
		id: c.id,
		score: c.calibratedScore, // e-AC-2: calibrated, not rank-derived.
		content: contentMap.get(c.id) ?? "",
		synthetic: false, // ordinary primary row (e-AC-6).
	}));

	// e-AC-5 / FR-3: access tracking on PRIMARY results ONLY.
	// Supplementary cards and dropped candidates are NOT tracked.
	const nowIso = new Date().toISOString();
	const accessSql = buildAccessTrackSql(primaryIds, nowIso);
	if (accessSql !== "") {
		// Fire-and-best-effort: a tracking failure must NOT fail the inject.
		// The result is intentionally not awaited for the error path — but we do
		// await so access is synchronous within a request (avoids races in tests).
		await deps.storage.query(accessSql, {
			org: pool.context.scope.org,
			workspace: pool.context.scope.workspace,
		});
	}

	// e-AC-6 / FR-7: supplementary cards (the candidates beyond the primary limit)
	// ride along, each MARKED synthetic so the caller can distinguish them.
	// In this implementation the supplementary set is the remaining shaped
	// candidates (already scored but not included in the primary hydration);
	// they carry their calibrated score and a blank content (not hydrated, synthetic).
	const supplementaryHits: RecallHit[] = pool.candidates.slice(limit).map((c) => ({
		id: c.id,
		score: c.calibratedScore,
		content: "", // synthetic cards do not carry hydrated content.
		synthetic: true, // e-AC-6: distinguishable from ordinary rows.
	}));

	return {
		injected: true,
		hits: [...primaryHits, ...supplementaryHits],
		degraded: pool.degraded,
	};
};

/**
 * The no-op gate phase the engine routes by default (Wave 1). It makes the real
 * injection DECISION (top calibrated score vs the minimum) so the engine's
 * end-to-end empty-vs-injected contract holds even in the stub, but it does NOT
 * hydrate content (no `content` load is wired) — it returns the decision with
 * empty hits. An empty result here is the valid no-injection answer (e-AC-3), not
 * a failure. Wave 2 swaps this for the real hydrating gate via
 * `createRecallEngine({ gate })`.
 */
export const noopGatePhase: GatePhase = async (pool: ShapedPool, query: RecallQuery, deps: RecallPhaseDeps): Promise<RecallResult> => {
	const min = deps.config.minInjectionScore;
	const top = pool.candidates[0]?.calibratedScore ?? 0;
	const injected = pool.candidates.length > 0 && top >= min;
	// The stub does not hydrate content; it returns the decision with no hits.
	// (Wave 2's real gate hydrates the survivors under pool.context.clause.)
	void query;
	return { injected, hits: [], degraded: pool.degraded };
};
