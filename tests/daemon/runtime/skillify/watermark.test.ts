/**
 * PRD-016b watermark — proves b-AC-2 / FR-8 / FR-9 (named, unskipped).
 *
 * The watermark advances to the OLDEST mined session date after EVERY run (KEEP,
 * MERGE, or SKIP), so older missed sessions are re-seen. On-disk, per project, rooted
 * at an INJECTED temp dir (no real home writes).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createWatermarkStore } from "../../../../src/daemon/runtime/skillify/index.js";

function tempBase(): string {
	return mkdtempSync(join(tmpdir(), "skillify-wm-"));
}

describe("PRD-016b watermark", () => {
	// ── b-AC-2 ──────────────────────────────────────────────────────────────────
	it("b-AC-2 advances the watermark to the OLDEST mined session date so older missed sessions are re-seen", () => {
		const store = createWatermarkStore(tempBase());
		const project = "proj-a";

		// First run mines three sessions; the watermark lands on the OLDEST.
		const dates = ["2026-06-10T08:00:00Z", "2026-06-08T09:00:00Z", "2026-06-12T10:00:00Z"];
		const after = store.advance(project, dates);
		expect(after).toBe("2026-06-08T09:00:00Z"); // the oldest, NOT the newest.
		expect(store.read(project)).toBe("2026-06-08T09:00:00Z");
	});

	// ── b-AC-2 (monotonic toward oldest — never moves later) ──────────────────────
	it("b-AC-2 a later run with an even older straggler moves the watermark EARLIER, never later", () => {
		const store = createWatermarkStore(tempBase());
		const project = "proj-b";

		store.advance(project, ["2026-06-10T00:00:00Z"]);
		expect(store.read(project)).toBe("2026-06-10T00:00:00Z");

		// A later run sees a NEWER batch — the watermark must NOT move forward.
		const stayedBack = store.advance(project, ["2026-06-20T00:00:00Z"]);
		expect(stayedBack).toBe("2026-06-10T00:00:00Z"); // unchanged (min wins).

		// A later run sees an OLDER straggler — the watermark moves EARLIER.
		const movedBack = store.advance(project, ["2026-06-01T00:00:00Z"]);
		expect(movedBack).toBe("2026-06-01T00:00:00Z");
	});

	// ── FR-9 (a SKIP still advances) ──────────────────────────────────────────────
	it("FR-9 advancing on a SKIP batch (no skill written) still moves the watermark to the oldest", () => {
		const store = createWatermarkStore(tempBase());
		const project = "proj-c";
		// A SKIP run still mined sessions — the watermark advances to their oldest.
		const after = store.advance(project, ["2026-05-05T00:00:00Z", "2026-05-03T00:00:00Z"]);
		expect(after).toBe("2026-05-03T00:00:00Z");
	});

	// ── empty batch leaves the watermark unchanged ────────────────────────────────
	it("a run with no mined sessions leaves the watermark unchanged", () => {
		const store = createWatermarkStore(tempBase());
		const project = "proj-d";
		store.advance(project, ["2026-04-01T00:00:00Z"]);
		const after = store.advance(project, []); // nothing mined
		expect(after).toBe("2026-04-01T00:00:00Z");
	});

	// ── per-project isolation + path-traversal containment ────────────────────────
	it("watermarks are isolated per project and a crafted projectKey cannot traverse out of the base dir", () => {
		const base = tempBase();
		const store = createWatermarkStore(base);
		store.advance("alpha", ["2026-06-01T00:00:00Z"]);
		store.advance("beta", ["2026-06-09T00:00:00Z"]);
		expect(store.read("alpha")).toBe("2026-06-01T00:00:00Z");
		expect(store.read("beta")).toBe("2026-06-09T00:00:00Z");

		// A traversal-shaped key is sanitized to a single segment (no escape, no crash).
		const evil = "../../etc/passwd";
		const after = store.advance(evil, ["2026-06-02T00:00:00Z"]);
		expect(after).toBe("2026-06-02T00:00:00Z");
		expect(store.read(evil)).toBe("2026-06-02T00:00:00Z");
	});
});
