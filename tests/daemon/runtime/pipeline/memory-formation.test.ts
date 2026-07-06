/**
 * Unit suite for the in-process memory-formation tracker — the `/health` "is this daemon forming
 * memories?" signal. Proves it counts ONLY committed outcomes, records the last-write detail, and is
 * fail-soft/monotonic.
 */

import { describe, expect, it } from "vitest";

import { createMemoryFormationTracker } from "../../../../src/daemon/runtime/pipeline/memory-formation.js";

describe("memory-formation tracker", () => {
	it("starts empty (the fresh-daemon 'nothing formed yet' snapshot)", () => {
		const tracker = createMemoryFormationTracker(() => 0);
		expect(tracker.snapshot()).toEqual({ committedSinceBoot: 0 });
	});

	it("counts committed actions (inserted / version_bumped / deduped) with a memory id", () => {
		let t = 1_000;
		const tracker = createMemoryFormationTracker(() => t);
		tracker.record({ action: "inserted", memoryId: "m1" });
		t = 2_000;
		tracker.record({ action: "version_bumped", memoryId: "m2" });
		t = 3_000;
		tracker.record({ action: "deduped", memoryId: "m1" });

		const snap = tracker.snapshot();
		expect(snap.committedSinceBoot).toBe(3);
		expect(snap.lastAction).toBe("deduped");
		expect(snap.lastCommittedAt).toBe(new Date(3_000).toISOString());
	});

	it("ignores non-committing outcomes (skipped/flagged, or a committed action with no id)", () => {
		const tracker = createMemoryFormationTracker(() => 0);
		tracker.record({ action: "skipped", reason: "below_confidence" } as { action: string });
		tracker.record({ action: "flagged", memoryId: "" });
		tracker.record({ action: "inserted" }); // committed action but NO id → formed nothing
		tracker.record({ action: "inserted", memoryId: "" }); // empty id → nothing
		expect(tracker.snapshot()).toEqual({ committedSinceBoot: 0 });
	});

	it("is monotonic across many records", () => {
		const tracker = createMemoryFormationTracker(() => 0);
		for (let i = 0; i < 50; i++) tracker.record({ action: "inserted", memoryId: `m${i}` });
		expect(tracker.snapshot().committedSinceBoot).toBe(50);
	});
});
