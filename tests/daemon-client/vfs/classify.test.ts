/**
 * PRD-015a a-AC-3 / index AC-2 — `classifyPath`.
 *
 * A valid goal/kpi SHAPE → its kind; a sessions/graph path → its kind; root `index.md` →
 * `index`; ANY malformed goal/kpi shape (or anything else) → `memory` (the generic
 * fallback). Pure — no IO. Path-shape tolerance: every accepted shape (mount-relative,
 * host-absolute, test-mount) reduces to the same remainder via the last `/memory/`.
 */

import { describe, expect, it } from "vitest";

import { classifyPath, toMountRelative } from "../../../src/daemon-client/vfs/index.js";

describe("a-AC-3 classifyPath: valid goal/kpi shape → its kind; malformed → memory", () => {
	it("a-AC-3 a valid goal shape → goal", () => {
		expect(classifyPath("goal/alice/opened/g-123.md")).toBe("goal");
		expect(classifyPath("goal/bob/in_progress/g-9.md")).toBe("goal");
		expect(classifyPath("goal/carol/closed/g-7.md")).toBe("goal");
	});

	it("a-AC-3 a valid kpi shape → kpi", () => {
		expect(classifyPath("kpi/g-123/k-1.md")).toBe("kpi");
	});

	it("a-AC-3 a MALFORMED goal shape → memory (the fallback), not a broken goal", () => {
		// unknown status token
		expect(classifyPath("goal/alice/paused/g-1.md")).toBe("memory");
		// missing .md
		expect(classifyPath("goal/alice/opened/g-1")).toBe("memory");
		// too few segments
		expect(classifyPath("goal/alice/opened")).toBe("memory");
		// empty owner
		expect(classifyPath("goal//opened/g-1.md")).toBe("memory");
		// too many segments
		expect(classifyPath("goal/alice/opened/extra/g-1.md")).toBe("memory");
	});

	it("a-AC-3 a MALFORMED kpi shape → memory", () => {
		expect(classifyPath("kpi/g-1")).toBe("memory"); // too few segments
		expect(classifyPath("kpi/g-1/k-1")).toBe("memory"); // missing .md
		expect(classifyPath("kpi//k-1.md")).toBe("memory"); // empty goal_id
	});

	it("a-AC-3 a sessions path → session (any depth)", () => {
		expect(classifyPath("sessions/2026-06-18/abc.md")).toBe("session");
		expect(classifyPath("sessions/anything")).toBe("session");
	});

	it("a-AC-3 a graph path → graph (incl. bare graph)", () => {
		expect(classifyPath("graph/index.md")).toBe("graph");
		expect(classifyPath("graph/find/foo")).toBe("graph");
		expect(classifyPath("graph")).toBe("graph");
	});

	it("a-AC-3 root index.md → index", () => {
		expect(classifyPath("index.md")).toBe("index");
	});

	it("a-AC-3 a plain memory file → memory", () => {
		expect(classifyPath("notes/today.md")).toBe("memory");
		expect(classifyPath("anything-at-all")).toBe("memory");
	});

	it("a-AC-3 classifies the same regardless of path shape (host-absolute, mount-relative)", () => {
		expect(classifyPath("/home/u/.honeycomb/memory/goal/alice/opened/g-1.md")).toBe("goal");
		expect(classifyPath("memory/goal/alice/opened/g-1.md")).toBe("goal");
		expect(classifyPath("/tmp/test-mount/memory/sessions/x.md")).toBe("session");
	});
});

describe("a-AC-3 toMountRelative reduces every accepted shape", () => {
	it("strips a host-absolute prefix by the LAST /memory/", () => {
		expect(toMountRelative("/home/u/.honeycomb/memory/notes/x.md")).toBe("notes/x.md");
	});
	it("strips a leading memory/ prefix", () => {
		expect(toMountRelative("memory/notes/x.md")).toBe("notes/x.md");
	});
	it("leaves an already-relative path intact", () => {
		expect(toMountRelative("goal/a/opened/g.md")).toBe("goal/a/opened/g.md");
	});
});
