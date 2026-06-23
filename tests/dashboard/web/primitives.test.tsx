// @vitest-environment jsdom
/**
 * The {@link Button} primitive variant suite — the dashboard-polish `pollinate` restyle.
 *
 * The "Pollinate now" action uses `variant="pollinate"`. It is now a PROMINENT solid-purple button with
 * WHITE text (a deliberate exception to the near-black `--pollinate-on` token — the user explicitly wants
 * white), matching the honey primary's solidity but in violet. This suite mounts the real `Button` into
 * jsdom and asserts the inline style the variant applies — solid `var(--pollinate)` fill + `#FFFFFF` text
 * + a transparent border — so a regression to the old subtle/outline tint is caught.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Button } from "../../../src/dashboard/web/primitives.js";

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
});

describe("Button variant=pollinate — solid purple fill + white text", () => {
	it("renders a solid var(--pollinate) background, #FFFFFF text, and a transparent border", () => {
		act(() => {
			root = createRoot(container);
			root.render(
				<Button variant="pollinate" onClick={() => {}}>
					Pollinate now
				</Button>,
			);
		});
		const btn = container.querySelector("button") as HTMLButtonElement;
		expect(btn).not.toBeNull();
		// Solid purple FILL (not the old `--pollinate-subtle` tint).
		expect(btn.style.background).toBe("var(--pollinate)");
		// Explicit WHITE text (the user's deliberate choice — NOT the near-black `--pollinate-on`).
		// jsdom normalizes `#FFFFFF` to `rgb(255, 255, 255)`.
		const color = btn.style.color.replace(/\s/g, "").toLowerCase();
		expect(["#ffffff", "rgb(255,255,255)"]).toContain(color);
		// A transparent border (the solid fill carries the shape, like the honey primary).
		expect(btn.style.border).toContain("transparent");
		// It is NOT the old subtle/outline tint.
		expect(btn.style.background).not.toBe("var(--pollinate-subtle)");
	});

	it("stays the same solid fill after a hover-out (onLeave restores var(--pollinate), not the tint)", () => {
		act(() => {
			root = createRoot(container);
			root.render(
				<Button variant="pollinate" onClick={() => {}}>
					Pollinate now
				</Button>,
			);
		});
		const btn = container.querySelector("button") as HTMLButtonElement;
		// Hover in then out — the leave handler restores the variant background.
		act(() => btn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true })));
		act(() => btn.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true })));
		expect(btn.style.background).toBe("var(--pollinate)");
	});
});
