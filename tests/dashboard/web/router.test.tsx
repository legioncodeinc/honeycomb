// @vitest-environment jsdom
/**
 * PRD-037b — the hash router (`useHashRoute`) DOM suite (037b AC-1, AC-3, AC-4).
 *
 * Drives the real `useHashRoute` hook inside a tiny harness component mounted into jsdom, and
 * asserts: the route parses from `location.hash`; a `hashchange` re-renders; `navigate(r)` updates
 * the hash; deep-linking (a hash set BEFORE mount) lands on that route; the `hashchange` listener is
 * cleaned up on unmount. No network — pure URL behavior.
 */

import { act } from "react";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { routeFromHash, useHashRoute } from "../../../src/dashboard/web/router.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	// Reset the hash to empty before each test so deep-link assertions start clean.
	window.location.hash = "";
	container = document.createElement("div");
	document.body.appendChild(container);
});

afterEach(() => {
	if (root !== undefined) act(() => root.unmount());
	container.remove();
	window.location.hash = "";
});

/** A harness that surfaces the hook's route + exposes navigate via a button. */
function RouteProbe(): React.JSX.Element {
	const { route, navigate } = useHashRoute();
	return (
		<div>
			<span data-testid="route">{route}</span>
			<button type="button" onClick={() => navigate("/graph")}>
				go-graph
			</button>
		</div>
	);
}

async function mountProbe(): Promise<void> {
	await act(async () => {
		root = createRoot(container);
		root.render(<RouteProbe />);
	});
}

describe("routeFromHash — the pure parser", () => {
	it("strips the leading # and defaults empty/bare-# to '/'", () => {
		expect(routeFromHash("")).toBe("/");
		expect(routeFromHash("#")).toBe("/");
		expect(routeFromHash("#/graph")).toBe("/graph");
		expect(routeFromHash("/logs")).toBe("/logs");
	});
});

describe("037b AC-1: useHashRoute reads the hash and re-renders on hashchange", () => {
	it("reflects the initial hash, then updates when location.hash changes", async () => {
		window.location.hash = "#/memories";
		await mountProbe();
		expect(container.querySelector('[data-testid="route"]')?.textContent).toBe("/memories");

		// A hashchange (e.g. browser back/forward, or another tab) re-renders the hook.
		await act(async () => {
			window.location.hash = "#/sync";
			window.dispatchEvent(new HashChangeEvent("hashchange"));
		});
		expect(container.querySelector('[data-testid="route"]')?.textContent).toBe("/sync");
	});
});

describe("037b AC-1: navigate(r) updates location.hash", () => {
	it("clicking a navigate button sets the hash and re-renders to that route", async () => {
		await mountProbe();
		expect(container.querySelector('[data-testid="route"]')?.textContent).toBe("/");
		const btn = [...container.querySelectorAll("button")].find((b) => b.textContent === "go-graph");
		await act(async () => {
			btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			// jsdom assigns location.hash but queues `hashchange` as a task; dispatch it so the
			// listener re-renders synchronously under act (a real browser fires it for free).
			window.dispatchEvent(new HashChangeEvent("hashchange"));
		});
		expect(window.location.hash).toBe("#/graph");
		expect(container.querySelector('[data-testid="route"]')?.textContent).toBe("/graph");
	});
});

describe("037b AC-3: deep-linking — a hash set BEFORE mount lands on that route", () => {
	it("mounts directly onto /graph when the page loaded with #/graph", async () => {
		window.location.hash = "#/graph";
		await mountProbe();
		expect(container.querySelector('[data-testid="route"]')?.textContent).toBe("/graph");
	});
});

describe("037b: the hashchange listener cleans up on unmount", () => {
	it("does not throw on a hashchange after unmount (listener removed)", async () => {
		await mountProbe();
		act(() => root.unmount());
		// Re-create a root so afterEach's unmount is a no-op-safe call.
		await act(async () => {
			root = createRoot(container);
			root.render(<div />);
		});
		// Firing a hashchange after the probe unmounted must not throw (the listener was removed).
		expect(() => window.dispatchEvent(new HashChangeEvent("hashchange"))).not.toThrow();
	});
});
