/**
 * PRD-034b FR-2/FR-3/FR-4/FR-5 — the stress-harness METRICS unit suite.
 *
 * Every expectation here is HAND-COMPUTED (no live backend, no clock, no randomness).
 * The metrics are pure functions over recorded samples, so each case fixes a tiny
 * sample list and asserts the exact percentile / error-rate / convergence / throughput
 * value. These run in `npm run ci` (no creds, no daemon).
 */

import { describe, expect, it } from "vitest";

import {
	type AttemptSample,
	concurrencyScaling,
	type ConvergenceSample,
	errorRateBreakdown,
	errorRateByKind,
	latencyByKind,
	mean,
	type OutcomeClass,
	percentile,
	rawVsEffective,
	type StatementKind,
	summarizeConvergence,
	summarizeLatency,
	throughputOpsPerSec,
} from "../../src/eval/deeplake-stress-metrics.js";

/** Build an attempt sample with sensible defaults so cases stay terse. */
function attempt(
	over: Partial<AttemptSample> & { kind: StatementKind; outcome: OutcomeClass; latencyMs: number },
): AttemptSample {
	return { isRetry: false, concurrency: 1, ...over };
}

describe("percentile (nearest-rank, FR-2)", () => {
	it("computes p50/p95/p99/max on a known 1..10 array", () => {
		const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		// nearest-rank: p50 → ceil(0.5*10)=5 → value 5; p95 → ceil(9.5)=10 → 10; p99 → ceil(9.9)=10 → 10.
		expect(percentile(v, 50)).toBe(5);
		expect(percentile(v, 95)).toBe(10);
		expect(percentile(v, 99)).toBe(10);
		expect(percentile(v, 100)).toBe(10);
	});

	it("is order-independent (sorts a copy, never mutates input)", () => {
		const v = [10, 1, 5, 3, 9, 2, 8, 4, 7, 6];
		const copy = [...v];
		expect(percentile(v, 50)).toBe(5);
		expect(v).toEqual(copy); // input untouched
	});

	it("returns 0 for an empty list and the single value for n=1", () => {
		expect(percentile([], 95)).toBe(0);
		expect(percentile([42], 50)).toBe(42);
		expect(percentile([42], 99)).toBe(42);
	});

	it("clamps p<=0 to the minimum sample and p>100 to the max", () => {
		const v = [5, 10, 15];
		expect(percentile(v, 0)).toBe(5);
		expect(percentile(v, -10)).toBe(5);
		expect(percentile(v, 999)).toBe(15);
	});
});

describe("mean + summarizeLatency (FR-2)", () => {
	it("means a known list and zero-fills the empty case", () => {
		expect(mean([2, 4, 6])).toBe(4);
		expect(mean([])).toBe(0);
	});

	it("summarizes a known latency list with exact percentiles + max + mean", () => {
		const s = summarizeLatency([10, 20, 30, 40, 100]);
		expect(s.count).toBe(5);
		expect(s.meanMs).toBe(40); // (10+20+30+40+100)/5
		expect(s.p50Ms).toBe(30); // ceil(2.5)=3 → 3rd value = 30
		expect(s.p95Ms).toBe(100); // ceil(4.75)=5 → 100
		expect(s.p99Ms).toBe(100);
		expect(s.maxMs).toBe(100);
	});

	it("yields the all-zero summary for an empty sample set (never NaN)", () => {
		const s = summarizeLatency([]);
		expect(s).toEqual({ count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 });
	});
});

describe("latencyByKind (FR-2)", () => {
	it("groups latency by statement kind and leaves unobserved kinds zeroed", () => {
		const attempts: AttemptSample[] = [
			attempt({ kind: "insert", outcome: "ok", latencyMs: 100 }),
			attempt({ kind: "insert", outcome: "502", latencyMs: 300 }),
			attempt({ kind: "select", outcome: "ok", latencyMs: 10 }),
		];
		const byKind = latencyByKind(attempts);
		expect(byKind.insert.count).toBe(2);
		expect(byKind.insert.maxMs).toBe(300);
		expect(byKind.insert.meanMs).toBe(200);
		expect(byKind.select.count).toBe(1);
		expect(byKind.delete.count).toBe(0); // unobserved → all-zero
		expect(byKind.update.count).toBe(0);
	});
});

describe("errorRateBreakdown + errorRateByKind (FR-3)", () => {
	it("counts per outcome class and computes the headline non-ok error rate", () => {
		const attempts: AttemptSample[] = [
			attempt({ kind: "insert", outcome: "ok", latencyMs: 1 }),
			attempt({ kind: "insert", outcome: "ok", latencyMs: 1 }),
			attempt({ kind: "insert", outcome: "502", latencyMs: 1 }),
			attempt({ kind: "insert", outcome: "timeout", latencyMs: 1 }),
		];
		const b = errorRateBreakdown(attempts);
		expect(b.total).toBe(4);
		expect(b.counts.ok).toBe(2);
		expect(b.counts["502"]).toBe(1);
		expect(b.counts.timeout).toBe(1);
		expect(b.rates.ok).toBeCloseTo(0.5, 10);
		expect(b.errorRate).toBeCloseTo(0.5, 10); // 1 - rates.ok
	});

	it("is all-zero (errorRate 0) for an empty set, never NaN", () => {
		const b = errorRateBreakdown([]);
		expect(b.total).toBe(0);
		expect(b.errorRate).toBe(0);
		expect(b.rates.ok).toBe(0);
	});

	it("breaks the error rate down per statement kind (FR-3)", () => {
		const attempts: AttemptSample[] = [
			attempt({ kind: "insert", outcome: "502", latencyMs: 1 }),
			attempt({ kind: "insert", outcome: "ok", latencyMs: 1 }),
			attempt({ kind: "select", outcome: "ok", latencyMs: 1 }),
			attempt({ kind: "select", outcome: "ok", latencyMs: 1 }),
		];
		const byKind = errorRateByKind(attempts);
		expect(byKind.insert.errorRate).toBeCloseTo(0.5, 10); // 1 of 2 flapped
		expect(byKind.select.errorRate).toBe(0); // both ok
	});
});

describe("rawVsEffective (FR-3 + impl note)", () => {
	it("shows the backend's true error rate (raw) vs the post-retry effective rate", () => {
		// One logical operation: two transient 502 flaps then an ok (the retry salvaged it).
		const all: AttemptSample[] = [
			attempt({ kind: "insert", outcome: "502", latencyMs: 1, isRetry: false }),
			attempt({ kind: "insert", outcome: "502", latencyMs: 1, isRetry: true }),
			attempt({ kind: "insert", outcome: "ok", latencyMs: 1, isRetry: true }),
		];
		// EFFECTIVE = the terminal attempt of the operation (the ok).
		const finals: AttemptSample[] = [all[2] as AttemptSample];
		const rve = rawVsEffective(all, finals);
		// RAW: 1 of 3 attempts ok → error rate 2/3.
		expect(rve.raw.errorRate).toBeCloseTo(2 / 3, 10);
		// EFFECTIVE: the operation finally succeeded → error rate 0.
		expect(rve.effective.errorRate).toBe(0);
		// The gap is exactly what the retry layer masked.
		expect(rve.raw.errorRate).toBeGreaterThan(rve.effective.errorRate);
	});
});

describe("summarizeConvergence (FR-4 — headline)", () => {
	it("computes the convergence-time distribution over converged samples", () => {
		const samples: ConvergenceSample[] = [
			{ elapsedMs: 50, converged: true },
			{ elapsedMs: 100, converged: true },
			{ elapsedMs: 150, converged: true },
			{ elapsedMs: 200, converged: true },
		];
		const c = summarizeConvergence(samples);
		expect(c.count).toBe(4);
		expect(c.convergedCount).toBe(4);
		expect(c.nonConvergenceRate).toBe(0);
		expect(c.latency.p50Ms).toBe(100); // ceil(0.5*4)=2 → 2nd value = 100
		expect(c.latency.maxMs).toBe(200);
	});

	it("counts non-convergence and excludes non-converged from the distribution", () => {
		const samples: ConvergenceSample[] = [
			{ elapsedMs: 50, converged: true },
			{ elapsedMs: 9999, converged: false }, // budget exhausted — excluded from percentiles
			{ elapsedMs: 70, converged: true },
			{ elapsedMs: 9999, converged: false },
		];
		const c = summarizeConvergence(samples);
		expect(c.count).toBe(4);
		expect(c.convergedCount).toBe(2);
		expect(c.nonConvergenceRate).toBeCloseTo(0.5, 10);
		// Distribution is over the converged elapsed times only (50, 70) — the 9999s excluded.
		expect(c.latency.maxMs).toBe(70);
	});

	it("is all-zero for an empty set (never NaN)", () => {
		const c = summarizeConvergence([]);
		expect(c.count).toBe(0);
		expect(c.nonConvergenceRate).toBe(0);
		expect(c.latency.count).toBe(0);
	});
});

describe("throughputOpsPerSec + concurrencyScaling (FR-5)", () => {
	it("computes ops/sec and guards a zero/garbage span", () => {
		expect(throughputOpsPerSec(100, 1000)).toBeCloseTo(100, 10); // 100 ops in 1s
		expect(throughputOpsPerSec(50, 500)).toBeCloseTo(100, 10);
		expect(throughputOpsPerSec(10, 0)).toBe(0); // no span → 0, never Infinity
		expect(throughputOpsPerSec(10, Number.NaN)).toBe(0);
	});

	it("builds the error-rate-vs-concurrency table sorted ascending", () => {
		const attempts: AttemptSample[] = [
			// concurrency 8: 1 flap of 2.
			attempt({ kind: "insert", outcome: "502", latencyMs: 100, concurrency: 8 }),
			attempt({ kind: "insert", outcome: "ok", latencyMs: 50, concurrency: 8 }),
			// concurrency 1: clean.
			attempt({ kind: "insert", outcome: "ok", latencyMs: 10, concurrency: 1 }),
			attempt({ kind: "insert", outcome: "ok", latencyMs: 20, concurrency: 1 }),
		];
		const spans = new Map<number, number>([
			[1, 1000], // 2 ops in 1s → 2 ops/s
			[8, 2000], // 2 ops in 2s → 1 ops/s
		]);
		const rows = concurrencyScaling(attempts, spans);
		expect(rows.map((r) => r.concurrency)).toEqual([1, 8]); // ascending
		expect(rows[0]?.errorRate).toBe(0); // c=1 clean
		expect(rows[0]?.throughputOpsPerSec).toBeCloseTo(2, 10);
		expect(rows[1]?.errorRate).toBeCloseTo(0.5, 10); // c=8 flapped 1/2
		expect(rows[1]?.throughputOpsPerSec).toBeCloseTo(1, 10);
		expect(rows[1]?.latency.maxMs).toBe(100);
	});

	it("reports throughput 0 for a level with no recorded span", () => {
		const attempts: AttemptSample[] = [attempt({ kind: "insert", outcome: "ok", latencyMs: 10, concurrency: 4 })];
		const rows = concurrencyScaling(attempts, new Map());
		expect(rows[0]?.throughputOpsPerSec).toBe(0);
		expect(rows[0]?.errorRate).toBe(0);
	});
});
