/**
 * The in-memory skillify USAGE METER — PRD-060d (d-AC-1).
 *
 * ── What this is ─────────────────────────────────────────────────────────────
 * The lightweight, in-process sink the Anthropic transport feeds (via its
 * {@link UsageSink} seam) and the pollination composer ({@link roi-pollination.ts})
 * reads. It is the local half of "meter Honeycomb's OWN Haiku skillify inference": the
 * transport surfaces the `usage` it historically discarded, this meter ACCUMULATES those
 * token counts in memory, and the composer rolls them up + prices them with 060b's rate
 * table. There is NO DeepLake table here — pollination's token half is a process-local
 * rollup (mirroring 060c's in-memory billing read-model), so a daemon restart simply
 * starts the count fresh (the read-model is a "since boot" figure, not a persisted ledger).
 *
 * ── Integer counts, never a float (d-AC-6 upstream) ──────────────────────────
 * Every token count the transport reports is already a non-negative integer (the zod
 * boundary in `transport-anthropic.ts` enforces it). The meter only SUMS them, so its
 * totals stay integers; the integer-CENTS discipline is the composer's edge (it divides
 * by 1e6 and rounds there), never here.
 *
 * ── Fail-soft snapshot (d-AC-5) ──────────────────────────────────────────────
 * The meter distinguishes "no data yet" from "a measured zero": a meter that has recorded
 * NOTHING reports `recorded: 0` and the composer maps that to an `absent` Haiku
 * contribution (NOT a confident `$0.00`). A meter that recorded calls which all reported
 * zero tokens reports `recorded > 0` with zero token sums — a measured zero. This is the
 * same absent-vs-measured-zero honesty the rest of PRD-060 enforces.
 *
 * ── Scope (the v1 minimum) ───────────────────────────────────────────────────
 * The meter is fed by whatever own-inference calls the daemon wires it to. PRD-060d's v1
 * scope is the skillify path; the transport attributes each report with its `workload` +
 * `model` (see {@link SkillifyUsageRecord}), so a future caller can scope the meter to a
 * single workload without changing this module. The meter itself stays workload-agnostic:
 * it sums whatever it is fed and exposes the breakdown for the composer to attribute.
 *
 * Pure in-memory state + a tiny imperative API — NO I/O, NO storage, NO clock.
 */

import type { UsageReport, UsageSink } from "../inference/transport-anthropic.js";

/**
 * The accumulated skillify usage snapshot the composer reads (d-AC-1). Token sums are
 * non-negative integers; `recorded` is the COUNT of calls metered (the absent-vs-measured-
 * zero discriminant — `0` ⇒ no data yet ⇒ the composer reports `absent`). `model` is the
 * model id the most-recent metered call ran against, so the composer prices the right
 * 060b rate row (and a model swap in the router is reflected automatically).
 */
export interface SkillifyUsageSnapshot {
	/** How many successful own-inference calls were metered (0 ⇒ no data ⇒ `absent`). */
	readonly recorded: number;
	/** Σ input (uncached prompt) tokens across metered calls — non-negative integer. */
	readonly inputTokens: number;
	/** Σ output (completion) tokens across metered calls — non-negative integer. */
	readonly outputTokens: number;
	/** Σ cache-READ input tokens across metered calls — non-negative integer. */
	readonly cacheReadInputTokens: number;
	/** Σ cache-WRITE (cache-creation) input tokens across metered calls — non-negative integer. */
	readonly cacheCreationInputTokens: number;
	/** The model id the metered calls ran against (the 060b rate-table key); `undefined` until first record. */
	readonly model?: string;
	/**
	 * Finding (meter-per-model): the per-MODEL token buckets. The aggregate token sums above are kept for
	 * back-compat display, but pricing MUST use this so a router/model swap mid-run prices each model's
	 * tokens at ITS OWN rate (the prior single-`model` field mis-priced all accumulated tokens at the
	 * last-seen model). One entry per distinct model id seen. Present ONLY when these buckets fully account
	 * for every recorded call; if any blank-model call was metered it is `undefined` so the composer falls
	 * back to the aggregate path (which counts all tokens) rather than dropping the unbucketed usage.
	 */
	readonly perModel?: readonly SkillifyUsageBucket[];
}

/** One per-model token bucket (Finding meter-per-model) — the unit the composer prices at its own rate. */
export interface SkillifyUsageBucket {
	/** The model id these tokens were billed against (the 060b rate-table key). */
	readonly model: string;
	/** How many calls for THIS model were metered. */
	readonly recorded: number;
	/** Sum input tokens for this model. */
	readonly inputTokens: number;
	/** Sum output tokens for this model. */
	readonly outputTokens: number;
	/** Sum cache-read tokens for this model. */
	readonly cacheReadInputTokens: number;
	/** Sum cache-write (cache-creation) tokens for this model. */
	readonly cacheCreationInputTokens: number;
}

/** One usage record the meter ingests (the transport's {@link UsageReport}, re-exported for the seam). */
export type SkillifyUsageRecord = UsageReport;

/**
 * The skillify usage meter (d-AC-1). It IS a {@link UsageSink} (so the transport feeds it
 * directly) plus a `snapshot()` the composer reads and a `reset()` for test isolation.
 * Injectable everywhere: production wires the daemon's singleton; a test constructs a fresh
 * one, records canned {@link UsageReport}s, and asserts the rollup.
 */
export interface SkillifyUsageMeter extends UsageSink {
	/** The accumulated snapshot the pollination composer reads (d-AC-1). */
	snapshot(): SkillifyUsageSnapshot;
	/** Clear all accumulated usage (test isolation; also a manual "since now" reset affordance). */
	reset(): void;
}

/** An empty snapshot (no data yet) — `recorded: 0` so the composer maps it to `absent`. */
function emptySnapshot(): SkillifyUsageSnapshot {
	return {
		recorded: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
	};
}

/**
 * Build an in-memory {@link SkillifyUsageMeter} (d-AC-1). `record` SUMS each report's four
 * token counts and bumps the `recorded` call count; it is total + non-throwing (the
 * transport calls it on the hot path). `snapshot` returns an immutable copy of the current
 * sums; `reset` zeroes them. A negative/non-finite count in a report is clamped to `0`
 * defensively (the transport already enforces non-negative integers, but the meter never
 * trusts an out-of-band caller to keep its sums clean).
 */
export function createSkillifyUsageMeter(): SkillifyUsageMeter {
	let recorded = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadInputTokens = 0;
	let cacheCreationInputTokens = 0;
	let model: string | undefined;
	// Finding (meter-per-model): accumulate token sums PER MODEL id (insertion order preserved) so the
	// composer can price each model's tokens at its own 060b rate. The aggregate sums above stay for
	// back-compat display; pricing reads `perModel`.
	const perModel = new Map<
		string,
		{ recorded: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }
	>();

	/** Clamp a reported count to a non-negative integer (defensive; the transport already does this). */
	const clamp = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);

	return {
		record(report: SkillifyUsageRecord): void {
			recorded += 1;
			const ci = clamp(report.inputTokens);
			const co = clamp(report.outputTokens);
			const cr = clamp(report.cacheReadInputTokens);
			const cc = clamp(report.cacheCreationInputTokens);
			inputTokens += ci;
			outputTokens += co;
			cacheReadInputTokens += cr;
			cacheCreationInputTokens += cc;
			if (report.model.length > 0) {
				model = report.model;
				const b = perModel.get(report.model) ?? { recorded: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
				b.recorded += 1;
				b.inputTokens += ci;
				b.outputTokens += co;
				b.cacheReadInputTokens += cr;
				b.cacheCreationInputTokens += cc;
				perModel.set(report.model, b);
			}
		},
		snapshot(): SkillifyUsageSnapshot {
			const buckets: SkillifyUsageBucket[] = [...perModel.entries()].map(([m, b]) => ({ model: m, ...b }));
			// Finding (meter-per-model follow-up): a blank-model report adds to the aggregate sums above but
			// NOT to any per-model bucket, so `perModel` would under-represent total usage on a mixed run.
			// Since the composer prices `perModel` EXCLUSIVELY when present, emitting an incomplete `perModel`
			// would silently DROP the blank-model tokens from pricing. Only emit `perModel` when it fully
			// accounts for EVERY recorded call (Σ bucket.recorded === recorded); otherwise fall back to the
			// aggregate single-model path, which prices ALL tokens (no undercount).
			const bucketRecorded = buckets.reduce((sum, b) => sum + b.recorded, 0);
			const perModelComplete = buckets.length > 0 && bucketRecorded === recorded;
			return {
				recorded,
				inputTokens,
				outputTokens,
				cacheReadInputTokens,
				cacheCreationInputTokens,
				...(model !== undefined ? { model } : {}),
				...(perModelComplete ? { perModel: buckets } : {}),
			};
		},
		reset(): void {
			recorded = 0;
			inputTokens = 0;
			outputTokens = 0;
			cacheReadInputTokens = 0;
			cacheCreationInputTokens = 0;
			model = undefined;
			perModel.clear();
		},
	};
}

/**
 * A read-only view of a {@link SkillifyUsageMeter} (or a static snapshot) the composer
 * consumes. Decoupling the composer from the meter's write surface keeps the composer pure
 * over a snapshot: production passes the live meter (its `snapshot()` is read once per
 * compose); a test can pass a hand-built snapshot via {@link snapshotSource}.
 */
export interface SkillifyUsageSource {
	/** Read the current accumulated snapshot. */
	snapshot(): SkillifyUsageSnapshot;
}

/** Wrap a static {@link SkillifyUsageSnapshot} as a {@link SkillifyUsageSource} (test convenience). */
export function snapshotSource(snapshot: SkillifyUsageSnapshot): SkillifyUsageSource {
	return { snapshot: (): SkillifyUsageSnapshot => snapshot };
}

/** An empty {@link SkillifyUsageSource} — no data yet (the composer reports `absent`). */
export const emptyUsageSource: SkillifyUsageSource = snapshotSource(emptySnapshot());
