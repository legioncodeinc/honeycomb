/**
 * PRD-058b, the layered contradiction detector (the `Contra(a,b)` half of the `κ` gate).
 *
 * Two memories `a`, `b` conflict when they speak to the SAME claim slot and assert
 * OPPOSITE outcomes. The contradiction score (`memory-lifecycle-scoring.md` Term 4):
 *
 *   Contra(a,b) = sim(slot_a, slot_b) · opp(a,b)
 *   opp(a,b)    = max( opp_lexical , P_contradiction )
 *
 *   - `sim`             = cosine similarity of the two memories' CLAIM-SLOT embeddings
 *                         (same subject?). 0..1 via {@link cosineSimilarity}.
 *   - `opp_lexical`     = the EXISTING negation/antonym/overlap heuristic (reuses the
 *                         decision-stage token sets, see {@link oppLexical}). Cheap, free,
 *                         already-available — runs FIRST.
 *   - `P_contradiction` = the NLI-style judge probability from the `memory_extraction`
 *                         router workload, invoked ONLY for high-`sim`, lexically-
 *                         inconclusive pairs, and SKIPPED entirely when the provider is
 *                         `none` (then `opp = opp_lexical`). The `max` means either a cheap
 *                         lexical hit OR a semantic verdict suffices — neither alone is a
 *                         blind spot.
 *
 * A pair is FLAGGED when `Contra > θ_detect` (default {@link DEFAULT_THETA_DETECT} = 0.6).
 *
 * ── Candidate-bounded, off the write path (PRD-058b Technical Considerations) ─
 * Detection runs over the decision-stage CANDIDATE SET (the top few existing
 * candidates the stage already fetched per extracted fact), so it costs NO extra
 * table scan, and it runs in the async decision-stage / maintenance pass, NEVER on
 * the capture write path. A slow or failing model judge therefore never costs a
 * memory: a detector throw / empty model output degrades to the lexical-only signal.
 *
 * ── The 058e seam (PRD-058e: the grader "reuses the conflict detector") ──────
 * {@link createContradictionDetector} returns an object that SATISFIES the 058e
 * {@link ContradictionDetector} interface (`detect(injectedText, outcomeText) →
 * P_contradiction`). 058e defined that seam with a no-contradiction stub default; the
 * daemon now injects THIS real detector so usefulness grading can spot a contradiction
 * (the grade `u = 1 − P_contradiction`). The seam contract is unchanged — only the
 * grade moves — so 058e's tests stay green with the stub and pick up the real verdict
 * when the real detector is injected.
 *
 * ── keep-both memoization (AC-55b.2.4) ───────────────────────────────────────
 * A pair the policy classified `keep-both` (a false positive, independent facts) is
 * memoized on the NORMALIZED (sorted) pair ({@link normalizeConflictPair}) so a later
 * detection pass does NOT re-flag the same pair. The memo is an injectable seam so the
 * caller owns its lifetime (an in-process Set for a maintenance pass, or a durable
 * projection read for a long-lived daemon).
 *
 * Pure-ish orchestration: the math ({@link contraScore}, {@link oppLexical}) is pure;
 * the only async dependencies are the embed seam (claim-slot vectors) and the model
 * seam (`P_contradiction`), both fail-soft.
 */

import { cosineSimilarity } from "../../storage/vector.js";
import type { EmbedClient } from "../services/embed-client.js";
import type { ModelClient } from "../pipeline/model-client.js";
import {
	ANTONYM_PAIRS,
	lexicalOverlap,
	NEGATION_TOKENS,
	tokenize,
} from "../pipeline/controlled-writes.js";
import { normalizeConflictPair, type ConflictSignal } from "../../storage/catalog/memory-conflicts.js";
import type { ContradictionDetector as UsefulnessGraderSeam } from "./usefulness-grader.js";

// ── The 058e contradiction-detector seam (satisfied here) ────────────────────

/**
 * The 058b conflict-detector seam the 058e usefulness grader depends on. Given an
 * injected memory's text and the downstream outcome text, return a CONTRADICTION
 * PROBABILITY in `[0,1]` (`P_contradiction`). 058e defaults this to a no-contradiction
 * stub; the real detector here implements it (re-declared structurally so this module
 * does not import from the grader, keeping the dependency arrow grader → detector). A
 * test injects a stub.
 */
export interface ContradictionDetector {
	/** Probability `∈ [0,1]` that `outcomeText` contradicts `injectedText`. 0 = no contradiction. */
	detect(injectedText: string, outcomeText: string): Promise<number>;
}

// ── Tunable thresholds (scoring-model defaults) ──────────────────────────────

/** `θ_detect`, the contradiction-flag threshold (`memory-lifecycle-scoring.md`, PR-curve tuned). */
export const DEFAULT_THETA_DETECT = 0.6;

/**
 * The `sim` floor above which a lexically-inconclusive pair ESCALATES to the model
 * verdict (PRD-058b "invoked ONLY for pairs whose `sim` is high and whose lexical
 * signal is inconclusive"). Below this, the model is never consulted — the pair is
 * decided from the free lexical + embedding signal. Keeps model spend proportional to
 * genuine ambiguity.
 */
export const DEFAULT_MODEL_ESCALATION_SIM = 0.7;

/**
 * The `opp_lexical` value at/above which the lexical signal is treated as CONCLUSIVE,
 * so the model verdict is not needed (`opp = max` already clears from the lexical hit
 * alone — AC-55b.2.2). A lexical opp below this on a high-`sim` pair is the "ambiguous"
 * case that escalates to the model.
 */
export const DEFAULT_LEXICAL_CONCLUSIVE = 0.5;

// ── opp_lexical — the symmetric pair heuristic (reuses the decision-stage sets) ─

/**
 * The symmetric outcome-opposition heuristic over a PAIR of memory texts (PRD-058b
 * `opp_lexical`). Returns `∈ [0,1]`: the lexical overlap (shared subject) WHEN a polarity
 * flip is present across the two texts, else `0`. Reuses the decision-stage
 * {@link NEGATION_TOKENS} / {@link ANTONYM_PAIRS} / {@link tokenize} / {@link lexicalOverlap}
 * (single source of truth — the write-time check and this read-time pair check agree on
 * the token sets). Symmetric in `(a,b)` (unlike the decision stage's fact-vs-proposal
 * `detectContradiction`, which is directional):
 *   - a negation token on EITHER side (the other side asserting the un-negated claim), OR
 *   - an antonym-pole flip across the two,
 * with meaningful lexical overlap (same subject), scores the overlap as the opposition
 * strength; no flip → `0`. Pure + deterministic.
 */
export function oppLexical(textA: string, textB: string, overlapFloor = 0.1): number {
	const tokensA = tokenize(textA);
	const tokensB = tokenize(textB);
	const overlap = lexicalOverlap(tokensA, tokensB);
	if (overlap < overlapFloor) return 0; // no shared subject → not the same claim slot.

	const setA = new Set(tokensA);
	const setB = new Set(tokensB);

	// A negation token on exactly ONE side is a polarity flip (one asserts, one denies).
	let aHasNeg = false;
	let bHasNeg = false;
	for (const neg of NEGATION_TOKENS) {
		if (setA.has(neg)) aHasNeg = true;
		if (setB.has(neg)) bHasNeg = true;
	}
	if (aHasNeg !== bHasNeg) return overlap; // exactly one side negates → opposition = overlap.

	// An antonym-pole flip across the two (a asserts one pole, b the other).
	for (const [x, y] of ANTONYM_PAIRS) {
		if ((setA.has(x) && setB.has(y)) || (setA.has(y) && setB.has(x))) {
			return overlap;
		}
	}
	return 0;
}

// ── The Contra score ─────────────────────────────────────────────────────────

/** Clamp a value into `[0,1]`; non-finite → 0 (a garbage signal contributes nothing). */
function clampUnit(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

/**
 * Compute `Contra(a,b) = sim · max(opp_lexical, P_contradiction)` (PRD-058b §1). Pure: the
 * caller supplies the already-computed `sim` (claim-slot cosine), `oppLexical`, and the
 * optional `pContradiction` (absent → `opp = opp_lexical`, the provider-`none` path). Every
 * input is clamped to `[0,1]` so a mis-graded signal cannot push `Contra` out of range.
 */
export function contraScore(sim: number, oppLexicalScore: number, pContradiction?: number): number {
	const s = clampUnit(sim);
	const oppLex = clampUnit(oppLexicalScore);
	const oppModel = pContradiction === undefined ? 0 : clampUnit(pContradiction);
	const opp = Math.max(oppLex, oppModel);
	return s * opp;
}

// ── The detection inputs / outputs ───────────────────────────────────────────

/**
 * One detection candidate: a memory's id + the claim text the `sim`/`opp` run over, and the
 * claim-slot key. The decision stage supplies the candidate set (the top existing candidates it
 * already fetched); the maintenance pass supplies a recent in-scope window. A precomputed
 * `slotEmbedding` is used verbatim when present (the write already embedded the row); otherwise
 * the detector embeds `claimText` via the embed seam (fail-soft to lexical-only when null).
 */
export interface ConflictCandidate {
	/** The memory id (the durable `memories.id`). */
	readonly id: string;
	/** The claim text (the fact content) the lexical + embedding signals run over. */
	readonly claimText: string;
	/** The claim-slot key the two memories must share to be the same claim (PRD-058b open question). */
	readonly claimSlot?: string;
	/** The provenance arm-class (distilled `memory` vs raw `session`) — carried for the resolver's `prov`. */
	readonly arm?: "memory" | "session";
	/** A precomputed claim-slot embedding (the write's vector); absent → the detector embeds `claimText`. */
	readonly slotEmbedding?: readonly number[];
}

/** A flagged conflict pair: the NORMALIZED ids, the deciding signal, and the audit-trail score. */
export interface DetectedConflict {
	/** The normalized (sorted) lower id. */
	readonly memoryAId: string;
	/** The normalized (sorted) higher id. */
	readonly memoryBId: string;
	/** The claim slot the pair shares (the first non-empty of the two candidates' slots, when present). */
	readonly claimSlot?: string;
	/** The deciding {@link ConflictSignal} (the cheapest signal that carried the flag). */
	readonly signal: ConflictSignal;
	/** The `Contra(a,b) ∈ [0,1]` that cleared `θ_detect`. */
	readonly contraScore: number;
	/** The claim-slot similarity `sim ∈ [0,1]` (the audit trail). */
	readonly sim: number;
}

/** The memoization seam for `keep-both` false positives (AC-55b.2.4). */
export interface KeepBothMemo {
	/** Is the normalized pair memoized as a `keep-both` false positive? */
	has(aId: string, bId: string): boolean | Promise<boolean>;
}

/** Construction deps for {@link detectConflicts}: the embed + model seams + tunables + the memo. */
export interface ConflictDetectDeps {
	/** The embed seam for claim-slot vectors. ABSENT/no-op → `sim` falls to the lexical-only path. */
	readonly embed?: EmbedClient;
	/**
	 * The model seam for `P_contradiction` (the `memory_extraction` workload). ABSENT → provider is
	 * effectively `none`: the model verdict is SKIPPED and `opp = opp_lexical` (AC-55b.2.3). A model
	 * that returns an empty / unparseable string is also treated as "no verdict" (skip), never a throw.
	 */
	readonly model?: ModelClient;
	/** The `keep-both` memo (AC-55b.2.4). ABSENT → no memoization (every pass re-evaluates). */
	readonly memo?: KeepBothMemo;
	/** `θ_detect` override (default {@link DEFAULT_THETA_DETECT}). */
	readonly thetaDetect?: number;
	/** The `sim` floor above which a lexically-inconclusive pair escalates to the model (default {@link DEFAULT_MODEL_ESCALATION_SIM}). */
	readonly modelEscalationSim?: number;
	/** The `opp_lexical` floor at/above which the lexical signal is conclusive (default {@link DEFAULT_LEXICAL_CONCLUSIVE}). */
	readonly lexicalConclusive?: number;
}

/**
 * Build the `memory_extraction`-workload prompt that asks the judge for a contradiction
 * probability (PRD-058b `P_contradiction`). The judge returns a bare probability in `[0,1]`;
 * the parser ({@link parsePContradiction}) tolerates a noisy completion (CoT, fences, prose)
 * and extracts the first probability, falling to "no verdict" on garbage. Kept tiny so the
 * fake model client can script an exact reply in tests.
 */
export function buildContradictionPrompt(textA: string, textB: string): string {
	return (
		"You are a contradiction judge. Two memory statements are given. Reply with ONLY a single " +
		"number in [0,1]: the probability they assert CONTRADICTORY outcomes about the same subject " +
		"(1 = direct contradiction, 0 = compatible / unrelated). No prose.\n" +
		`A: ${textA}\n` +
		`B: ${textB}\n` +
		"P_contradiction ="
	);
}

/**
 * Parse the model's `P_contradiction` from a raw completion (PRD-058b). Extracts the FIRST
 * probability-looking number in `[0,1]` from the (possibly CoT-wrapped / fenced) text. Returns
 * `null` when the completion is empty or carries no parseable probability — the caller treats
 * `null` as "no model verdict" (skip → `opp = opp_lexical`), never a throw. A value outside
 * `[0,1]` is clamped. Pure.
 */
export function parsePContradiction(raw: string): number | null {
	if (raw.trim() === "") return null;
	// First number with an optional decimal (handles "0.82", ".82", "1", "0").
	const match = raw.match(/-?\d*\.?\d+/);
	if (match === null) return null;
	const n = Number(match[0]);
	if (!Number.isFinite(n)) return null;
	return clampUnit(n);
}

/**
 * Compute the claim-slot similarity `sim` for a candidate pair (PRD-058b). Uses precomputed
 * `slotEmbedding`s when both are present; otherwise embeds `claimText` via the embed seam.
 * Returns `0` (treated as "different subject", so the pair is not flagged on the embedding
 * arm) when either vector is unavailable — FAIL-SOFT: a down embed daemon degrades detection
 * to the lexical-only path, never a throw. Pure given the vectors.
 */
async function claimSlotSim(a: ConflictCandidate, b: ConflictCandidate, embed: EmbedClient | undefined): Promise<number> {
	const vecA = a.slotEmbedding ?? (embed !== undefined ? (await embed.embed(a.claimText)) ?? undefined : undefined);
	const vecB = b.slotEmbedding ?? (embed !== undefined ? (await embed.embed(b.claimText)) ?? undefined : undefined);
	if (vecA === undefined || vecB === undefined) return 0;
	const cos = cosineSimilarity(vecA, vecB);
	return cos === null ? 0 : cos;
}

/**
 * Ask the model for `P_contradiction` (PRD-058b), gated: invoked ONLY for high-`sim`,
 * lexically-inconclusive pairs and SKIPPED when no model seam is wired (provider `none`,
 * AC-55b.2.3). Returns `null` when skipped or the completion is unparseable; the caller then
 * uses `opp = opp_lexical`. FAIL-SOFT: a model throw is swallowed to `null` (off the write
 * path, a failing judge never costs a memory).
 */
async function modelContradiction(
	a: ConflictCandidate,
	b: ConflictCandidate,
	sim: number,
	oppLexicalScore: number,
	deps: ConflictDetectDeps,
): Promise<number | null> {
	const escalationSim = deps.modelEscalationSim ?? DEFAULT_MODEL_ESCALATION_SIM;
	const conclusive = deps.lexicalConclusive ?? DEFAULT_LEXICAL_CONCLUSIVE;
	// Cheap-first: the lexical signal already conclusive, or the pair not similar enough to be the
	// same claim → never pay for the verdict (AC-55b.2.2 + the candidate-bounded spend rule).
	if (oppLexicalScore >= conclusive) return null;
	if (sim < escalationSim) return null;
	if (deps.model === undefined) return null; // provider `none` → skip (AC-55b.2.3).
	try {
		const raw = await deps.model.complete("memory_extraction", buildContradictionPrompt(a.claimText, b.claimText));
		return parsePContradiction(raw);
	} catch {
		return null; // fail-soft: a failing judge degrades to the lexical signal, never throws.
	}
}

/**
 * Score ONE candidate pair (PRD-058b §1): compute `sim`, `opp_lexical`, the gated
 * `P_contradiction`, the `Contra` score, the deciding `signal`, and whether it clears
 * `θ_detect`. Exported so the resolver + tests reuse the exact per-pair scoring. The
 * deciding `signal` records the CHEAPEST signal that carried the flag:
 *   - `lexical`   when `opp_lexical` alone met the opposition that cleared the threshold,
 *   - `model`     when the model verdict was the deciding opposition,
 *   - `embedding` when neither opposition was decisive but the pair still cleared on `sim`
 *                 carrying a borderline opposition (the embedding arm), the residual case.
 */
export async function scorePair(
	a: ConflictCandidate,
	b: ConflictCandidate,
	deps: ConflictDetectDeps = {},
): Promise<{ contra: number; sim: number; oppLexical: number; pContradiction: number | null; signal: ConflictSignal; flagged: boolean }> {
	const theta = deps.thetaDetect ?? DEFAULT_THETA_DETECT;
	const sim = await claimSlotSim(a, b, deps.embed);
	const oppLex = oppLexical(a.claimText, b.claimText);
	const pContradiction = await modelContradiction(a, b, sim, oppLex, deps);
	const contra = contraScore(sim, oppLex, pContradiction ?? undefined);
	// The deciding signal: which opposition source won the `max`. A model verdict strictly above
	// the lexical opp → `model`; lexical opp at least the model (or no model) → `lexical`; the
	// residual (both opps ~0 yet the pair cleared on a high sim alone) → `embedding`.
	const oppModel = pContradiction ?? 0;
	let signal: ConflictSignal;
	if (oppModel > oppLex) signal = "model";
	else if (oppLex > 0) signal = "lexical";
	else signal = "embedding";
	return { contra, sim, oppLexical: oppLex, pContradiction, signal, flagged: contra > theta };
}

/**
 * Detect contradictions over the decision-stage CANDIDATE SET (PRD-058b §1). For each
 * unordered pair in `candidates`, score it ({@link scorePair}) and emit a {@link DetectedConflict}
 * when `Contra > θ_detect` AND the normalized pair is NOT memoized as a `keep-both` false
 * positive (AC-55b.2.4). Candidate-bounded: the cost is `O(n²)` over the SMALL candidate set the
 * decision stage already fetched, never a table scan. FAIL-SOFT throughout: a down embed daemon /
 * a failing model judge degrades a pair to its lexical-only signal, never a thrown detection.
 *
 * Returns the flagged pairs (each with its `signal`, `contraScore`, `sim`), normalized + de-duped
 * so a pair is reported ONCE regardless of iteration order. The caller (decision stage / maintenance)
 * projects each into `memory_conflicts` (and appends to `memory_history`) and routes it to the resolver.
 */
export async function detectConflicts(
	candidates: readonly ConflictCandidate[],
	deps: ConflictDetectDeps = {},
): Promise<DetectedConflict[]> {
	const flagged: DetectedConflict[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < candidates.length; i++) {
		for (let j = i + 1; j < candidates.length; j++) {
			const a = candidates[i];
			const b = candidates[j];
			if (a === undefined || b === undefined || a.id === b.id) continue;
			const { aId, bId } = normalizeConflictPair(a.id, b.id);
			const memoKey = `${aId} ${bId}`;
			if (seen.has(memoKey)) continue;
			seen.add(memoKey);
			// AC-55b.2.4: a memoized keep-both false positive is not re-flagged.
			if (deps.memo !== undefined && (await deps.memo.has(aId, bId))) continue;

			const scored = await scorePair(a, b, deps);
			if (!scored.flagged) continue;
			const claimSlot = a.claimSlot ?? b.claimSlot;
			flagged.push({
				memoryAId: aId,
				memoryBId: bId,
				...(claimSlot !== undefined ? { claimSlot } : {}),
				signal: scored.signal,
				contraScore: scored.contra,
				sim: scored.sim,
			});
		}
	}
	return flagged;
}

/**
 * Build the 058e-shaped {@link ContradictionDetector} backed by this module's model seam
 * (PRD-058b satisfies the 058e seam). `detect(injectedText, outcomeText)` returns
 * `P_contradiction` for the injected memory vs the downstream outcome text: it asks the model
 * judge directly (the grader's seam is a TEXT-PAIR contradiction probe, no claim-slot embedding
 * needed). When no model seam is wired (provider `none`) it returns `0` (no contradiction), exactly
 * the 058e stub's default, so the grade falls back to confirmed-useful — the seam contract 058e
 * relies on is preserved. FAIL-SOFT: a model throw / empty completion → `0`, never a throw into the
 * grader (off the hot path).
 */
/**
 * COMPILE-TIME PROOF that this module's {@link ContradictionDetector} satisfies the 058e usefulness-grader
 * seam (PRD-058b "058b's detector should SATISFY that seam"). If 058e's interface ever drifts from this
 * one, this assignment fails `tsc` — so the seam contract is enforced by the type checker, not by hope. The
 * grader's `UsefulnessGraderDeps.detector` accepts exactly this shape, so {@link createContradictionDetector}
 * drops in as the real detector with no grader edit (the grade `u = 1 − P_contradiction`).
 */
const _seamSatisfied: (d: ContradictionDetector) => UsefulnessGraderSeam = (d) => d;
void _seamSatisfied;

export function createContradictionDetector(deps: { readonly model?: ModelClient } = {}): ContradictionDetector {
	return {
		async detect(injectedText: string, outcomeText: string): Promise<number> {
			if (deps.model === undefined) return 0; // provider `none` → no contradiction (058e stub parity).
			if (outcomeText.trim() === "" || injectedText.trim() === "") return 0;
			try {
				const raw = await deps.model.complete("memory_extraction", buildContradictionPrompt(injectedText, outcomeText));
				const p = parsePContradiction(raw);
				return p ?? 0;
			} catch {
				return 0; // fail-soft: a grading hiccup never wrongly punishes the memory (058e default).
			}
		},
	};
}
