/**
 * PRD-077b (L-B6) — the four hot-lane amplification knobs.
 *
 * Verifies (via the provider seam, no env mutation — mirrors `amplification-config.test.ts`) that
 * `recallFastMaxConcurrency` / `recallFastDeadlineMs` / `recallFastShedQueueDepth` /
 * `recallHeavyDeadlineMs` resolve to their documented defaults, honor an explicit override, and
 * coerce/clamp a bad value rather than rejecting the config.
 *
 * No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import {
	DEFAULT_RECALL_FAST_MAX_CONCURRENCY,
	DEFAULT_RECALL_FAST_DEADLINE_MS,
	DEFAULT_RECALL_FAST_SHED_QUEUE_DEPTH,
	DEFAULT_RECALL_HEAVY_DEADLINE_MS,
	MIN_RECALL_FAST_MAX_CONCURRENCY,
	MIN_RECALL_DEADLINE_MS,
	MIN_RECALL_SHED_QUEUE_DEPTH,
	resolveAmplificationConfig,
	type AmplificationConfigProvider,
	type RawAmplificationConfig,
} from "../../../../src/daemon/runtime/memories/amplification-config.js";

function provider(raw: RawAmplificationConfig): AmplificationConfigProvider {
	return { read: () => raw };
}

describe("amplification config: the four hot-lane knobs default to their documented posture (L-B6)", () => {
	it("an empty record yields fast-width 8, fast-deadline 3000ms, shed-depth 8, heavy-deadline 15000ms", () => {
		const cfg = resolveAmplificationConfig(provider({}));
		expect(cfg.recallFastMaxConcurrency).toBe(DEFAULT_RECALL_FAST_MAX_CONCURRENCY);
		expect(cfg.recallFastMaxConcurrency).toBe(8);
		expect(cfg.recallFastDeadlineMs).toBe(DEFAULT_RECALL_FAST_DEADLINE_MS);
		expect(cfg.recallFastDeadlineMs).toBe(3000);
		expect(cfg.recallFastShedQueueDepth).toBe(DEFAULT_RECALL_FAST_SHED_QUEUE_DEPTH);
		expect(cfg.recallFastShedQueueDepth).toBe(8);
		expect(cfg.recallHeavyDeadlineMs).toBe(DEFAULT_RECALL_HEAVY_DEADLINE_MS);
		expect(cfg.recallHeavyDeadlineMs).toBe(15000);
	});
});

describe("amplification config: the hot-lane knobs honor an explicit override (env-equivalent raw value)", () => {
	it("a numeric string or number is parsed and honored for each knob", () => {
		const cfg = resolveAmplificationConfig(
			provider({
				recallFastMaxConcurrency: "12",
				recallFastDeadlineMs: 2500,
				recallFastShedQueueDepth: "16",
				recallHeavyDeadlineMs: "20000",
			}),
		);
		expect(cfg.recallFastMaxConcurrency).toBe(12);
		expect(cfg.recallFastDeadlineMs).toBe(2500);
		expect(cfg.recallFastShedQueueDepth).toBe(16);
		expect(cfg.recallHeavyDeadlineMs).toBe(20000);
	});
});

describe("amplification config: the hot-lane knobs coerce + clamp rather than rejecting", () => {
	it("a non-numeric value falls back to the documented default (not a config failure)", () => {
		const cfg = resolveAmplificationConfig(
			provider({
				recallFastMaxConcurrency: "abc",
				recallFastDeadlineMs: "not-a-number",
				recallFastShedQueueDepth: "xyz",
				recallHeavyDeadlineMs: "??",
			}),
		);
		expect(cfg.recallFastMaxConcurrency).toBe(DEFAULT_RECALL_FAST_MAX_CONCURRENCY);
		expect(cfg.recallFastDeadlineMs).toBe(DEFAULT_RECALL_FAST_DEADLINE_MS);
		expect(cfg.recallFastShedQueueDepth).toBe(DEFAULT_RECALL_FAST_SHED_QUEUE_DEPTH);
		expect(cfg.recallHeavyDeadlineMs).toBe(DEFAULT_RECALL_HEAVY_DEADLINE_MS);
	});

	it("a sub-floor value is clamped UP to the knob's floor (a deadline must be positive; a width ≥ 1)", () => {
		const cfg = resolveAmplificationConfig(
			provider({
				recallFastMaxConcurrency: 0, // clamps up to 1 (a pool must admit one task)
				recallFastDeadlineMs: 0, // clamps up to 1ms (a 0 would abort every query on the next tick)
				recallFastShedQueueDepth: -5, // clamps up to 0 (shed the moment any waiter parks)
				recallHeavyDeadlineMs: -100, // clamps up to 1ms
			}),
		);
		expect(cfg.recallFastMaxConcurrency).toBe(MIN_RECALL_FAST_MAX_CONCURRENCY);
		expect(cfg.recallFastDeadlineMs).toBe(MIN_RECALL_DEADLINE_MS);
		expect(cfg.recallFastShedQueueDepth).toBe(MIN_RECALL_SHED_QUEUE_DEPTH);
		expect(cfg.recallHeavyDeadlineMs).toBe(MIN_RECALL_DEADLINE_MS);
	});
});
