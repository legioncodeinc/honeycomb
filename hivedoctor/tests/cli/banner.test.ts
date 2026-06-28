/**
 * Banner + menu rendering tests (PRD-064f AC-064f.1).
 */

import { describe, expect, it } from "vitest";

import { renderBanner, renderMenu, renderBannerWithMenu } from "../../src/cli/banner.js";
import { createColors } from "../../src/cli/colors.js";

const plain = createColors({ env: {}, isTty: false });

describe("renderBanner", () => {
	it("contains both wordmarks, the collaboration line, and the product name", () => {
		const b = renderBanner(plain);
		expect(b).toContain("LEGION CODE INC.");
		expect(b).toContain("ACTIVELOOP");
		expect(b).toContain("A collaboration between Legion Code Inc. x Activeloop");
		expect(b).toContain("deeplake.ai");
		expect(b).toContain("HiveDoctor");
	});

	it("includes the single-sourced version", () => {
		// In tests __HIVEDOCTOR_VERSION__ is undefined, so version falls to the dev sentinel.
		expect(renderBanner(plain)).toContain("v0.0.0-dev");
	});
});

describe("renderMenu", () => {
	it("lists Usage + Commands + every command", () => {
		const m = renderMenu(plain);
		expect(m).toContain("Usage:");
		expect(m).toContain("Commands:");
		expect(m).toContain("status");
		expect(m).toContain("self-update");
		expect(m).not.toContain("clear-credentials");
	});
});

describe("renderBannerWithMenu", () => {
	it("concatenates the banner and the menu", () => {
		const full = renderBannerWithMenu(plain);
		expect(full).toContain("HiveDoctor");
		expect(full).toContain("Commands:");
	});

	it("color mode wraps in ANSI escapes; plain mode does not", () => {
		const ESC = String.fromCharCode(27);
		const colored = renderBannerWithMenu(createColors({ env: {}, isTty: true }));
		expect(colored.includes(ESC)).toBe(true);
		expect(renderBannerWithMenu(plain).includes(ESC)).toBe(false);
	});
});
