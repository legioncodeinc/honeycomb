// @vitest-environment jsdom
/**
 * PRD-024 Wave-3 post-merge UX fix — the {@link SessionsPanel} pagination suite.
 *
 * The live wire fetches up to ~50 captured sessions, but the panel must render at most 5 rows
 * per page (no giant scrolling list). This suite mounts the REAL `SessionsPanel` into jsdom and
 * asserts:
 *   - > PAGE_SIZE sessions → only 5 rows render, the `"{start}–{end} of {total}"` label + the
 *     next-page control appear, and clicking `›` advances to the next 5 (and `‹` goes back);
 *   - the eyebrow always shows the TOTAL captured count;
 *   - ≤ PAGE_SIZE sessions → NO page controls, every row renders;
 *   - 0 sessions → the unchanged empty state, no controls.
 *
 * Only the component is exercised (no fetch, no wire); the app-level render suite in
 * `app.test.tsx` still covers the end-to-end data path.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionsPanel } from "../../../src/dashboard/web/panels.js";
import type { SessionRowWire } from "../../../src/dashboard/web/wire.js";

// React 18's act() environment flag — silences the "not wrapped in act(...)" warning.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Build `n` representative session rows (`s000`, `s001`, …) so each id is uniquely assertable. */
function makeSessions(n: number): SessionRowWire[] {
	return Array.from({ length: n }, (_, i) => ({
		sessionId: `s${String(i).padStart(3, "0")}`,
		project: `proj-${i}`,
		startedAt: `1${i}:00`,
		eventCount: i,
		status: "captured",
	}));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

/** Mount the panel with the given sessions, flushing the initial render. */
function mount(sessions: readonly SessionRowWire[]): void {
	act(() => {
		root = createRoot(container);
		root.render(<SessionsPanel sessions={sessions} />);
	});
}

/** The rendered session-id cells currently in the DOM (the first cell of each row, mono honey). */
function visibleIds(): string[] {
	return [...container.querySelectorAll("span")]
		.map((el) => el.textContent ?? "")
		.filter((t) => /^s\d{3}$/.test(t));
}

/** Find a page-control button by its glyph label. */
function pageButton(glyph: "‹" | "›"): HTMLButtonElement | undefined {
	return [...container.querySelectorAll("button")].find((b) => b.textContent === glyph);
}

describe("SessionsPanel pagination (>5 sessions → 5/page + controls)", () => {
	it("renders only the first 5 rows, the range label, and a next-page control", () => {
		mount(makeSessions(12));

		const ids = visibleIds();
		expect(ids).toHaveLength(5);
		expect(ids).toEqual(["s000", "s001", "s002", "s003", "s004"]);
		// The total count stays in the eyebrow; the range label shows the visible window.
		expect(container.textContent ?? "").toContain("12 captured");
		expect(container.textContent ?? "").toContain("1–5 of 12");
		// Both controls exist; prev is disabled on the first page, next is enabled.
		expect(pageButton("‹")?.disabled).toBe(true);
		expect(pageButton("›")?.disabled).toBe(false);
	});

	it("clicking › advances to the next 5 rows (and ‹ returns)", () => {
		mount(makeSessions(12));

		act(() => {
			pageButton("›")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(visibleIds()).toEqual(["s005", "s006", "s007", "s008", "s009"]);
		expect(container.textContent ?? "").toContain("6–10 of 12");
		expect(pageButton("‹")?.disabled).toBe(false);

		// Last page (3 of 3) holds the remaining 2 rows; next is disabled there.
		act(() => {
			pageButton("›")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(visibleIds()).toEqual(["s010", "s011"]);
		expect(container.textContent ?? "").toContain("11–12 of 12");
		expect(pageButton("›")?.disabled).toBe(true);

		// Back one page restores the middle window.
		act(() => {
			pageButton("‹")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(visibleIds()).toEqual(["s005", "s006", "s007", "s008", "s009"]);
	});
});

describe("SessionsPanel without pagination (≤5 sessions → no controls)", () => {
	it("renders every row and shows no page controls when sessions ≤ 5", () => {
		mount(makeSessions(3));
		expect(visibleIds()).toEqual(["s000", "s001", "s002"]);
		expect(container.textContent ?? "").toContain("3 captured");
		// No controls, no range label.
		expect(pageButton("‹")).toBeUndefined();
		expect(pageButton("›")).toBeUndefined();
		expect(container.textContent ?? "").not.toContain(" of 3");
	});

	it("renders all 5 rows with no controls at exactly the page boundary", () => {
		mount(makeSessions(5));
		expect(visibleIds()).toHaveLength(5);
		expect(pageButton("›")).toBeUndefined();
	});
});

describe("SessionsPanel empty state (0 turns → unchanged empty row)", () => {
	it("shows the empty state and no controls", () => {
		mount([]);
		// PRD-035a: the empty captured-turns panel reads "No turns captured yet."
		expect(container.textContent ?? "").toContain("No turns captured yet.");
		expect(container.textContent ?? "").toContain("0 captured");
		expect(pageButton("‹")).toBeUndefined();
		expect(pageButton("›")).toBeUndefined();
	});
});
