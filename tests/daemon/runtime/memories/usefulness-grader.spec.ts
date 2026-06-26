/**
 * PRD-058e, the usefulness grader (`u_k`) suite.
 *
 * Verification posture: the grader is pure orchestration over the injectable
 * {@link ContradictionDetector} seam, driven with controlled outcome signals + a fake
 * detector, deterministic, no I/O, no 058b dependency.
 *
 * Acceptance criteria → tests:
 *   58e.1.3 contradicted/ignored same turn → u_k → 0 (downweight), no inflation.
 * Plus: injected-and-clean → u≈1 (reinforce), partial weight u∈[0,1], never-injected → u→0,
 * the 058b seam default (no contradiction), and the detector-throw fail-soft.
 */

import { describe, expect, it } from "vitest";

import {
	gradeRecallBatch,
	gradeUsefulness,
	noContradictionDetector,
	USEFULNESS_CONFIRMED,
	USEFULNESS_REJECTED,
	type ContradictionDetector,
	type RecallOutcomeSignals,
} from "../../../../src/daemon/runtime/memories/usefulness-grader.js";

/** A base injected-and-kept outcome (no ignore, with downstream text). */
function injectedKept(id: string, outcomeText = "fine"): RecallOutcomeSignals {
	return { memoryId: id, injectedText: `mem ${id}`, injected: true, ignored: false, outcomeText };
}

/** A fake detector returning a fixed contradiction probability. */
function fixedDetector(p: number): ContradictionDetector {
	return { async detect() { return p; } };
}

/** A detector that records whether it was invoked (to prove the short-circuit paths never call it). */
function recordingDetector(): { detector: ContradictionDetector; called: () => boolean } {
	let invoked = false;
	return {
		detector: { async detect() { invoked = true; return 1; } },
		called: () => invoked,
	};
}

describe("PRD-058e gradeUsefulness", () => {
	it("injected + not contradicted → u ≈ 1, kind reinforce (the documented default)", async () => {
		const grade = await gradeUsefulness(injectedKept("m1"), { detector: noContradictionDetector });
		expect(grade.usefulness).toBe(USEFULNESS_CONFIRMED);
		expect(grade.kind).toBe("reinforce");
		expect(grade.memoryId).toBe("m1");
	});

	it("58e.1.3 contradicted in the same turn → u → 0, kind downweight (no inflation)", async () => {
		const grade = await gradeUsefulness(injectedKept("m2"), { detector: fixedDetector(1) });
		expect(grade.usefulness).toBe(USEFULNESS_REJECTED);
		expect(grade.kind).toBe("downweight");
	});

	it("58e.1.3 explicitly ignored → u → 0, downweight AND the detector is NEVER consulted (short-circuit)", async () => {
		const { detector, called } = recordingDetector();
		const signals: RecallOutcomeSignals = { ...injectedKept("m3"), ignored: true };
		const grade = await gradeUsefulness(signals, { detector });
		expect(grade.usefulness).toBe(USEFULNESS_REJECTED);
		expect(grade.kind).toBe("downweight");
		expect(called()).toBe(false); // the ignored path must short-circuit BEFORE any detect() call.
	});

	it("never injected (surfaced-but-dropped) → u → 0, downweight AND the detector is NEVER consulted", async () => {
		const { detector, called } = recordingDetector();
		const signals: RecallOutcomeSignals = { ...injectedKept("m4"), injected: false };
		const grade = await gradeUsefulness(signals, { detector });
		expect(grade.usefulness).toBe(USEFULNESS_REJECTED);
		expect(grade.kind).toBe("downweight");
		expect(called()).toBe(false); // a never-injected memory must not reach the detector.
	});

	it("partial contradiction → partial weight u = 1 − P, in [0,1]", async () => {
		const grade = await gradeUsefulness(injectedKept("m5"), { detector: fixedDetector(0.3) });
		expect(grade.usefulness).toBeCloseTo(0.7, 12);
		expect(grade.kind).toBe("reinforce"); // 0.7 > 0.5 threshold → still reinforces (partially).
	});

	it("a strong-but-not-total contradiction (P=0.8) → u=0.2, kind downweight", async () => {
		const grade = await gradeUsefulness(injectedKept("m6"), { detector: fixedDetector(0.8) });
		expect(grade.usefulness).toBeCloseTo(0.2, 12);
		expect(grade.kind).toBe("downweight"); // 0.2 ≤ 0.5 → downweight.
	});

	it("the default detector (058b not built) reports no contradiction → confirmed useful", async () => {
		const grade = await gradeUsefulness(injectedKept("m7")); // no deps → noContradictionDetector.
		expect(grade.usefulness).toBe(USEFULNESS_CONFIRMED);
		expect(grade.kind).toBe("reinforce");
	});

	it("a detector THROW fails soft to no-contradiction (never wrongly punishes the memory)", async () => {
		const throwing: ContradictionDetector = { async detect() { throw new Error("nli down"); } };
		const grade = await gradeUsefulness(injectedKept("m8"), { detector: throwing });
		expect(grade.usefulness).toBe(USEFULNESS_CONFIRMED);
		expect(grade.kind).toBe("reinforce");
	});

	it("a detector that NEVER resolves degrades to no-contradiction via the bounded timeout (no hang)", async () => {
		// A hung NLI judge must not wedge the grader (nor the Promise.all batch). With a tiny timeout the
		// race resolves to the fail-soft "no contradiction" → confirmed useful, and the test returns
		// promptly rather than hanging forever.
		const hung: ContradictionDetector = { detect: () => new Promise<number>(() => {}) };
		const grade = await gradeUsefulness(injectedKept("m9"), { detector: hung, detectTimeoutMs: 5 });
		expect(grade.usefulness).toBe(USEFULNESS_CONFIRMED);
		expect(grade.kind).toBe("reinforce");
	});

	it("gradeRecallBatch does NOT hang when one memory's detector never resolves (bounded per-detect)", async () => {
		const hung: ContradictionDetector = { detect: () => new Promise<number>(() => {}) };
		const grades = await gradeRecallBatch([injectedKept("a"), injectedKept("b")], { detector: hung, detectTimeoutMs: 5 });
		expect(grades.map((g) => g.memoryId)).toEqual(["a", "b"]);
		expect(grades.every((g) => g.kind === "reinforce")).toBe(true); // all degraded to confirmed useful.
	});
});

describe("PRD-058e gradeRecallBatch", () => {
	it("grades a batch in order, fail-soft per memory", async () => {
		const signals = [injectedKept("a"), { ...injectedKept("b"), ignored: true }, injectedKept("c")];
		const grades = await gradeRecallBatch(signals, { detector: noContradictionDetector });
		expect(grades.map((g) => g.memoryId)).toEqual(["a", "b", "c"]);
		expect(grades[0]!.kind).toBe("reinforce");
		expect(grades[1]!.kind).toBe("downweight");
		expect(grades[2]!.kind).toBe("reinforce");
	});
});
