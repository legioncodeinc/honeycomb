/**
 * Unit suite for the in-process memory-formation tracker — the `/health` "is this daemon forming
 * memories?" signal. Proves it counts ONLY committed outcomes, records the last-write detail, and is
 * fail-soft/monotonic. ISS-005 extends it with the swallowed-extraction-error counter
 * (`extractionErrorsSinceBoot`) + the logger decorator that feeds it.
 */

import { describe, expect, it } from "vitest";

import {
	createMemoryFormationTracker,
	withExtractionErrorTracking,
} from "../../../../src/daemon/runtime/pipeline/memory-formation.js";

describe("memory-formation tracker", () => {
	it("starts empty (the fresh-daemon 'nothing formed yet' snapshot)", () => {
		const tracker = createMemoryFormationTracker(() => 0);
		expect(tracker.snapshot()).toEqual({ committedSinceBoot: 0, extractionErrorsSinceBoot: 0 });
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
		expect(tracker.snapshot()).toEqual({ committedSinceBoot: 0, extractionErrorsSinceBoot: 0 });
	});

	it("is monotonic across many records", () => {
		const tracker = createMemoryFormationTracker(() => 0);
		for (let i = 0; i < 50; i++) tracker.record({ action: "inserted", memoryId: `m${i}` });
		expect(tracker.snapshot().committedSinceBoot).toBe(50);
	});
});

// ── ISS-005: extraction failure visibility — the swallowed model_error counter ──────────────────

describe("ISS-005 extractionErrorsSinceBoot counts swallowed extraction model errors", () => {
	it("recordExtractionError increments the count + keeps the last reason and time", () => {
		let t = 1_000;
		const tracker = createMemoryFormationTracker(() => t);
		tracker.recordExtractionError("portkey transport: gateway returned status 401");
		t = 2_000;
		tracker.recordExtractionError("routing exhausted");

		const snap = tracker.snapshot();
		expect(snap.extractionErrorsSinceBoot).toBe(2);
		expect(snap.lastExtractionError).toBe("routing exhausted");
		expect(snap.lastExtractionErrorAt).toBe(new Date(2_000).toISOString());
		// The commit signal is untouched — the two counters are independent.
		expect(snap.committedSinceBoot).toBe(0);
	});

	it("caps the stored reason (a short diagnostic, never an unbounded dump)", () => {
		const tracker = createMemoryFormationTracker(() => 0);
		tracker.recordExtractionError("x".repeat(10_000));
		expect(tracker.snapshot().lastExtractionError?.length).toBeLessThanOrEqual(200);
	});

	it("withExtractionErrorTracking counts extraction.model_error events and forwards ALL events", () => {
		const tracker = createMemoryFormationTracker(() => 0);
		const forwarded: { name: string; fields?: Record<string, unknown> }[] = [];
		const logger = withExtractionErrorTracking(tracker, {
			event: (name, fields) => forwarded.push({ name, ...(fields !== undefined ? { fields } : {}) }),
		});

		logger.event("extraction.model_error", { reason: "routing exhausted for memory_extraction" });
		logger.event("extraction.result", { inputChars: 10, facts: 0, entities: 0, dropped: 0 });
		logger.event("extraction.model_error", { reason: 42 }); // non-string reason → "unknown"

		expect(tracker.snapshot().extractionErrorsSinceBoot).toBe(2);
		expect(tracker.snapshot().lastExtractionError).toBe("unknown");
		expect(forwarded.map((e) => e.name)).toEqual([
			"extraction.model_error",
			"extraction.result",
			"extraction.model_error",
		]);
	});

	it("works with NO inner logger (assembly without a worker logger) and never throws", () => {
		const tracker = createMemoryFormationTracker(() => 0);
		const logger = withExtractionErrorTracking(tracker);
		expect(() => {
			logger.event("extraction.model_error", { reason: "boom" });
			logger.event("extraction.model_error"); // no fields at all
		}).not.toThrow();
		expect(tracker.snapshot().extractionErrorsSinceBoot).toBe(2);
	});
});
