/**
 * PRD-058e, the usefulness grader (the `u_k` weight for the access series).
 *
 * When a recalled memory is injected into a session, the session-end summary
 * worker grades HOW USEFUL that recall was, and the grade becomes the
 * partial-reinforcement weight `u_k ∈ [0,1]` on the access event (`access-log.ts`
 * → `memory_access`), which the ACT-R activation sums over (`activation.ts`):
 *
 *   - injected and NOT contradicted / down-ranked → `u ≈ 1` (a reinforce event).
 *   - ignored or contradicted in the same session  → `u → 0` (a downweight event,
 *     so the non-useful recall does NOT inflate activation, AC-55e.1.3).
 *   - partial signals land at an intermediate `u_k ∈ [0,1]` (PRD-058e: the
 *     activation sum is robust to a few mis-graded accesses; partial weights, not
 *     binary).
 *
 * ── The conflict-detector seam (PRD-058e: "reuses the conflict detector") ─────
 * The grader spots CONTRADICTION via the 058b conflict detector. 058b is NOT
 * built yet, so this module defines a clean injectable {@link ContradictionDetector}
 * INTERFACE that 058b will satisfy later, and defaults it to a NO-CONTRADICTION
 * stub ({@link noContradictionDetector}) so THIS wave is self-contained and
 * testable. When 058b lands, the daemon injects the real detector; nothing here
 * changes. The grader never calls 058b directly, it depends only on the seam.
 *
 * ── Off the hot path, fail-soft (PRD-058e Technical Considerations) ───────────
 * Grading runs in the session-end summary worker, never on the capture write
 * path. A detector throw / timeout degrades to "no contradiction detected" (the
 * conservative grade `u ≈ 1` for an injected-and-present memory, mirroring the
 * documented default) rather than failing the worker, a grading hiccup must
 * never cost a memory or stall capture.
 *
 * Pure orchestration: this module decides the grade + kind from the recall
 * OUTCOME signals; the storage append is `access-log.ts`'s job.
 */

import type { MemoryAccessKind } from "../../storage/catalog/memory-lifecycle.js";
import { mapBounded, Semaphore } from "./bounded-pool.js";
import { amplificationConfig } from "./amplification-config.js";

/** The default usefulness for an injected, non-contradicted, non-ignored recall (the documented `u ≈ 1`). */
export const USEFULNESS_CONFIRMED = 1.0;
/** The usefulness for a contradicted or ignored recall (`u → 0`, AC-55e.1.3). */
export const USEFULNESS_REJECTED = 0.0;

/**
 * The signals the session-end worker observes about a recalled memory's fate in a
 * session, the inputs the grader maps to a `u_k`. All are best-effort observations
 * the worker derives from the turn outcome (PRD-058e default signal source).
 */
export interface RecallOutcomeSignals {
	/** The memory that was recalled (its id + the text that was injected). */
	readonly memoryId: string;
	/** The memory's injected text (passed to the contradiction detector). */
	readonly injectedText: string;
	/**
	 * Was the memory actually INJECTED into the model context (vs surfaced-but-dropped
	 * by the token budget / gate)? A memory that never entered context cannot be graded
	 * useful, it scores `u → 0` (it was, in effect, ignored).
	 */
	readonly injected: boolean;
	/**
	 * Was the memory explicitly DOWN-RANKED / ignored by the downstream turn (e.g. the
	 * agent surfaced it but the user/turn discarded it)? A direct ignore signal → `u → 0`.
	 */
	readonly ignored: boolean;
	/**
	 * The downstream turn text the contradiction detector inspects for an explicit
	 * contradiction of the injected memory. The worker supplies the relevant assistant /
	 * outcome text; `""` when none is available (→ the detector sees nothing to contradict).
	 */
	readonly outcomeText: string;
}

/**
 * The 058b conflict-detector seam (PRD-058e: the grader "reuses the conflict
 * detector"). Given an injected memory's text and the downstream outcome text,
 * return a CONTRADICTION PROBABILITY in `[0,1]` (`P_contradiction` from the scoring
 * model's `opp` term). 058b will implement this; the default stub returns `0` (no
 * contradiction) so this wave is self-contained. Async because the real detector
 * is an NLI-style model call.
 */
export interface ContradictionDetector {
	/** Probability `∈ [0,1]` that `outcomeText` contradicts `injectedText`. 0 = no contradiction. */
	detect(injectedText: string, outcomeText: string): Promise<number>;
}

/**
 * The default no-contradiction detector (PRD-058e self-contained default). Always
 * reports `0`, no contradiction, so until 058b injects the real detector, an
 * injected-and-not-ignored recall grades as confirmed-useful (`u ≈ 1`). A clean
 * seam: swapping in the real 058b detector changes only the grade, not the grader.
 */
export const noContradictionDetector: ContradictionDetector = {
	async detect(): Promise<number> {
		return 0;
	},
};

/** The grade for a single recalled memory: its usefulness weight + the access kind to log. */
export interface UsefulnessGrade {
	/** The memory the grade applies to. */
	readonly memoryId: string;
	/** The usefulness weight `u_k ∈ [0,1]` (the partial-reinforcement weight). */
	readonly usefulness: number;
	/** The access {@link MemoryAccessKind} to log: `reinforce` (useful) or `downweight` (not). */
	readonly kind: MemoryAccessKind;
}

/** Construction deps for the grader: the (injectable) contradiction detector. */
export interface UsefulnessGraderDeps {
	/** The 058b contradiction detector; defaults to {@link noContradictionDetector}. */
	readonly detector?: ContradictionDetector;
	/**
	 * The bounded wall-clock budget (ms) for ONE `detector.detect()` call. A detector that NEVER resolves
	 * must not wedge the grader (and the `Promise.all` in {@link gradeRecallBatch}), so the call races a
	 * timeout that resolves to the fail-soft "no contradiction" sentinel. Default
	 * {@link DEFAULT_DETECT_TIMEOUT_MS}; a test injects a tiny value.
	 */
	readonly detectTimeoutMs?: number;
	/**
	 * PRD-062d (L-D2 / AC-62d.2.1): the bounded pool that caps how many {@link gradeUsefulness}
	 * calls (and therefore how many contradiction-detector queries) {@link gradeRecallBatch} runs
	 * at once. ABSENT → the batch uses the process-wide ceiling from {@link amplificationConfig}
	 * (`HONEYCOMB_RECALL_MAX_CONCURRENCY`, default 6), so a large batch can no longer fire an
	 * unbounded `Promise.all` of detector calls. A test injects its own {@link Semaphore} for a
	 * deterministic in-flight assertion. PURE timing control: grades are still returned in INPUT
	 * ORDER, one per signal — the cap changes WHEN a grade runs, never the result (parity, AC-8).
	 */
	readonly gradePool?: Semaphore;
}

/** The default per-detect timeout (ms): a hung NLI judge degrades to "no contradiction" after this. */
export const DEFAULT_DETECT_TIMEOUT_MS = 5_000;

/**
 * The process-wide bounded pool for the grader batch (PRD-062d / L-D2). Lazily built from
 * {@link amplificationConfig} the first time a batch runs without an injected pool, mirroring
 * the recall side's shared pool. A test injects {@link UsefulnessGraderDeps.gradePool} for a
 * deterministic cap assertion.
 */
let sharedGradePool: Semaphore | undefined;

/** Resolve the grade pool: the injected one, else the lazily-built process-wide shared pool. */
function resolveGradePool(deps: UsefulnessGraderDeps): Semaphore {
	if (deps.gradePool !== undefined) return deps.gradePool;
	if (sharedGradePool === undefined) sharedGradePool = new Semaphore(amplificationConfig().recallMaxConcurrency);
	return sharedGradePool;
}

/** Reset the shared grade pool (test-only seam, paired with `resetAmplificationConfigCache`). */
export function resetSharedGradePool(): void {
	sharedGradePool = undefined;
}

/** Clamp a value into `[0,1]`; non-finite → 0. */
function clampUnit(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

/** A sentinel the detect-timeout resolves to (a number outside `[0,1]` so the caller can spot the timeout). */
const DETECT_TIMED_OUT = Number.NaN;

/**
 * Race a `detect()` call against a bounded timeout (PRD-058e fail-soft). Resolves to the detector's
 * probability, or {@link DETECT_TIMED_OUT} when the budget elapses first — so a detector that NEVER
 * resolves cannot wedge `gradeUsefulness` (nor the `Promise.all` batch). The timer is cleared on the
 * winning path so a settled detect does not leak a pending timer. A detector REJECTION propagates (the
 * caller's `try/catch` maps it to the same fail-soft default).
 */
async function detectWithTimeout(
	detector: ContradictionDetector,
	injectedText: string,
	outcomeText: string,
	timeoutMs: number,
): Promise<number> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<number>((resolve) => {
		timer = setTimeout(() => resolve(DETECT_TIMED_OUT), Math.max(0, timeoutMs));
	});
	try {
		return await Promise.race([detector.detect(injectedText, outcomeText), timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Grade ONE recalled memory's usefulness from its session outcome (PRD-058e). The
 * decision (AC-55e.1.3 / the documented default signal):
 *  1. NOT injected, OR explicitly ignored / down-ranked → `u = 0`, `downweight`.
 *     A recall that never helped (never entered context, or was discarded) must not
 *     inflate activation.
 *  2. Injected + not ignored → consult the contradiction detector. The graded
 *     usefulness is `u = 1 − P_contradiction` (partial: a strong contradiction →
 *     `u → 0`; none → `u ≈ 1`). `u` at/under {@link CONTRADICTION_DOWNWEIGHT_THRESHOLD}
 *     logs as `downweight` (the recall was effectively contradicted), else `reinforce`.
 *  3. A detector throw degrades to "no contradiction" → the conservative confirmed
 *     grade (`u ≈ 1`, `reinforce`), a grading hiccup never wrongly punishes a memory.
 * Returns the {@link UsefulnessGrade}; the caller logs it via `recordAccess`.
 */
export async function gradeUsefulness(
	signals: RecallOutcomeSignals,
	deps: UsefulnessGraderDeps = {},
): Promise<UsefulnessGrade> {
	// (1) Never-injected or explicitly ignored → u = 0 (downweight). No detector call needed.
	if (!signals.injected || signals.ignored) {
		return { memoryId: signals.memoryId, usefulness: USEFULNESS_REJECTED, kind: "downweight" };
	}

	// (2) Injected + kept → consult the contradiction detector, BOUNDED by a timeout. A throw OR a
	// timeout (a detector that never resolves) → no contradiction (the conservative confirmed grade),
	// so a hung/failing judge can never wedge the grader or the `Promise.all` batch.
	const detector = deps.detector ?? noContradictionDetector;
	const timeoutMs = deps.detectTimeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS;
	let pContradiction = 0;
	try {
		const raw = await detectWithTimeout(detector, signals.injectedText, signals.outcomeText, timeoutMs);
		// A timeout sentinel (NaN) or any non-finite value clamps to 0 → "no contradiction" (fail-soft).
		pContradiction = clampUnit(raw);
	} catch {
		pContradiction = 0; // fail-soft: a detector hiccup never wrongly punishes the memory.
	}

	// Partial reinforcement: u = 1 − P_contradiction (PRD-058e: partial weights, not binary).
	const usefulness = clampUnit(1 - pContradiction);
	const kind: MemoryAccessKind = usefulness <= CONTRADICTION_DOWNWEIGHT_THRESHOLD ? "downweight" : "reinforce";
	return { memoryId: signals.memoryId, usefulness, kind };
}

/**
 * Grade a batch of recalled memories from one session's outcome (PRD-058e). Runs
 * {@link gradeUsefulness} per memory; a per-memory detector throw is already
 * fail-soft inside the grader, so the batch never aborts. Returns one grade per
 * input signal, in order.
 */
export async function gradeRecallBatch(
	signals: readonly RecallOutcomeSignals[],
	deps: UsefulnessGraderDeps = {},
): Promise<UsefulnessGrade[]> {
	// PRD-062d (L-D2 / AC-62d.2.1): cap concurrent grades (and thus concurrent detector queries)
	// with the bounded pool instead of an unbounded `Promise.all`. `mapBounded` preserves INPUT
	// ORDER, so the returned grades are byte-identical to the old `Promise.all` — only the
	// in-flight ceiling differs (parity, AC-8). Each per-memory grade is already fail-soft inside
	// `gradeUsefulness`, so the batch never aborts.
	const pool = resolveGradePool(deps);
	return mapBounded(signals, pool, (s) => gradeUsefulness(s, deps));
}

/**
 * The contradiction-probability at/above which an injected recall is treated as
 * effectively contradicted (logged `downweight`, not `reinforce`). `0.5`, a
 * stronger-than-even contradiction verdict flips the access from reinforcing to
 * down-weighting. The graded `usefulness` is still the continuous `1 − P` (partial
 * reinforcement); this threshold only picks the access KIND tag.
 */
export const CONTRADICTION_DOWNWEIGHT_THRESHOLD = 0.5;
