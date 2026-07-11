/**
 * PRD-058b, the conflict resolver (the weighted winner-selection + `κ` assignment).
 *
 * Treat a claim slot as a variable with competing memory-evidence. Each memory `m_i`
 * votes for its outcome `o_i` with weight (`memory-lifecycle-scoring.md` Term 4):
 *
 *   w_i      = A(m_i,t) · C(m_i) · prov(m_i) · corr(o_i)
 *   score(o) = Σ_{i : o_i = o} w_i
 *   winner   = argmax_o score(o)
 *   margin   = 1 − score(runner_up) / score(winner)
 *
 *   - `A`    = activation from 058a/058e (fresher, more-reinforced evidence votes harder).
 *             Where it is not computed for a candidate, defaults to `A_simple` identity `1`.
 *   - `C`    = calibrated confidence from 058e. Until calibrated, `C = f` (the raw confidence);
 *             where absent, identity `1`.
 *   - `prov` = provenance arm-class weight: distilled `memory` = {@link PROV_DISTILLED} (1.0),
 *             raw `session` = {@link PROV_RAW} (0.4) — reusing the recall weighting.
 *   - `corr` = corroboration bonus, log-scaled over INDEPENDENT sources so duplicated rows
 *             cannot inflate a side: `corr(o) = 1 + γ · ln(1 + n_independent(o))` (γ default
 *             {@link DEFAULT_GAMMA} = 0.5).
 *
 * The margin selects the verdict and the `κ` assigned to the LOSING side:
 *
 *   | margin ≥ τ_supersede                 | supersede  | κ_loser = 0  (append-only version bump) |
 *   | τ_review ≤ margin < τ_supersede      | review     | κ_loser = ρ  (soft-suppress, reversible) |
 *   | margin < τ_review AND low Contra     | keep-both  | κ_loser = 1  (both live; pair memoized)  |
 *
 * The WINNER always keeps `κ = 1`; an uncontested memory is `κ = 1` by the empty-conflict
 * default. `κ` is the ONLY zeroing term in the master equation, so the default OPEN verdict
 * is `review` (never auto-`supersede`), suppression is reversible, and `keep-both` false
 * positives are memoized — the highest-stakes-correctness posture the PRD mandates.
 *
 * ── Append-only supersession (PRD-058b Technical Considerations) ─────────────
 * `supersede` reuses the PRD-008 supersession primitive — a version-bumped APPEND that marks
 * the loser superseded — NEVER an in-place UPDATE (DeepLake coalesces concurrent UPDATEs and
 * can drop an edit). The loser's `κ = 0` is a property of `MAX(version)` exclusion, not a
 * deleted row, so a reversal (AC-55b.4.2) is just another version bump restoring `κ = 1`. The
 * loser memory itself is superseded through the SAME `controlled-writes` version-bump path the
 * user-driven forget uses (`store.ts` `forgetMemory` → soft-delete tombstone via version bump).
 *
 * ── Audit + projection (PRD-058b §4) ─────────────────────────────────────────
 * Every detection and every resolution APPENDS to `memory_history` (actor, reason, confidence)
 * and PROJECTS the current state into `memory_conflicts` (a version-bumped row; the live verdict
 * is `MAX(version)`). A read-back of a freshly-written conflict row POLLS TO CONVERGENCE (DeepLake
 * reads flap stale segments), never a single immediate read.
 *
 * The pure math ({@link resolveConflict}) is the testable core (no I/O); the persistence
 * ({@link projectConflict}, {@link supersedeLoser}, {@link appendConflictHistory}) is the
 * side-effecting orchestration over the injected {@link StorageQuery}.
 */

import { randomUUID } from "node:crypto";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk } from "../../storage/result.js";
import { appendOnlyInsert, appendVersionBumped, type ColumnValue, val, type RowValues } from "../../storage/writes.js";
import { healTargetFor } from "../../storage/catalog/index.js";
import { readConverged, rowPresent } from "../../storage/converge.js";
import {
	buildConflictByIdSql,
	buildOpenConflictProjectionSql,
	type ConflictSignal,
	type ConflictStatus,
	type ConflictVerdict,
	MEMORY_CONFLICTS_TABLE,
	normalizeConflictPair,
} from "../../storage/catalog/memory-conflicts.js";
import { forgetMemory, modifyMemory, type MemoryWriteDeps } from "./store.js";
import {
	type ConflictCandidate,
	type ConflictDetectDeps,
	type DetectedConflict,
	detectConflicts,
} from "./conflict-detect.js";
import type { ConflictSuppressionSource } from "./recall.js";
import type { MemoryRecallHit } from "./recall.js";

// ── Scoring-model defaults (the w_i factors + the verdict thresholds) ─────────

/** Provenance arm-class weight for a distilled `memory` (PRD-058b: `prov = 1.0`). */
export const PROV_DISTILLED = 1.0;
/** Provenance arm-class weight for a raw `session` row (PRD-058b: `prov = 0.4`). */
export const PROV_RAW = 0.4;
/** Corroboration weight `γ` (`memory-lifecycle-scoring.md`, default `0.5`). */
export const DEFAULT_GAMMA = 0.5;
/** `τ_supersede`, the supersede margin (`memory-lifecycle-scoring.md`, CRA-tuned default `0.5`). */
export const DEFAULT_TAU_SUPERSEDE = 0.5;
/** `τ_review`, the review margin (`memory-lifecycle-scoring.md`, CRA-tuned default `0.15`). */
export const DEFAULT_TAU_REVIEW = 0.15;
/** `ρ`, the open-conflict suppression `κ` for the losing side (default `0`, fully suppress, reversible). */
export const DEFAULT_RHO = 0;
/** The `Contra` ceiling below which a low-margin pair is `keep-both` (a genuine false positive). */
export const DEFAULT_KEEP_BOTH_CONTRA = 0.6;

// ── The voter + the resolution result ────────────────────────────────────────

/**
 * One memory's vote in a conflict (PRD-058b §2). The voter asserts an `outcome` (the claim's
 * value — opposite outcomes are what conflict) and carries the `w_i` factors. `A`/`C` default to
 * identity `1` when not computed for the candidate (PRD-058b Dependencies: "before those land,
 * `A` and `C` default to their identity values"). `sourceId` identifies the INDEPENDENT source so
 * `corr` counts duplicated rows once.
 */
export interface ConflictVoter {
	/** The memory id (the row that votes). */
	readonly memoryId: string;
	/** The asserted outcome (the claim value); equal outcomes agree, distinct outcomes compete. */
	readonly outcome: string;
	/** The activation `A(m,t) ∈ (0,1]`. Default identity `1` (058a `A_simple` / no source wired). */
	readonly activation?: number;
	/** The calibrated confidence `C(m) ∈ [0,1]`. Default identity `1` (058e dormant → `C = f`, or absent). */
	readonly confidence?: number;
	/** The provenance arm-class: distilled `memory` (`prov = 1.0`) vs raw `session` (`prov = 0.4`). */
	readonly arm: "memory" | "session";
	/**
	 * The INDEPENDENT-source id this vote comes from. Two votes with the SAME `sourceId` count as one
	 * independent source for `corr` (duplicated rows do not inflate a side, AC-55b.3.3). ABSENT → the
	 * `memoryId` is its own independent source.
	 */
	readonly sourceId?: string;
}

/** The resolution math result (pure): the winner, the margin, the verdict, and the loser's `κ`. */
export interface ConflictResolution {
	/** The winning outcome (`argmax_o score(o)`). */
	readonly winnerOutcome: string;
	/** The memory id that carries the winning outcome with the HIGHEST weight (the canonical winner row). */
	readonly winnerId: string;
	/** The `score(o)` per distinct outcome (the audit trail). */
	readonly scores: Readonly<Record<string, number>>;
	/** `margin = 1 − score(runner_up)/score(winner)` (1 when uncontested / single outcome). */
	readonly margin: number;
	/** The verdict the margin selected. */
	readonly verdict: ConflictVerdict;
	/** The `κ` assigned to the LOSING side (`0` supersede / `ρ` review / `1` keep-both). */
	readonly kappaLoser: number;
	/** The losing memory ids (every voter NOT on the winning outcome). */
	readonly loserIds: readonly string[];
}

/** Resolution tunables (all default to the scoring-model values). */
export interface ConflictResolveParams {
	/** Corroboration weight `γ` (default {@link DEFAULT_GAMMA}). */
	readonly gamma?: number;
	/** Supersede margin `τ_supersede` (default {@link DEFAULT_TAU_SUPERSEDE}). */
	readonly tauSupersede?: number;
	/** Review margin `τ_review` (default {@link DEFAULT_TAU_REVIEW}). */
	readonly tauReview?: number;
	/** Open-conflict suppression `ρ` (default {@link DEFAULT_RHO}). */
	readonly rho?: number;
	/** The `Contra` of the detected pair, used to gate `keep-both` (a low-margin pair with HIGH Contra is `review`, not `keep-both`). */
	readonly contraScore?: number;
	/** The `keep-both` Contra ceiling (default {@link DEFAULT_KEEP_BOTH_CONTRA}). */
	readonly keepBothContra?: number;
}

/** Clamp into `[0,1]`; non-finite → the supplied fallback (identity factors default to 1). */
function unitOr(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(1, Math.max(0, value));
}

/** The provenance weight for an arm class (PRD-058b §2). */
export function provWeight(arm: "memory" | "session"): number {
	return arm === "memory" ? PROV_DISTILLED : PROV_RAW;
}

/**
 * The corroboration bonus for an outcome (PRD-058b §2): `corr(o) = 1 + γ · ln(1 + n_independent(o))`,
 * counting INDEPENDENT sources only (AC-55b.3.3). `nIndependent` is the count of DISTINCT source ids
 * backing the outcome, so duplicated rows from one source count once. Pure; `n ≤ 0` → `1` (no bonus).
 */
export function corroboration(nIndependent: number, gamma = DEFAULT_GAMMA): number {
	const n = Number.isFinite(nIndependent) && nIndependent > 0 ? nIndependent : 0;
	const g = Number.isFinite(gamma) && gamma >= 0 ? gamma : DEFAULT_GAMMA;
	return 1 + g * Math.log(1 + n);
}

/** The per-voter weight `w_i = A · C · prov · corr` (PRD-058b §2). `corr` is supplied per-outcome. */
function voterWeight(voter: ConflictVoter, corr: number): number {
	const a = unitOr(voter.activation, 1); // identity when no activation source (058a/058e default).
	const c = unitOr(voter.confidence, 1); // identity when calibration dormant (C = f, or absent).
	return a * c * provWeight(voter.arm) * corr;
}

/**
 * Resolve a conflict from its voters (PRD-058b §2) — the PURE math core. Computes `score(o)` per
 * outcome (each voter weighted `w_i = A·C·prov·corr`, `corr` counting independent sources once),
 * picks the winner by `argmax`, computes `margin = 1 − score(runner_up)/score(winner)`, and routes
 * to the verdict + the loser's `κ` per the verdict table. RULES:
 *  - A SINGLE outcome (uncontested, or all voters agree) → `margin = 1`, `verdict = keep-both`
 *    with NO losers and `κ_loser = 1` (nothing to suppress, AC-55b.1.4).
 *  - `margin ≥ τ_supersede` → `supersede`, `κ_loser = 0`.
 *  - `τ_review ≤ margin < τ_supersede` → `review`, `κ_loser = ρ` (AC-55b.3.2).
 *  - `margin < τ_review`: `keep-both` (`κ_loser = 1`) ONLY when `Contra` is low (a genuine false
 *    positive); a low margin with HIGH `Contra` stays `review` (a real but close contradiction is
 *    NOT silently kept-both — the safety posture).
 * No I/O, no clock, never throws.
 */
export function resolveConflict(voters: readonly ConflictVoter[], params: ConflictResolveParams = {}): ConflictResolution {
	const gamma = params.gamma ?? DEFAULT_GAMMA;
	const tauSupersede = params.tauSupersede ?? DEFAULT_TAU_SUPERSEDE;
	const tauReview = params.tauReview ?? DEFAULT_TAU_REVIEW;
	const rho = params.rho ?? DEFAULT_RHO;
	const keepBothContra = params.keepBothContra ?? DEFAULT_KEEP_BOTH_CONTRA;

	// Group voters by outcome; count DISTINCT independent sources per outcome for `corr`.
	const byOutcome = new Map<string, ConflictVoter[]>();
	for (const v of voters) {
		const list = byOutcome.get(v.outcome) ?? [];
		list.push(v);
		byOutcome.set(v.outcome, list);
	}

	const scores: Record<string, number> = {};
	const bestVoterByOutcome = new Map<string, { id: string; weight: number }>();
	for (const [outcome, group] of byOutcome) {
		const sources = new Set(group.map((v) => v.sourceId ?? v.memoryId));
		const corr = corroboration(sources.size, gamma);
		let sum = 0;
		let best: { id: string; weight: number } | undefined;
		for (const v of group) {
			const w = voterWeight(v, corr);
			sum += w;
			if (best === undefined || w > best.weight) best = { id: v.memoryId, weight: w };
		}
		scores[outcome] = sum;
		if (best !== undefined) bestVoterByOutcome.set(outcome, best);
	}

	// Order outcomes by score DESC to pick winner + runner-up.
	const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
	const winnerEntry = ranked[0];
	// Degenerate: no voters → a vacuous uncontested keep-both (κ = 1, no losers).
	if (winnerEntry === undefined) {
		return { winnerOutcome: "", winnerId: "", scores: {}, margin: 1, verdict: "keep-both", kappaLoser: 1, loserIds: [] };
	}
	const [winnerOutcome, winnerScore] = winnerEntry;
	const winnerId = bestVoterByOutcome.get(winnerOutcome)?.id ?? "";
	const runnerScore = ranked[1]?.[1] ?? 0;

	// Single outcome (uncontested / unanimous) → margin 1, keep-both, no losers (AC-55b.1.4).
	if (ranked.length < 2 || winnerScore <= 0) {
		return { winnerOutcome, winnerId, scores, margin: 1, verdict: "keep-both", kappaLoser: 1, loserIds: [] };
	}

	const margin = 1 - runnerScore / winnerScore;
	const loserIds = voters.filter((v) => v.outcome !== winnerOutcome).map((v) => v.memoryId);

	let verdict: ConflictVerdict;
	let kappaLoser: number;
	if (margin >= tauSupersede) {
		verdict = "supersede";
		kappaLoser = 0;
	} else if (margin >= tauReview) {
		verdict = "review";
		kappaLoser = rho;
	} else {
		// margin < τ_review: keep-both ONLY when Contra is low (a genuine false positive). A low-margin
		// pair with HIGH Contra is a real-but-close contradiction → review (never silently kept), the
		// κ-is-the-only-zeroing-term safety posture (PRD-058b Risks).
		const contra = params.contraScore;
		if (contra === undefined || contra < keepBothContra) {
			verdict = "keep-both";
			kappaLoser = 1;
		} else {
			verdict = "review";
			kappaLoser = rho;
		}
	}
	return { winnerOutcome, winnerId, scores, margin, verdict, kappaLoser, loserIds };
}

// ── Persistence: project into memory_conflicts + append memory_history ───────

/** The actor stamped on a conflict `memory_history` row (the autonomous decision/maintenance pass). */
export const CONFLICT_ACTOR = "pipeline" as const;

/** A conflict-projection write request (one normalized pair → one version-bumped projection row). */
export interface ConflictProjection {
	/** A stable conflict id; reused across versions so the version bump targets the same logical pair. */
	readonly conflictId: string;
	/** The two memory ids (normalized internally). */
	readonly memoryAId: string;
	readonly memoryBId: string;
	/** The claim slot the pair shares (optional). */
	readonly claimSlot?: string;
	/** The deciding detection signal. */
	readonly signal: ConflictSignal;
	/** The `Contra(a,b)` audit score. */
	readonly contraScore: number;
	/** The resolution margin (absent for a detection-only projection). */
	readonly margin?: number;
	/** The verdict (defaults to the detection-time `review`). */
	readonly verdict: ConflictVerdict;
	/** The winner id (absent until resolved). */
	readonly winnerId?: string;
	/** The `κ` assigned to the loser (absent until resolved). */
	readonly kappaLoser?: number;
	/** The lifecycle status. */
	readonly status: ConflictStatus;
	/** The detection/resolution confidence. */
	readonly confidence: number;
	/** The detection timestamp (ISO-8601). */
	readonly createdAt: string;
	/** The agent scope column. */
	readonly agentId?: string;
}

/** Construction deps for the persistence helpers: the storage seam + an optional clock/id generator. */
export interface ConflictPersistDeps {
	/** The DeepLake storage client (daemon-only). */
	readonly storage: StorageQuery;
	/** A clock for timestamps; defaults to wall-clock. */
	readonly now?: () => Date;
	/** An id generator for the audit row; defaults to a UUID. */
	readonly newId?: () => string;
}

/** Build the `memory_conflicts` projection row values (every value through `val.*`). */
function projectionRow(p: ConflictProjection): RowValues {
	const { aId, bId } = normalizeConflictPair(p.memoryAId, p.memoryBId);
	const row: Array<readonly [string, ColumnValue]> = [
		["id", val.str(p.conflictId)],
		["memory_a_id", val.str(aId)],
		["memory_b_id", val.str(bId)],
		["claim_slot", p.claimSlot !== undefined ? val.text(p.claimSlot) : val.raw("NULL")],
		["signal", val.str(p.signal)],
		["contra_score", val.num(clampScore(p.contraScore))],
		["margin", p.margin !== undefined ? val.num(clampScore(p.margin)) : val.raw("NULL")],
		["verdict", val.str(p.verdict)],
		["winner_id", p.winnerId !== undefined ? val.str(p.winnerId) : val.raw("NULL")],
		["kappa_loser", p.kappaLoser !== undefined ? val.num(p.kappaLoser) : val.raw("NULL")],
		["status", val.str(p.status)],
		["confidence", val.num(clampScore(p.confidence))],
		["created_at", val.str(p.createdAt)],
		["agent_id", val.str(p.agentId ?? "default")],
	];
	return row;
}

/** Clamp a stored score into `[0,1]` (defensive: a hand-built projection cannot store an out-of-range value). */
function clampScore(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

/**
 * Project a conflict into `memory_conflicts` (PRD-058b §4) as a version-bumped APPEND keyed by the
 * conflict `id`: the live verdict is `MAX(version)`, so a status change is a fresh version, never an
 * in-place UPDATE DeepLake could coalesce. Returns the written version (for the read-back watermark).
 * Heal-aware (the table is created lazily on first write).
 */
export async function projectConflict(p: ConflictProjection, deps: ConflictPersistDeps, scope: QueryScope): Promise<number> {
	const { result, version } = await appendVersionBumped(deps.storage, healTargetFor(MEMORY_CONFLICTS_TABLE), scope, {
		keyColumn: "id",
		keyValue: p.conflictId,
		row: projectionRow(p),
	});
	if (!isOk(result)) return version; // fail-soft: the caller polls + treats a non-ok as not-yet-converged.
	return version;
}

/**
 * Poll `memory_conflicts` to convergence for a freshly-projected conflict id (PRD-058b: DeepLake reads
 * flap stale segments, so a live read-back POLLS, never a single immediate read). Returns the converged
 * row, or `null` when the bounded budget exhausts without the row appearing (fail-soft — the caller does
 * not block forever on a flapping segment).
 */
export async function readConflictConverged(
	conflictId: string,
	deps: ConflictPersistDeps,
	scope: QueryScope,
): Promise<Record<string, unknown> | null> {
	const result = await readConverged(deps.storage, buildConflictByIdSql(conflictId), scope, rowPresent("id", conflictId));
	if (!isOk(result) || result.rows.length === 0) return null;
	return result.rows[0] ?? null;
}

/**
 * Append the conflict event to `memory_history` (PRD-058b §4): one row recording the actor, the
 * operation (`conflict_detect` / `conflict_resolve` / `conflict_reverse`), the target memory id, and
 * the reason + confidence in `after_payload`. Append-only (never mutated), via the guarded
 * `appendVersionBumped`-free `memory_history` append path the store adapter uses. Returns whether the
 * append landed (surfaced so a failed audit is observable, never silently swallowed).
 */
export async function appendConflictHistory(
	args: {
		readonly memoryId: string;
		readonly operation: "conflict_detect" | "conflict_resolve" | "conflict_reverse";
		readonly reason: string;
		readonly confidence: number;
	},
	deps: ConflictPersistDeps,
	scope: QueryScope,
): Promise<boolean> {
	const now = (deps.now ?? (() => new Date()))().toISOString();
	const auditId = (deps.newId ?? randomUUID)();
	const payload = JSON.stringify({ operation: args.operation, reason: args.reason, confidence: clampScore(args.confidence) });
	const row: RowValues = [
		["id", val.str(auditId)],
		["memory_id", val.str(args.memoryId)],
		["changed_by", val.str(CONFLICT_ACTOR)],
		["operation", val.str(args.operation)],
		["before_payload", val.text("")],
		["after_payload", val.text(payload)],
		["created_at", val.str(now)],
	];
	const result = await appendOnlyInsert(deps.storage, healTargetFor("memory_history"), scope, row);
	return isOk(result);
}

/**
 * Supersede the LOSER memory via the PRD-008 append-only version bump (PRD-058b §3 / AC-55b.4.3):
 * mark it through the SAME `controlled-writes` version-bumped soft-delete path the user-driven
 * `forgetMemory` uses, NEVER a destructive delete or in-place UPDATE. The loser's `κ = 0` is then a
 * property of `MAX(version)` exclusion (the highest version is the tombstone), not a removed row, so a
 * reversal (AC-55b.4.2) is just another version bump. Returns whether the supersession landed.
 */
export async function supersedeLoser(
	loserId: string,
	reason: string,
	deps: MemoryWriteDeps,
	scope: QueryScope,
): Promise<boolean> {
	const result = await forgetMemory({ id: loserId, reason, scope }, deps);
	return result.outcome.action === "version_bumped";
}

/**
 * Reverse a `supersede` (PRD-058b AC-55b.4.2 / 4.3): restore the superseded loser to live (`κ` returns to
 * `1`) by ANOTHER append-only version bump (`modifyMemory` re-asserts its content as a new live version,
 * un-tombstoning it), refresh the `memory_conflicts` projection to `status = 'reversed'`, and append a
 * `conflict_reverse` `memory_history` event. NEVER a destructive delete or in-place mutate — the restore is
 * a NEW version, exactly as the supersession was, so history stays total.
 *
 * The `reversed` projection + audit are written ONLY when the loser RESTORE actually committed: if
 * `modifyMemory` is skipped or fails (no `version_bumped` outcome), the conflict is LEFT as-is and `false`
 * is returned, never marked `reversed` over a still-superseded row (which would leave `memory_conflicts`
 * out of sync with the memory). Returns whether the reversal landed.
 */
export async function reverseSupersession(
	args: {
		readonly conflictId: string;
		readonly loserId: string;
		readonly restoredContent: string;
		readonly memoryAId: string;
		readonly memoryBId: string;
		readonly reason: string;
		readonly signal: ConflictSignal;
		readonly contraScore: number;
		readonly winnerId?: string;
	},
	persist: ConflictPersistDeps,
	writeDeps: MemoryWriteDeps,
	scope: QueryScope,
): Promise<boolean> {
	// Restore the loser as a NEW live version (append-only) — un-tombstones it so `MAX(version)` is live again.
	// GUARD: only proceed to mark the conflict `reversed` when the restore actually committed (the same
	// `version_bumped` success signal `supersedeLoser` checks). A failed/skipped restore must NOT leave a
	// `reversed` projection over a still-superseded memory row.
	const restore = await modifyMemory({ id: args.loserId, content: args.restoredContent, reason: args.reason, scope }, writeDeps);
	if (restore.outcome.action !== "version_bumped") return false;

	const createdAt = (persist.now ?? (() => new Date()))().toISOString();
	await projectConflict(
		{
			conflictId: args.conflictId,
			memoryAId: args.memoryAId,
			memoryBId: args.memoryBId,
			signal: args.signal,
			contraScore: args.contraScore,
			verdict: "review", // the conflict re-opens for review under the operator's judgment.
			...(args.winnerId !== undefined ? { winnerId: args.winnerId } : {}),
			kappaLoser: 1, // the loser is restored to κ = 1.
			status: "reversed",
			confidence: args.contraScore,
			createdAt,
		},
		persist,
		scope,
	);
	await appendConflictHistory(
		{ memoryId: args.loserId, operation: "conflict_reverse", reason: args.reason, confidence: args.contraScore },
		persist,
		scope,
	);
	return true;
}

// ── Decision-stage detect-and-project orchestration (the candidate-set seam) ─

/** A voter the orchestrator builds per candidate (id + content + arm + the `A`/`C` factors). */
export interface CandidateVoter extends ConflictCandidate {
	/** The asserted outcome (the claim value) — opposite outcomes conflict. */
	readonly outcome: string;
	/** The activation `A(m,t)` (default identity 1). */
	readonly activation?: number;
	/** The calibrated confidence `C(m)` (default identity 1). */
	readonly confidence?: number;
	/** The independent-source id for `corr` (default the candidate id). */
	readonly sourceId?: string;
}

/** The result of one detect-and-project pass: the detected conflicts + the projected conflict ids. */
export interface DetectAndProjectResult {
	/** The conflicts that cleared `θ_detect`. */
	readonly detected: readonly DetectedConflict[];
	/** The `memory_conflicts` ids projected (one per detected pair). */
	readonly projectedIds: readonly string[];
}

/** Construction deps for {@link detectAndProject}: the detect deps + persist deps + resolution tunables. */
export interface DetectAndProjectDeps {
	/** The detection deps (embed + model seams, θ_detect, memo). */
	readonly detect: ConflictDetectDeps;
	/** The persistence deps (storage + clock + id generator). */
	readonly persist: ConflictPersistDeps;
	/** The resolution tunables (γ, τ thresholds, ρ). */
	readonly params?: ConflictResolveParams;
	/** An id generator for the conflict row; defaults to a UUID. */
	readonly newConflictId?: () => string;
}

/**
 * Detect conflicts over the decision-stage CANDIDATE SET and project each into `memory_conflicts`
 * (PRD-058b: "Detection runs over the candidate set the decision stage already fetches"). The decision
 * worker / maintenance pass calls this with the NEW fact + its existing candidates (the same set the
 * decision model saw). For each flagged pair it resolves the verdict from the two voters' weights, projects
 * an OPEN conflict row carrying the auto-computed verdict + winner + `κ_loser`, and appends a
 * `conflict_detect` `memory_history` event. Off the write path + fail-soft (a down model/embed degrades to
 * the lexical signal, a projection failure is swallowed) so a slow/failing judge never costs a memory.
 *
 * Returns the detected conflicts + the projected ids. The OPEN `review`-verdict rows are what recall's κ
 * gate reads to suppress the `κ = ρ` loser (AC-55b.1.3); a `supersede`-margin pair is projected `open`
 * with `verdict = supersede` + `winner_id`, so an operator (or an auto-apply pass) confirms it via the
 * resolve endpoint — the default open verdict is NEVER an auto-destructive supersede (the safety posture).
 */
export async function detectAndProject(
	candidates: readonly CandidateVoter[],
	scope: QueryScope,
	deps: DetectAndProjectDeps,
): Promise<DetectAndProjectResult> {
	const detected = await detectConflicts(candidates, deps.detect);
	const projectedIds: string[] = [];
	const byId = new Map(candidates.map((c) => [c.id, c]));
	const now = (deps.persist.now ?? (() => new Date()))().toISOString();

	for (const conflict of detected) {
		const a = byId.get(conflict.memoryAId);
		const b = byId.get(conflict.memoryBId);
		if (a === undefined || b === undefined) continue;
		// Resolve the verdict from the two voters' weights (the resolver picks winner + margin + κ_loser).
		const resolution = resolveConflict(
			[
				{ memoryId: a.id, outcome: a.outcome, arm: a.arm ?? "memory", ...(a.activation !== undefined ? { activation: a.activation } : {}), ...(a.confidence !== undefined ? { confidence: a.confidence } : {}), ...(a.sourceId !== undefined ? { sourceId: a.sourceId } : {}) },
				{ memoryId: b.id, outcome: b.outcome, arm: b.arm ?? "memory", ...(b.activation !== undefined ? { activation: b.activation } : {}), ...(b.confidence !== undefined ? { confidence: b.confidence } : {}), ...(b.sourceId !== undefined ? { sourceId: b.sourceId } : {}) },
			],
			{ ...(deps.params ?? {}), contraScore: conflict.contraScore },
		);
		const conflictId = (deps.newConflictId ?? randomUUID)();
		await projectConflict(
			{
				conflictId,
				memoryAId: conflict.memoryAId,
				memoryBId: conflict.memoryBId,
				...(conflict.claimSlot !== undefined ? { claimSlot: conflict.claimSlot } : {}),
				signal: conflict.signal,
				contraScore: conflict.contraScore,
				margin: resolution.margin,
				verdict: resolution.verdict,
				...(resolution.winnerId !== "" ? { winnerId: resolution.winnerId } : {}),
				kappaLoser: resolution.kappaLoser,
				status: "open", // detection projects OPEN; an operator confirms via the resolve endpoint.
				confidence: conflict.contraScore,
				createdAt: now,
			},
			deps.persist,
			scope,
		);
		await appendConflictHistory(
			{ memoryId: conflict.memoryAId, operation: "conflict_detect", reason: `detected ${conflict.signal} conflict (Contra=${conflict.contraScore.toFixed(3)})`, confidence: conflict.contraScore },
			deps.persist,
			scope,
		);
		projectedIds.push(conflictId);
	}
	return { detected, projectedIds };
}

// ── Recall-time suppression source (the `κ = ρ` open-conflict loser set) ──────

/**
 * Build the recall-time {@link ConflictSuppressionSource} (PRD-058b recall-time suppression). Reads the
 * OPEN-conflict projection (`memory_conflicts`, live version, status `open`) and returns the set of LOSER
 * ids — the non-winner side of each open conflict — that intersect the recall's hits, so recall drops the
 * `κ = ρ` losing side and returns at most the winner. The `κ = 0` hard-superseded losers are already gone
 * (excluded by `MAX(version)`), so this set is purely the OPEN `review`-style ρ-suppression.
 *
 * The loser is the pair member that is NOT `winner_id`; when an open conflict has no winner recorded yet
 * (a detection-only projection), BOTH sides are conservatively suppressed candidates ONLY if a positive
 * `kappa_loser` was not set — but the safety default is to suppress NEITHER until a verdict assigns a
 * loser, so a winner-less open row contributes no suppression (both sides stay live, the conservative
 * posture). FAIL-SOFT: a missing/unreadable `memory_conflicts` table → an EMPTY set (both sides returned),
 * never a throw — the gate degrades to returning both sides.
 */
export function createConflictSuppressionSource(storage: StorageQuery): ConflictSuppressionSource {
	return {
		async loadSuppressed(hits: readonly MemoryRecallHit[], scope: QueryScope, signal?: AbortSignal): Promise<ReadonlySet<string>> {
			const suppressed = new Set<string>();
			// Only the durable `memories` arm carries a suppressable id; nothing to do if no memories hit.
			const hitIds = new Set(hits.filter((h) => h.source === "memories").map((h) => h.id));
			if (hitIds.size === 0) return suppressed;
			let result;
			try {
				// PRD-077: thread the heavy-path deadline signal so this post-fan-out `memory_conflicts` read is
				// bounded by `recallHeavyDeadlineMs` too (additive — absent signal is byte-for-byte the old read).
				result = await storage.query(buildOpenConflictProjectionSql(), scope, signal !== undefined ? { signal } : {});
			} catch {
				return suppressed; // fail-soft: a query failure → no suppression (both sides returned).
			}
			if (!isOk(result)) return suppressed; // missing table / query error → no suppression.
			for (const row of result.rows) {
				const winnerId = row.winner_id === null || row.winner_id === undefined ? "" : String(row.winner_id);
				if (winnerId === "") continue; // no winner yet → suppress neither (conservative).
				// RESPECT kappa_loser: an open `keep-both` projects a winner_id AND `kappa_loser = 1` (the
				// resolver explicitly decided to KEEP the loser live). Suppressing on winner_id alone would
				// hide a memory the resolver chose to keep. Only a kappa_loser that INDICATES suppression
				// (κ < 1 — the `review` ρ-suppression or a supersede) removes the loser; a NULL κ (no verdict
				// yet) is conservative → suppress neither.
				const kappaRaw = row.kappa_loser;
				if (kappaRaw === null || kappaRaw === undefined) continue; // no κ assigned yet → suppress neither.
				const kappaLoser = typeof kappaRaw === "number" ? kappaRaw : Number(kappaRaw);
				if (!Number.isFinite(kappaLoser) || kappaLoser >= 1) continue; // keep-both (κ = 1) → loser stays live.
				const aId = String(row.memory_a_id ?? "");
				const bId = String(row.memory_b_id ?? "");
				const loserId = winnerId === aId ? bId : winnerId === bId ? aId : "";
				// Only suppress when the loser is actually among the recall's hits (intersection).
				if (loserId !== "" && hitIds.has(loserId)) suppressed.add(loserId);
			}
			return suppressed;
		},
	};
}
