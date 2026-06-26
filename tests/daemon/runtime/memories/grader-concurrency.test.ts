/**
 * PRD-062d (L-D2 / AC-62d.2.1 / AC-62d.2.2) — bounded usefulness-grader concurrency.
 *
 * `gradeRecallBatch` previously fired an UNBOUNDED `Promise.all` of contradiction-detector
 * calls. It now runs under the bounded pool:
 *  1. CAP: across a batch grade, no more than `N` detector calls are in flight at once
 *     (the injected {@link Semaphore} width), asserted with a controllable in-flight
 *     counter on the detector — no real sleep.
 *  2. PARITY: the grades are returned in INPUT ORDER and are byte-identical with a narrow
 *     cap vs a wide (no-op) cap — the ceiling changes timing, not output (parent AC-8).
 *
 * No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import {
	gradeRecallBatch,
	type ContradictionDetector,
	type RecallOutcomeSignals,
} from "../../../../src/daemon/runtime/memories/usefulness-grader.js";
import { Semaphore } from "../../../../src/daemon/runtime/memories/bounded-pool.js";

/** An injected, kept recall signal (so the grader consults the detector). */
function signal(id: string): RecallOutcomeSignals {
	return { memoryId: id, injectedText: `mem ${id}`, injected: true, ignored: false, outcomeText: `turn ${id}` };
}

/**
 * A detector that tracks LIVE in-flight calls and parks each until released — so the
 * batch's concurrent-call peak is observable deterministically (no timers).
 */
function gatedDetector(): { detector: ContradictionDetector; peak: () => number; release: () => void } {
	let inFlight = 0;
	let peak = 0;
	let released = false;
	const gates: Array<() => void> = [];
	const detector: ContradictionDetector = {
		async detect(): Promise<number> {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			if (!released) await new Promise<void>((resolve) => gates.push(resolve));
			inFlight -= 1;
			return 0; // no contradiction → u ≈ 1.
		},
	};
	return {
		detector,
		peak: () => peak,
		release: () => {
			released = true;
			while (gates.length > 0) gates.shift()?.();
		},
	};
}

describe("grader concurrency: detector calls are capped at N (AC-62d.2.1)", () => {
	it("never exceeds the injected semaphore width across the batch", async () => {
		const { detector, peak, release } = gatedDetector();
		const pool = new Semaphore(2);
		const signals = ["a", "b", "c", "d", "e"].map(signal);

		const run = gradeRecallBatch(signals, { detector, gradePool: pool });
		await Promise.resolve();
		await Promise.resolve();
		release();
		const grades = await run;

		expect(peak()).toBeLessThanOrEqual(2);
		// All five graded (none dropped), in input order.
		expect(grades.map((g) => g.memoryId)).toEqual(["a", "b", "c", "d", "e"]);
		expect(grades.every((g) => g.kind === "reinforce")).toBe(true);
	});
});

describe("grader parity: the cap changes timing, not output (AC-62d.2.2 / AC-8)", () => {
	it("grades are identical with a narrow cap and a wide (no-op) cap, in input order", async () => {
		// A detector with a fixed verdict so the grades are deterministic for the equality check.
		const detector: ContradictionDetector = { async detect(): Promise<number> { return 0.2; } };
		const signals = [signal("m1"), { ...signal("m2"), injected: false }, signal("m3")];

		const narrow = await gradeRecallBatch(signals, { detector, gradePool: new Semaphore(1) });
		const wide = await gradeRecallBatch(signals, { detector, gradePool: new Semaphore(100) });

		expect(narrow).toEqual(wide);
		// Order preserved; the never-injected m2 scored u = 0 (downweight) regardless of the cap.
		expect(narrow.map((g) => g.memoryId)).toEqual(["m1", "m2", "m3"]);
		expect(narrow[1]?.usefulness).toBe(0);
	});
});
