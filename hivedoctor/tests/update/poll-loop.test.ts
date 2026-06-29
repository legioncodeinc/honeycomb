/**
 * The 30-minute auto-update poll loop (PRD-064e AC-064e.1 cadence / .4 opt-out). The
 * clock + jitter are injected so ticks are deterministic and no real timer is armed.
 */

import { describe, expect, it, vi } from "vitest";

import { silentLogger } from "../../src/logger.js";
import { createUpdatePollLoop, jitteredDelay, DEFAULT_POLL_INTERVAL_MS } from "../../src/update/poll-loop.js";
import type { UpdateEngine, UpdatePreview, UpdateTransactionResult } from "../../src/update/update-engine.js";

/** A fake engine recording how many transactions ran. */
function fakeEngine(result: UpdateTransactionResult = { status: "no_update" }): {
	engine: UpdateEngine;
	runs: number;
} {
	const state = { runs: 0 };
	const engine: UpdateEngine = {
		async runUpdateTransaction(): Promise<UpdateTransactionResult> {
			state.runs += 1;
			return result;
		},
		// The poll loop only ticks runUpdateTransaction; preview is here to satisfy the interface.
		async previewUpdate(): Promise<UpdatePreview> {
			return { eligible: false, fromVersion: null, reason: "already_current" };
		},
	};
	return {
		engine,
		get runs() {
			return state.runs;
		},
	};
}

/** A clock whose sleep resolves immediately and records the requested delays. */
function recordingClock(): { sleep: (ms: number) => Promise<void>; now: () => number; delays: number[] } {
	const delays: number[] = [];
	return {
		delays,
		sleep: async (ms: number) => {
			delays.push(ms);
		},
		now: () => 0,
	};
}

describe("jitteredDelay", () => {
	it("lands within +/- the jitter fraction of the interval", () => {
		// rand=0 -> low end (interval * 0.9); rand≈1 -> high end (interval * 1.1).
		expect(jitteredDelay(1000, 0.1, 0)).toBe(900);
		expect(jitteredDelay(1000, 0.1, 0.5)).toBe(1000);
		expect(jitteredDelay(1000, 0.1, 0.999)).toBe(1100);
	});

	it("clamps a nonsensical fraction and never returns negative", () => {
		expect(jitteredDelay(1000, -1, 0)).toBe(1000); // negative fraction clamped to 0
		expect(jitteredDelay(1000, 2, 0)).toBeGreaterThanOrEqual(0);
	});
});

describe("tick (AC-064e.1 cadence)", () => {
	it("runs exactly one transaction per tick", async () => {
		const fe = fakeEngine();
		const loop = createUpdatePollLoop({
			engine: fe.engine,
			logger: silentLogger,
			clock: recordingClock(),
			autoUpdateDisabled: false,
		});
		await loop.tick();
		await loop.tick();
		expect(fe.runs).toBe(2);
	});

	it("uses the 30-minute default interval", () => {
		expect(DEFAULT_POLL_INTERVAL_MS).toBe(30 * 60 * 1000);
	});
});

describe("opt-out (AC-064e.4)", () => {
	it("a disabled loop never ticks (no registry/CDN poll at all)", async () => {
		const fe = fakeEngine();
		const loop = createUpdatePollLoop({
			engine: fe.engine,
			logger: silentLogger,
			clock: recordingClock(),
			autoUpdateDisabled: true,
		});
		const result = await loop.tick();
		expect(result).toBeNull();
		expect(fe.runs).toBe(0);
	});

	it("a disabled loop's start() is a no-op that arms no timer", async () => {
		const fe = fakeEngine();
		const clock = recordingClock();
		const loop = createUpdatePollLoop({
			engine: fe.engine,
			logger: silentLogger,
			clock,
			autoUpdateDisabled: true,
		});
		await loop.start(); // resolves immediately
		expect(clock.delays).toHaveLength(0);
		expect(fe.runs).toBe(0);
	});
});

describe("loop lifecycle", () => {
	it("ticks on each jittered interval until stopped", async () => {
		const fe = fakeEngine();
		let sleeps = 0;
		const loop = createUpdatePollLoop({
			engine: fe.engine,
			logger: silentLogger,
			autoUpdateDisabled: false,
			pollIntervalMs: 1000,
			jitterFraction: 0,
			random: () => 0.5,
			clock: {
				now: () => 0,
				sleep: async () => {
					sleeps += 1;
					// Stop after the loop has slept three times so start() resolves.
					if (sleeps >= 3) loop.stop();
				},
			},
		});
		await loop.start();
		// Slept (then ticked) before the stop landed: at least two completed ticks.
		expect(fe.runs).toBeGreaterThanOrEqual(2);
	});

	it("keeps polling even if a tick's engine throws (crash-safe)", async () => {
		let runs = 0;
		const engine: UpdateEngine = {
			async runUpdateTransaction(): Promise<UpdateTransactionResult> {
				runs += 1;
				throw new Error("engine exploded");
			},
			async previewUpdate(): Promise<UpdatePreview> {
				return { eligible: false, fromVersion: null, reason: "already_current" };
			},
		};
		const loop = createUpdatePollLoop({
			engine,
			logger: silentLogger,
			clock: recordingClock(),
			autoUpdateDisabled: false,
		});
		const result = await loop.tick();
		expect(runs).toBe(1);
		// The throw was swallowed into a failed result, not propagated.
		expect(result?.status).toBe("install_failed");
	});
});
