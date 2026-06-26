/**
 * PRD-060d / d-AC-1 — the in-memory skillify usage meter (`roi-skillify-meter.ts`).
 *
 * The meter IS the {@link UsageSink} the transport feeds. These tests prove it accumulates
 * the four token buckets, tracks the recorded-call count (the absent-vs-measured-zero
 * discriminant), captures the model id, clamps defensively, and resets for test isolation.
 */

import { describe, expect, it } from "vitest";

import type { UsageReport } from "../../../../src/daemon/runtime/inference/transport-anthropic.js";
import {
	createSkillifyUsageMeter,
	emptyUsageSource,
	snapshotSource,
} from "../../../../src/daemon/runtime/dashboard/roi-skillify-meter.js";

/** A canned usage report for the Haiku skillify path. */
function report(overrides: Partial<UsageReport> = {}): UsageReport {
	return {
		model: "claude-haiku-4-5",
		workload: "memory_pollinating",
		inputTokens: 100,
		outputTokens: 20,
		cacheReadInputTokens: 50,
		cacheCreationInputTokens: 5,
		...overrides,
	};
}

describe("d-AC-1: skillify usage meter accumulation", () => {
	it("starts empty (recorded: 0 ⇒ no data, the absent discriminant)", () => {
		const meter = createSkillifyUsageMeter();
		const snap = meter.snapshot();
		expect(snap.recorded).toBe(0);
		expect(snap.inputTokens).toBe(0);
		expect(snap.outputTokens).toBe(0);
		expect(snap.model).toBeUndefined();
	});

	it("sums token counts across recorded calls and tracks the call count + model", () => {
		const meter = createSkillifyUsageMeter();
		meter.record(report({ inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 50, cacheCreationInputTokens: 5 }));
		meter.record(report({ inputTokens: 200, outputTokens: 30, cacheReadInputTokens: 10, cacheCreationInputTokens: 1 }));

		const snap = meter.snapshot();
		expect(snap.recorded).toBe(2);
		expect(snap.inputTokens).toBe(300);
		expect(snap.outputTokens).toBe(50);
		expect(snap.cacheReadInputTokens).toBe(60);
		expect(snap.cacheCreationInputTokens).toBe(6);
		expect(snap.model).toBe("claude-haiku-4-5");
	});

	it("records a measured zero distinctly from absent (recorded > 0 with zero tokens)", () => {
		const meter = createSkillifyUsageMeter();
		meter.record(report({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }));
		const snap = meter.snapshot();
		expect(snap.recorded).toBe(1); // a call WAS metered (measured zero ≠ absent)
		expect(snap.inputTokens).toBe(0);
	});

	it("clamps negative / non-finite counts to 0 defensively", () => {
		const meter = createSkillifyUsageMeter();
		meter.record(report({ inputTokens: -50, outputTokens: Number.NaN, cacheReadInputTokens: 12.9 }));
		const snap = meter.snapshot();
		expect(snap.inputTokens).toBe(0);
		expect(snap.outputTokens).toBe(0);
		expect(snap.cacheReadInputTokens).toBe(12); // truncated to an integer
	});

	it("reset() clears all accumulated usage", () => {
		const meter = createSkillifyUsageMeter();
		meter.record(report());
		meter.reset();
		const snap = meter.snapshot();
		expect(snap.recorded).toBe(0);
		expect(snap.inputTokens).toBe(0);
		expect(snap.model).toBeUndefined();
	});

	// Finding (meter-per-model): tokens are tracked PER MODEL so a router/model swap mid-run does not
	// mis-price history at the last-seen model.
	it("accumulates token sums PER MODEL (a model swap mid-run keeps separate buckets)", () => {
		const meter = createSkillifyUsageMeter();
		meter.record(report({ model: "claude-haiku-4-5", inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }));
		meter.record(report({ model: "claude-sonnet-4-6", inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }));
		meter.record(report({ model: "claude-haiku-4-5", inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }));

		const snap = meter.snapshot();
		// Aggregate sums are still exposed (back-compat display).
		expect(snap.inputTokens).toBe(350);
		expect(snap.recorded).toBe(3);
		// Per-model buckets keep each model distinct.
		expect(snap.perModel).toBeDefined();
		const byModel = Object.fromEntries((snap.perModel ?? []).map((b) => [b.model, b]));
		expect(byModel["claude-haiku-4-5"]?.inputTokens).toBe(150); // 100 + 50
		expect(byModel["claude-haiku-4-5"]?.recorded).toBe(2);
		expect(byModel["claude-sonnet-4-6"]?.inputTokens).toBe(200);
		expect(byModel["claude-sonnet-4-6"]?.recorded).toBe(1);
	});
});

describe("d-AC-1: snapshot sources for the composer", () => {
	it("snapshotSource wraps a static snapshot", () => {
		const src = snapshotSource({
			recorded: 3,
			inputTokens: 1,
			outputTokens: 2,
			cacheReadInputTokens: 3,
			cacheCreationInputTokens: 4,
			model: "claude-haiku-4-5",
		});
		expect(src.snapshot().recorded).toBe(3);
	});

	it("emptyUsageSource reports no data (recorded: 0)", () => {
		expect(emptyUsageSource.snapshot().recorded).toBe(0);
	});
});
