/**
 * PRD-058e, confidence calibration (the `C(m)` term).
 *
 * Raw extraction confidence `f ∈ [0,1]` is systematically miscalibrated, a model
 * that says `0.9` is right far less than 90% of the time (`memory-lifecycle-
 * scoring.md` Term 2). This module LEARNS a calibration map `g` from observed
 * outcomes so the store can trust its own confidence:
 *
 *   C(m) = g( f(m) )
 *
 * where the ground-truth `y ∈ {0,1}` comes free from the lifecycle itself: a
 * memory that WINS a conflict or PASSES re-verification is evidence it was right
 * (`y = 1`); one that loses or is superseded is evidence it was wrong (`y = 0`)
 * (058b/058c feed these resolved outcomes).
 *
 * ── The fit (PRD-058e Calibration) ───────────────────────────────────────────
 *  - `g` is ISOTONIC regression (monotone, non-parametric, no parametric
 *    assumption) over the `(f, y)` pairs, via the Pool-Adjacent-Violators
 *    Algorithm ({@link fitIsotonic}). Monotone by construction: a higher raw
 *    confidence never maps to a lower calibrated one.
 *  - Quality is the held-out Expected Calibration Error ({@link expectedCalibrationError},
 *    M bins) and the Brier score ({@link brierScore}).
 *  - COLD-START / insufficient data → `g` is the IDENTITY (`C = f`) and the `c`
 *    exponent stays `0` (dormant), so an unproven calibration never perturbs
 *    ranking (AC-55e.2.2).
 *  - A refit is ADOPTED only when it beats the prior curve on held-out ECE
 *    ({@link shouldAdoptRefit}), the curve never gets worse (AC-55e.2.1).
 *
 * ── Serialization ────────────────────────────────────────────────────────────
 * The fitted curve is a small step function (sorted `(x, y)` knots) JSON-encoded
 * into the `memory_calibration.model_blob` TEXT column ({@link serializeModel} /
 * {@link deserializeModel}), versioned by `fit_at`. The identity model serializes
 * to a recognizable marker so a cold-start row round-trips to `C = f`.
 *
 * Pure + synchronous: no I/O, no clock, no throw. The storage read/write of the
 * curve snapshots is the caller's job (the `memory_calibration` table); this
 * module is the math + the (de)serialization.
 */

/** The default minimum number of resolved `(f,y)` pairs before a non-identity fit is attempted (AC-55e.2.2). */
export const DEFAULT_MIN_CALIBRATION_SAMPLES = 50;

/** The default number of equal-width confidence bins for ECE / the reliability diagram. */
export const DEFAULT_ECE_BINS = 10;

/**
 * A resolved calibration observation: the raw model confidence `f` and the
 * observed correctness `y ∈ {0,1}` (1 = won a conflict / passed re-verification).
 */
export interface CalibrationSample {
	/** Raw extraction confidence `f ∈ [0,1]`. */
	readonly f: number;
	/** Observed correctness `y ∈ {0,1}`. */
	readonly y: 0 | 1;
}

/**
 * A monotone step-function calibration model `g`. `knots` are sorted by `x`
 * ASCENDING with non-decreasing `y` (the isotonic guarantee); `g(f)` is the `y`
 * of the knot at-or-below `f` (piecewise-constant, clamped to the endpoints).
 * `identity: true` is the cold-start marker, `g(f) = f` exactly.
 */
export interface CalibrationModel {
	/** When true, `g` is the identity (`C = f`); `knots` is ignored (AC-55e.2.2 cold-start). */
	readonly identity: boolean;
	/** Sorted `(x, y)` knots (x ascending, y non-decreasing). Empty for the identity model. */
	readonly knots: ReadonlyArray<{ readonly x: number; readonly y: number }>;
}

/** The identity calibration model, `C = f`, the cold-start / dormant default (AC-55e.2.2). */
export const IDENTITY_MODEL: CalibrationModel = Object.freeze({ identity: true, knots: [] });

/** Clamp a value into `[0,1]`; non-finite → 0. */
function clampUnit(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

/**
 * Evaluate the calibration map `g(f)` (PRD-058e). The identity model returns `f`
 * unchanged. A fitted model returns the `y` of the LAST knot whose `x ≤ f`
 * (piecewise-constant, monotone), clamped to the first/last knot at the ends, all
 * in `[0,1]`. Pure + sync, never throws / NaNs. An empty fitted model (defensive)
 * also falls back to identity.
 */
export function applyCalibration(model: CalibrationModel, f: number): number {
	const x = clampUnit(f);
	if (model.identity || model.knots.length === 0) return x;
	// Below the first knot → the first knot's y (clamp low).
	if (x <= model.knots[0]!.x) return clampUnit(model.knots[0]!.y);
	// Walk to the last knot with x ≤ f (the knots are sorted ascending).
	let y = model.knots[0]!.y;
	for (const knot of model.knots) {
		if (knot.x <= x) y = knot.y;
		else break;
	}
	return clampUnit(y);
}

/**
 * Fit a monotone isotonic regression `g` over `(f, y)` pairs via the Pool-Adjacent-
 * Violators Algorithm (PRD-058e). The samples are sorted by `f` ascending, then
 * adjacent blocks that violate monotonicity (a later block with a lower mean) are
 * POOLED into their weighted mean until the whole sequence is non-decreasing. The
 * result is a step function whose `y` is the pooled block mean (a probability in
 * `[0,1]`), monotone by construction. RULES:
 *  - Fewer than `minSamples` pairs → the IDENTITY model (cold-start, AC-55e.2.2).
 *  - Pairs with a non-finite `f`/`y` are dropped; `f` is clamped to `[0,1]`, `y`
 *    coerced to `{0,1}`.
 *  - Ties in `f` are merged into one block (same x, averaged y) so `g` is a
 *    function (one y per x).
 * Pure + sync, never throws.
 */
export function fitIsotonic(samples: readonly CalibrationSample[], minSamples: number = DEFAULT_MIN_CALIBRATION_SAMPLES): CalibrationModel {
	// Clean + sort by f ascending (stable on ties).
	const clean = samples
		.filter((s) => Number.isFinite(s.f) && (s.y === 0 || s.y === 1))
		.map((s) => ({ x: clampUnit(s.f), y: s.y as number }))
		.sort((a, b) => a.x - b.x);

	if (clean.length < Math.max(1, Math.trunc(minSamples))) return IDENTITY_MODEL;

	// Merge equal-x samples into one weighted block so g is a function of x.
	type Block = { x: number; sumY: number; weight: number };
	const blocks: Block[] = [];
	for (const s of clean) {
		const last = blocks[blocks.length - 1];
		if (last !== undefined && last.x === s.x) {
			last.sumY += s.y;
			last.weight += 1;
		} else {
			blocks.push({ x: s.x, sumY: s.y, weight: 1 });
		}
	}

	// PAVA: pool adjacent blocks while the sequence of means is decreasing.
	const pooled: Block[] = [];
	for (const block of blocks) {
		pooled.push({ ...block });
		while (pooled.length > 1) {
			const right = pooled[pooled.length - 1]!;
			const left = pooled[pooled.length - 2]!;
			const meanRight = right.sumY / right.weight;
			const meanLeft = left.sumY / left.weight;
			if (meanLeft <= meanRight) break; // already monotone non-decreasing.
			// Violation: pool the two blocks into their weighted mean. The pooled block
			// keeps the LEFT block's x (the lower edge of the merged step).
			left.sumY += right.sumY;
			left.weight += right.weight;
			pooled.pop();
		}
	}

	const knots = pooled.map((b) => ({ x: b.x, y: clampUnit(b.sumY / b.weight) }));
	return { identity: false, knots };
}

/**
 * The Expected Calibration Error over `M` equal-width bins (PRD-058e):
 * `ECE = Σ_b (|B_b|/N) · |acc(B_b) − conf(B_b)|`, where for each bin `acc` is the
 * mean observed `y` and `conf` is the mean PREDICTED confidence (the calibrated
 * `g(f)` when a model is supplied, else the raw `f`). Lower is better; `0` is
 * perfect calibration. An empty sample set → `0` (no error to measure). Pure +
 * sync. This is the gate metric: a refit must not INCREASE held-out ECE
 * (AC-55e.2.1).
 */
export function expectedCalibrationError(
	samples: readonly CalibrationSample[],
	model: CalibrationModel = IDENTITY_MODEL,
	bins: number = DEFAULT_ECE_BINS,
): number {
	const n = samples.length;
	if (n === 0) return 0;
	const m = Math.max(1, Math.trunc(bins));
	const binAccSum = new Array<number>(m).fill(0);
	const binConfSum = new Array<number>(m).fill(0);
	const binCount = new Array<number>(m).fill(0);

	for (const s of samples) {
		const conf = clampUnit(applyCalibration(model, s.f));
		// Bin by predicted confidence; the top edge (conf === 1) lands in the last bin.
		const idx = Math.min(m - 1, Math.floor(conf * m));
		binAccSum[idx]! += s.y;
		binConfSum[idx]! += conf;
		binCount[idx]! += 1;
	}

	let ece = 0;
	for (let b = 0; b < m; b++) {
		const count = binCount[b]!;
		if (count === 0) continue;
		const acc = binAccSum[b]! / count;
		const conf = binConfSum[b]! / count;
		ece += (count / n) * Math.abs(acc - conf);
	}
	return ece;
}

/**
 * The Brier score `(1/N) Σ (pred_i − y_i)^2` (PRD-058e), where `pred` is the
 * calibrated `g(f)` (or raw `f` under the identity model). Lower is better. An
 * empty sample set → `0`. Pure + sync.
 */
export function brierScore(samples: readonly CalibrationSample[], model: CalibrationModel = IDENTITY_MODEL): number {
	const n = samples.length;
	if (n === 0) return 0;
	let sum = 0;
	for (const s of samples) {
		const pred = clampUnit(applyCalibration(model, s.f));
		const diff = pred - s.y;
		sum += diff * diff;
	}
	return sum / n;
}

/**
 * One reliability-diagram bin for the introspection endpoint (PRD-058e): the bin's
 * confidence range, its mean predicted confidence, its mean observed accuracy, and
 * its sample count. The dashboard (058d) renders these as the reliability curve.
 */
export interface ReliabilityBin {
	/** Lower edge of the bin's confidence range (inclusive). */
	readonly lower: number;
	/** Upper edge of the bin's confidence range (exclusive, except the top bin). */
	readonly upper: number;
	/** Mean predicted confidence of the bin's samples. */
	readonly meanConfidence: number;
	/** Mean observed accuracy (mean `y`) of the bin's samples. */
	readonly accuracy: number;
	/** How many samples fell in this bin. */
	readonly count: number;
}

/**
 * Build the reliability diagram (PRD-058e introspection payload): per-bin mean
 * confidence vs observed accuracy, the data behind the reliability curve. Empty
 * bins are emitted with zeroes + `count: 0` so the curve has a stable shape. Pure.
 */
export function reliabilityDiagram(
	samples: readonly CalibrationSample[],
	model: CalibrationModel = IDENTITY_MODEL,
	bins: number = DEFAULT_ECE_BINS,
): ReliabilityBin[] {
	const m = Math.max(1, Math.trunc(bins));
	const accSum = new Array<number>(m).fill(0);
	const confSum = new Array<number>(m).fill(0);
	const count = new Array<number>(m).fill(0);
	for (const s of samples) {
		const conf = clampUnit(applyCalibration(model, s.f));
		const idx = Math.min(m - 1, Math.floor(conf * m));
		accSum[idx]! += s.y;
		confSum[idx]! += conf;
		count[idx]! += 1;
	}
	const out: ReliabilityBin[] = [];
	for (let b = 0; b < m; b++) {
		const c = count[b]!;
		out.push({
			lower: b / m,
			upper: (b + 1) / m,
			meanConfidence: c === 0 ? 0 : confSum[b]! / c,
			accuracy: c === 0 ? 0 : accSum[b]! / c,
			count: c,
		});
	}
	return out;
}

/**
 * Decide whether a freshly-fit curve should be ADOPTED over the prior one
 * (PRD-058e: "keep the prior curve until the new one beats it on held-out ECE",
 * AC-55e.2.1). Adopt iff the candidate's held-out ECE is STRICTLY LESS than the
 * prior's (a tie keeps the incumbent, never churn the curve for no gain). The
 * caller computes both ECEs over the SAME held-out slice. Pure.
 */
export function shouldAdoptRefit(priorHeldOutEce: number, candidateHeldOutEce: number): boolean {
	if (!Number.isFinite(candidateHeldOutEce)) return false; // a broken candidate never wins.
	if (!Number.isFinite(priorHeldOutEce)) return true; // no usable prior → adopt the candidate.
	return candidateHeldOutEce < priorHeldOutEce;
}

/** The serialized-model schema marker, bumped if the blob shape ever changes. */
const MODEL_FORMAT = "isotonic-v1" as const;

/**
 * Serialize a calibration model to the compact JSON string stored in
 * `memory_calibration.model_blob` (PRD-058e). The identity model serializes to a
 * recognizable `{format, identity:true}` marker so a cold-start row round-trips to
 * `C = f`. Pure; the result is a plain string with no escape-bearing surprises.
 */
export function serializeModel(model: CalibrationModel): string {
	if (model.identity) return JSON.stringify({ format: MODEL_FORMAT, identity: true });
	return JSON.stringify({ format: MODEL_FORMAT, identity: false, knots: model.knots });
}

/**
 * Deserialize a `model_blob` back into a {@link CalibrationModel} (PRD-058e).
 * FAIL-SAFE: an empty string, malformed JSON, an unknown format, or a structurally-
 * bad payload falls back to the IDENTITY model (`C = f`), a corrupt curve must
 * never throw into recall, only degrade to the dormant default. Knot coordinates
 * are clamped to `[0,1]` and re-sorted defensively so a tampered blob cannot
 * produce a non-monotone or out-of-range `g`. Pure.
 */
export function deserializeModel(blob: string): CalibrationModel {
	if (blob.trim() === "") return IDENTITY_MODEL;
	let parsed: unknown;
	try {
		parsed = JSON.parse(blob);
	} catch {
		return IDENTITY_MODEL;
	}
	if (typeof parsed !== "object" || parsed === null) return IDENTITY_MODEL;
	const obj = parsed as { format?: unknown; identity?: unknown; knots?: unknown };
	if (obj.format !== MODEL_FORMAT) return IDENTITY_MODEL;
	if (obj.identity === true) return IDENTITY_MODEL;
	if (!Array.isArray(obj.knots)) return IDENTITY_MODEL;

	const knots: Array<{ x: number; y: number }> = [];
	for (const k of obj.knots) {
		if (typeof k !== "object" || k === null) continue;
		const rec = k as { x?: unknown; y?: unknown };
		const x = Number(rec.x);
		const y = Number(rec.y);
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		knots.push({ x: clampUnit(x), y: clampUnit(y) });
	}
	if (knots.length === 0) return IDENTITY_MODEL;
	knots.sort((a, b) => a.x - b.x);
	// FAIL-SAFE monotonicity: an isotonic calibration curve is non-decreasing by contract (higher raw
	// confidence never maps to lower calibrated confidence). Sorting by `x` alone does NOT enforce that —
	// a corrupt/tampered blob could store a `y` that decreases as `x` rises, INVERTING confidence. Reject
	// any non-monotone-y sequence and fall back to the IDENTITY model (`C = f`) rather than honor a curve
	// that flips the ordering.
	for (let i = 1; i < knots.length; i++) {
		if (knots[i]!.y < knots[i - 1]!.y) return IDENTITY_MODEL;
	}
	return { identity: false, knots };
}
