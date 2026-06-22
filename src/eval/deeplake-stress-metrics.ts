/**
 * DeepLake stress-harness METRICS — PRD-034b FR-2/FR-3/FR-4/FR-5 (the measurement core).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * PURE FUNCTIONS over recorded outcomes. No I/O, no clock, no storage, no
 * randomness — every function here is a deterministic transform of a list of
 * recorded attempt/convergence samples into a report shape. That purity is the
 * point (mirroring `src/eval/metrics.ts`, PRD-027): the percentile / convergence
 * / error-rate math is unit-tested against HAND-COMPUTED expectations (no "feels
 * right"), and the live load generator (`deeplake-stress.ts`) feeds the SAME
 * functions here the samples it captured live. One source of the math.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── The two sample kinds the load generator records ──────────────────────────
 *   1. {@link AttemptSample} — ONE recorded TRANSPORT attempt: a single round-trip
 *      to the backend, tagged with its statement KIND (INSERT/SELECT/DELETE/
 *      UPDATE/OTHER), its OUTCOME class (ok / 429 / 5xx / timeout / connection),
 *      its latency, and whether it was a RETRY of an earlier attempt for the same
 *      logical operation. The RAW attempt stream is what lets the report show the
 *      backend's TRUE error rate (every flap counted), distinct from the
 *      post-retry EFFECTIVE rate (only the final outcome per operation).
 *   2. {@link ConvergenceSample} — one write→read-back: the time (ms) from a write
 *      returning ok to a poll-read observing it (the headline vendor metric, FR-4).
 *
 * ── Percentiles ──────────────────────────────────────────────────────────────
 * Percentiles use the NEAREST-RANK method on the sorted sample (the rank for
 * percentile p over n samples is `ceil(p/100 * n)`, 1-based, clamped to [1, n]).
 * Nearest-rank is chosen over linear interpolation because it is the simplest to
 * hand-verify in the unit tests and it always returns an ACTUALLY-OBSERVED value
 * (a real latency a row really took), which is what a vendor escalation wants.
 */

// ── Statement kinds + outcome classes (the report's two axes) ───────────────

/**
 * The statement KIND a recorded attempt belongs to. Mirrors the four DeepLake
 * statement shapes the load generator drives (FR-2/FR-3), plus `other` for any
 * DDL/teardown statement we record but don't headline (CREATE/DROP).
 */
export type StatementKind = "insert" | "select" | "delete" | "update" | "other";

/** The ordered statement kinds the report iterates (stable column order). */
export const STATEMENT_KINDS: readonly StatementKind[] = ["insert", "select", "delete", "update", "other"];

/**
 * The OUTCOME class of one transport attempt (FR-3). `ok` is success; the rest
 * are the failure shapes the DeepLake backend produces under load — the transient
 * HTTP set (429/500/502/503/504), a `timeout` (our abort fired), a
 * `connection` drop (socket reset / DNS / TLS), and `other` for a non-transient
 * `query_error` (a real SQL/logic fault, e.g. 42P01). The classes are derived
 * from the storage client's `QueryResult` union (see {@link classifyOutcome}).
 */
export type OutcomeClass = "ok" | "429" | "500" | "502" | "503" | "504" | "timeout" | "connection" | "other";

/** The ordered outcome classes the report iterates (stable column order). */
export const OUTCOME_CLASSES: readonly OutcomeClass[] = [
	"ok",
	"429",
	"500",
	"502",
	"503",
	"504",
	"timeout",
	"connection",
	"other",
];

// ── The recorded samples (what the live generator captures) ─────────────────

/**
 * One recorded transport attempt. `latencyMs` is the wall-clock of that single
 * round-trip. `isRetry` marks an attempt that re-issued a logical operation after
 * an earlier flap — so the RAW stream (all attempts) and the EFFECTIVE stream
 * (final-attempt-per-operation only, `isRetry === false` finals) can both be
 * derived from one list.
 */
export interface AttemptSample {
	/** The statement kind this attempt ran. */
	readonly kind: StatementKind;
	/** The outcome class of this single attempt. */
	readonly outcome: OutcomeClass;
	/** Wall-clock latency of this one round-trip, in ms (≥ 0). */
	readonly latencyMs: number;
	/** True iff this attempt was a retry of an earlier attempt for the same operation. */
	readonly isRetry: boolean;
	/** The concurrency level the run was driving when this attempt was issued (FR-5). */
	readonly concurrency: number;
}

/**
 * One recorded write→read convergence sample (FR-4): the time from a write
 * returning ok to a poll-read first observing the written row. `converged: false`
 * means the read never caught up within the poll budget (the row stayed
 * invisible) — recorded so the report can show a convergence-FAILURE rate, never
 * silently dropped.
 */
export interface ConvergenceSample {
	/** Time from write-ok to read-reflects-write, in ms (≥ 0). */
	readonly elapsedMs: number;
	/** False iff the poll budget exhausted before the write became visible. */
	readonly converged: boolean;
}

// ── Percentile / latency summary ────────────────────────────────────────────

/** The latency distribution summary for a set of latency samples (FR-2). */
export interface LatencySummary {
	/** Number of samples (the denominator). */
	readonly count: number;
	/** Arithmetic mean latency in ms (0 when count is 0). */
	readonly meanMs: number;
	/** 50th-percentile (median) latency in ms (0 when count is 0). */
	readonly p50Ms: number;
	/** 95th-percentile latency in ms (0 when count is 0). */
	readonly p95Ms: number;
	/** 99th-percentile latency in ms (0 when count is 0). */
	readonly p99Ms: number;
	/** Maximum observed latency in ms (0 when count is 0). */
	readonly maxMs: number;
}

/** The all-zero latency summary for an empty sample set (never NaN). */
const EMPTY_LATENCY: LatencySummary = Object.freeze({
	count: 0,
	meanMs: 0,
	p50Ms: 0,
	p95Ms: 0,
	p99Ms: 0,
	maxMs: 0,
});

/**
 * The nearest-rank percentile of a list of numbers (`p` in [0, 100]). Sorts a
 * COPY ascending (never mutates the input), then picks the value at 1-based rank
 * `ceil(p/100 * n)` clamped to `[1, n]`. An empty list yields 0. `p` is clamped
 * to `[0, 100]`. Pure + deterministic, so the unit tests fix a known array and
 * assert the exact value.
 *
 * Examples (n = 10, values 1..10): p50 → rank ceil(5) = 5 → value 5; p95 → rank
 * ceil(9.5) = 10 → value 10; p99 → rank ceil(9.9) = 10 → value 10.
 */
export function percentile(values: readonly number[], p: number): number {
	const n = values.length;
	if (n === 0) return 0;
	const clampedP = Math.min(100, Math.max(0, p));
	const sorted = [...values].sort((a, b) => a - b);
	if (clampedP <= 0) return sorted[0] as number;
	// 1-based nearest rank, clamped into [1, n].
	const rank = Math.min(n, Math.max(1, Math.ceil((clampedP / 100) * n)));
	return sorted[rank - 1] as number;
}

/** The arithmetic mean of a list (0 for an empty list — never NaN). */
export function mean(values: readonly number[]): number {
	if (values.length === 0) return 0;
	let sum = 0;
	for (const v of values) sum += v;
	return sum / values.length;
}

/**
 * Reduce a list of latency samples to a {@link LatencySummary}: count, mean, p50/
 * p95/p99, and max. An empty list yields the all-zero summary (never NaN). The
 * max is the p100 nearest-rank (the last sorted value), computed directly to make
 * the intent obvious.
 */
export function summarizeLatency(latenciesMs: readonly number[]): LatencySummary {
	if (latenciesMs.length === 0) return EMPTY_LATENCY;
	return {
		count: latenciesMs.length,
		meanMs: mean(latenciesMs),
		p50Ms: percentile(latenciesMs, 50),
		p95Ms: percentile(latenciesMs, 95),
		p99Ms: percentile(latenciesMs, 99),
		maxMs: Math.max(...latenciesMs),
	};
}

// ── Latency by statement kind (FR-2) ────────────────────────────────────────

/**
 * Per-statement-kind latency summary keyed by {@link StatementKind}. Every kind in
 * {@link STATEMENT_KINDS} is present (an unobserved kind maps to the all-zero
 * summary) so the report's table has a stable, complete shape.
 */
export type LatencyByKind = Readonly<Record<StatementKind, LatencySummary>>;

/**
 * Group the RAW attempt stream by statement kind and summarize each group's
 * latency (FR-2). Latency is taken from EVERY attempt (raw), so a slow flap that
 * was later retried still contributes its latency — the report shows the
 * backend's real per-statement latency under load, not just the happy path.
 */
export function latencyByKind(attempts: readonly AttemptSample[]): LatencyByKind {
	const buckets = new Map<StatementKind, number[]>();
	for (const kind of STATEMENT_KINDS) buckets.set(kind, []);
	for (const a of attempts) {
		const list = buckets.get(a.kind);
		if (list) list.push(a.latencyMs);
	}
	const out = {} as Record<StatementKind, LatencySummary>;
	for (const kind of STATEMENT_KINDS) {
		out[kind] = summarizeLatency(buckets.get(kind) ?? []);
	}
	return out;
}

// ── Error rate by outcome class + by statement kind (FR-3) ──────────────────

/** A count + rate breakdown over the outcome classes (FR-3). */
export interface ErrorRateBreakdown {
	/** Total attempts in this group (the denominator). */
	readonly total: number;
	/** Count of attempts per outcome class (every class present; 0 when unobserved). */
	readonly counts: Readonly<Record<OutcomeClass, number>>;
	/** Rate (count/total) per outcome class, in [0, 1]; all-zero when total is 0. */
	readonly rates: Readonly<Record<OutcomeClass, number>>;
	/** The non-ok rate: 1 − rates.ok (the headline "error rate"). */
	readonly errorRate: number;
}

/** A zero-initialized per-class counter map (every class present). */
function zeroCounts(): Record<OutcomeClass, number> {
	const c = {} as Record<OutcomeClass, number>;
	for (const cls of OUTCOME_CLASSES) c[cls] = 0;
	return c;
}

/**
 * Reduce a set of attempts to an {@link ErrorRateBreakdown}: per-class counts +
 * rates + the headline non-ok error rate. An empty set yields all-zero counts/
 * rates and `errorRate: 0` (never NaN). Pure.
 */
export function errorRateBreakdown(attempts: readonly AttemptSample[]): ErrorRateBreakdown {
	const counts = zeroCounts();
	for (const a of attempts) counts[a.outcome] += 1;
	const total = attempts.length;
	const rates = {} as Record<OutcomeClass, number>;
	for (const cls of OUTCOME_CLASSES) rates[cls] = total === 0 ? 0 : counts[cls] / total;
	const errorRate = total === 0 ? 0 : 1 - rates.ok;
	return { total, counts, rates, errorRate };
}

/**
 * Per-statement-kind error breakdown (FR-3): the outcome breakdown computed
 * within each statement kind, so the report can show "INSERTs flapped 502 at
 * rate X while SELECTs were clean". Every kind present (an unobserved kind maps
 * to the all-zero breakdown).
 */
export type ErrorRateByKind = Readonly<Record<StatementKind, ErrorRateBreakdown>>;

/** Group attempts by statement kind and compute each group's error breakdown (FR-3). */
export function errorRateByKind(attempts: readonly AttemptSample[]): ErrorRateByKind {
	const buckets = new Map<StatementKind, AttemptSample[]>();
	for (const kind of STATEMENT_KINDS) buckets.set(kind, []);
	for (const a of attempts) buckets.get(a.kind)?.push(a);
	const out = {} as Record<StatementKind, ErrorRateBreakdown>;
	for (const kind of STATEMENT_KINDS) {
		out[kind] = errorRateBreakdown(buckets.get(kind) ?? []);
	}
	return out;
}

// ── Raw vs post-retry effective error rate (the implementation-note headline) ──

/**
 * The RAW-vs-EFFECTIVE error split (PRD-034b implementation note). The RAW rate
 * counts EVERY transport attempt (the backend's true flap rate); the EFFECTIVE
 * rate counts only the FINAL outcome per logical operation (what the retry layer
 * salvaged). The gap between them quantifies how much work the storage client's
 * retry is doing to mask the backend's instability — the exact thing the vendor
 * needs to see.
 */
export interface RawVsEffective {
	/** The breakdown over ALL attempts (raw — every flap counted). */
	readonly raw: ErrorRateBreakdown;
	/** The breakdown over only the FINAL attempt of each operation (post-retry effective). */
	readonly effective: ErrorRateBreakdown;
}

/**
 * Split an attempt stream into raw vs effective breakdowns (FR-3 + the impl
 * note). RAW = every attempt. EFFECTIVE = the attempts that are NOT marked as a
 * retry being superseded — concretely, we keep only the FINAL attempt per
 * operation. Since the load generator records attempts for one operation
 * contiguously and tags every re-issue `isRetry: true`, the FINAL attempt of an
 * operation is the one after which the kind/operation changes; rather than thread
 * operation ids, the generator passes the already-computed `finals` list (the
 * last attempt of each operation). This function simply runs the breakdown over
 * each. Keeping the two inputs explicit keeps the math pure + trivially testable.
 */
export function rawVsEffective(allAttempts: readonly AttemptSample[], finalAttempts: readonly AttemptSample[]): RawVsEffective {
	return {
		raw: errorRateBreakdown(allAttempts),
		effective: errorRateBreakdown(finalAttempts),
	};
}

// ── Convergence-time distribution (FR-4 — the headline vendor metric) ───────

/** The eventual-consistency convergence-time distribution (FR-4). */
export interface ConvergenceSummary {
	/** Number of write→read samples recorded (the denominator). */
	readonly count: number;
	/** Of those, how many converged within budget. */
	readonly convergedCount: number;
	/** Fraction that NEVER converged within the poll budget, in [0, 1]. */
	readonly nonConvergenceRate: number;
	/** Latency distribution over the CONVERGED samples' elapsed times (ms). */
	readonly latency: LatencySummary;
}

/**
 * Reduce write→read convergence samples to a {@link ConvergenceSummary} (FR-4):
 * the count, the converged count, the non-convergence rate, and the p50/p95/p99/
 * max convergence time over the samples that DID converge. The percentile
 * distribution is computed over converged samples only (a non-converged sample
 * has no finite convergence time — counting its capped budget would understate
 * the tail). An empty set yields all-zero (never NaN). Pure.
 */
export function summarizeConvergence(samples: readonly ConvergenceSample[]): ConvergenceSummary {
	const count = samples.length;
	const converged = samples.filter((s) => s.converged);
	const convergedCount = converged.length;
	const nonConvergenceRate = count === 0 ? 0 : (count - convergedCount) / count;
	const latency = summarizeLatency(converged.map((s) => s.elapsedMs));
	return { count, convergedCount, nonConvergenceRate, latency };
}

// ── Throughput + error-rate-vs-concurrency (FR-5) ───────────────────────────

/**
 * Throughput over a phase: completed operations per second. `ops` is the number
 * of operations and `wallClockMs` the wall-clock span they ran across. A zero or
 * non-finite span yields 0 (never Infinity/NaN) — a degenerate span is not a
 * meaningful throughput.
 */
export function throughputOpsPerSec(ops: number, wallClockMs: number): number {
	if (!Number.isFinite(wallClockMs) || wallClockMs <= 0) return 0;
	return ops / (wallClockMs / 1000);
}

/**
 * One row of the error-rate-vs-concurrency table (FR-5): at a given concurrency
 * level, the attempt count, the headline error rate, the throughput, and the
 * latency summary. This is the table that shows WHERE the backend's error rate
 * climbs as concurrency rises — the vendor-repro dial output (b-AC-5).
 */
export interface ConcurrencyScalingRow {
	/** The concurrency level this row summarizes. */
	readonly concurrency: number;
	/** Total attempts recorded at this concurrency. */
	readonly attempts: number;
	/** The non-ok error rate over those attempts, in [0, 1]. */
	readonly errorRate: number;
	/** Operations/sec sustained at this concurrency (0 when the span is unknown). */
	readonly throughputOpsPerSec: number;
	/** Latency distribution at this concurrency. */
	readonly latency: LatencySummary;
}

/**
 * Build the error-rate-vs-concurrency table (FR-5). Groups the RAW attempt stream
 * by `concurrency`, and for each level computes the error rate, the latency
 * summary, and (from the supplied per-level wall-clock spans) the throughput.
 * Rows are sorted by ascending concurrency so the table reads as a sweep. A level
 * with no recorded wall-clock span reports throughput 0 (the latency/error rate
 * are still exact). Pure given its inputs.
 */
export function concurrencyScaling(
	attempts: readonly AttemptSample[],
	spansMsByConcurrency: ReadonlyMap<number, number>,
): ConcurrencyScalingRow[] {
	const byLevel = new Map<number, AttemptSample[]>();
	for (const a of attempts) {
		const list = byLevel.get(a.concurrency);
		if (list) list.push(a);
		else byLevel.set(a.concurrency, [a]);
	}
	const rows: ConcurrencyScalingRow[] = [];
	for (const [concurrency, group] of byLevel) {
		const breakdown = errorRateBreakdown(group);
		const span = spansMsByConcurrency.get(concurrency);
		rows.push({
			concurrency,
			attempts: group.length,
			errorRate: breakdown.errorRate,
			throughputOpsPerSec: span === undefined ? 0 : throughputOpsPerSec(group.length, span),
			latency: summarizeLatency(group.map((a) => a.latencyMs)),
		});
	}
	rows.sort((a, b) => a.concurrency - b.concurrency);
	return rows;
}
