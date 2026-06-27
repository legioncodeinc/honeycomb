/**
 * Color gate tests (PRD-064f UX): NO_COLOR / FORCE_COLOR / TTY resolution; identity
 * helpers when disabled so output stays plain and assertable.
 */

import { describe, expect, it } from "vitest";

import { colorEnabled, createColors } from "../../src/cli/colors.js";

describe("colorEnabled", () => {
	it("is on for a TTY with no overrides", () => {
		expect(colorEnabled({}, true)).toBe(true);
	});
	it("is off for a non-TTY", () => {
		expect(colorEnabled({}, false)).toBe(false);
	});
	it("NO_COLOR forces off even on a TTY", () => {
		expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
	});
	it("FORCE_COLOR forces on even without a TTY", () => {
		expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
	});
	it("FORCE_COLOR=0 does not force on", () => {
		expect(colorEnabled({ FORCE_COLOR: "0" }, false)).toBe(false);
	});
});

describe("createColors", () => {
	it("disabled colors are identity (plain text)", () => {
		const c = createColors({ env: {}, isTty: false });
		expect(c.enabled).toBe(false);
		expect(c.bold("x")).toBe("x");
		expect(c.amber("y")).toBe("y");
	});
	it("enabled colors wrap the text", () => {
		const c = createColors({ env: {}, isTty: true });
		expect(c.enabled).toBe(true);
		expect(c.bold("x")).not.toBe("x");
		expect(c.bold("x")).toContain("x");
	});
});
