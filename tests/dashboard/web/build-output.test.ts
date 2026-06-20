/**
 * PRD-024 Wave 2 — the BUILD-OUTPUT production-clean assertion (AC-1).
 *
 * D-1 forbids the three things the UI kit's `index.html` did: CDN React (`unpkg`), in-browser
 * Babel (`@babel/standalone`), and `type="text/babel"`. This suite proves the produced
 * dashboard artifacts contain NONE of them:
 *
 *   - The index SHELL (`renderShell()`, always available, no build needed) references only the
 *     same-origin bundle + DS CSS — no CDN/Babel/text-babel, no token/secret.
 *   - The esbuild BUNDLE (`daemon/dashboard-app.js`), WHEN it has been built, contains no
 *     `unpkg`/`@babel/standalone` reference (React is bundled IN, JSX compiled at build time)
 *     and is a real bundle (it references React internals). When the bundle is absent (a fresh
 *     checkout that has not run `npm run build`), the bundle assertion is skipped — the shell
 *     assertion always runs, and `dashboard-logs-live` + the host suite cover the served path.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { renderShell } from "../../../src/daemon/runtime/dashboard/host.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BUNDLE_PATH = `${REPO_ROOT}daemon/dashboard-app.js`;

/** The forbidden CDN/Babel markers (D-1). */
const FORBIDDEN = ["unpkg", "@babel/standalone", "babel.min.js", 'type="text/babel"'];

describe("PRD-024 AC-1: the index shell is production-clean (no CDN React / Babel / text-babel)", () => {
	const shell = renderShell();

	it("references the bundled app + DS CSS, not a CDN", () => {
		expect(shell).toContain('<div id="root"');
		expect(shell).toContain("/dashboard/app.js");
		expect(shell).toContain("/dashboard/styles.css");
	});

	it("contains NONE of the D-1-forbidden markers", () => {
		for (const marker of FORBIDDEN) {
			expect(shell, `shell must not contain ${marker}`).not.toContain(marker);
		}
	});

	it("carries no token/secret", () => {
		for (const needle of ["token", "secret", "bearer", "authorization", "password"]) {
			expect(shell.toLowerCase()).not.toContain(needle);
		}
	});
});

describe("PRD-024 AC-1: the esbuild bundle is production-clean (when built)", () => {
	const built = existsSync(BUNDLE_PATH);

	it.skipIf(!built)("the produced daemon/dashboard-app.js has no CDN/Babel reference and bundles React in", () => {
		const js = readFileSync(BUNDLE_PATH, "utf-8");
		for (const marker of FORBIDDEN) {
			expect(js, `bundle must not contain ${marker}`).not.toContain(marker);
		}
		// It is a REAL bundle: React internals are compiled in (no bare `from "react"` import left).
		expect(js).not.toMatch(/from\s*["']react["']/);
		expect(js.length).toBeGreaterThan(10_000);
	});
});
