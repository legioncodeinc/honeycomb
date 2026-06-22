// @vitest-environment jsdom
/**
 * PRD-037c — the shared PageFrame + usePoll suite (037c AC-1 max-width, AC-4 hydration recipe).
 *
 * Asserts: PageFrame renders an optional eyebrow + a title + a content body capped at the preserved
 * readable max-width (≈1180px), carrying no chrome of its own; and usePoll fetches on mount, polls on
 * the interval, and STOPS on unmount (the cleanup recipe a page reuses for /api/logs, recall, graph…).
 */

import { act } from "react";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PAGE_MAX_WIDTH, PageFrame, usePoll } from "../../../src/dashboard/web/page-frame.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
});

afterEach(() => {
	if (root !== undefined) act(() => root.unmount());
	container.remove();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("037c AC-1: PageFrame renders eyebrow + title + max-width-capped body, no chrome", () => {
	it("renders the title + eyebrow + content and caps the content at the readable max-width", () => {
		act(() => {
			root = createRoot(container);
			root.render(
				<PageFrame title="Graph" eyebrow="codebase">
					<div data-testid="page-body">graph content</div>
				</PageFrame>,
			);
		});
		const text = container.textContent ?? "";
		expect(text).toContain("Graph");
		expect(text).toContain("codebase");
		expect(container.querySelector('[data-testid="page-body"]')?.textContent).toContain("graph content");
		// The frame caps content at the preserved 1180px readable width (D-8).
		expect(PAGE_MAX_WIDTH).toBe(1180);
		const capped = [...container.querySelectorAll("div")].some((el) => el.style.maxWidth === `${PAGE_MAX_WIDTH}px`);
		expect(capped, "a content wrapper is capped at PAGE_MAX_WIDTH").toBe(true);
	});

	it("renders without an eyebrow when none is given", () => {
		act(() => {
			root = createRoot(container);
			root.render(<PageFrame title="Logs">body</PageFrame>);
		});
		expect(container.textContent ?? "").toContain("Logs");
	});
});

describe("037c AC-4: usePoll fetches on mount, polls on the interval, and stops on unmount", () => {
	it("calls fn once on mount, again each interval, and not after unmount", () => {
		vi.useFakeTimers();
		const fn = vi.fn();
		function Poller(): React.JSX.Element {
			usePoll(fn, 1000);
			return <div />;
		}
		act(() => {
			root = createRoot(container);
			root.render(<Poller />);
		});
		// Fetch-on-mount: one immediate call.
		expect(fn).toHaveBeenCalledTimes(1);
		// Two interval ticks → two more calls.
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(fn).toHaveBeenCalledTimes(2);
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(fn).toHaveBeenCalledTimes(3);
		// Unmount → the interval is cleared; no further calls.
		act(() => root.unmount());
		act(() => {
			vi.advanceTimersByTime(5000);
		});
		expect(fn).toHaveBeenCalledTimes(3);
		// Re-create a root so afterEach's unmount is safe.
		act(() => {
			root = createRoot(container);
			root.render(<div />);
		});
	});
});
