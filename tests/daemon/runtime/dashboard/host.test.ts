/**
 * PRD-024 Wave 2 daemon-side dashboard HOST suite — `mountDashboardHost` serves the bundled
 * brand UI kit (AC-1 production-clean).
 *
 * The host no longer server-renders the 020b `ViewBlock` tree. `GET /dashboard` now returns the
 * INDEX SHELL of a real React app (the faithful re-creation of `assets/ui_kits/dashboard/`),
 * and three static-asset routes serve the esbuild bundle + the design-system CSS + the logo.
 * This suite proves:
 *   - BEFORE the attach the route is unmounted (404 scaffold).
 *   - AFTER the attach `GET /dashboard` returns an HTML shell with `<div id="root">`, a `<link>`
 *     to the DS CSS, and a `<script>` to the bundled app — and is PRODUCTION-CLEAN (no
 *     `unpkg`/CDN React, no `@babel/standalone`, no `type="text/babel"`) and carries no secret.
 *   - The three asset routes serve the bundle JS, the concatenated CSS, and the logo.
 *   - A not-yet-built bundle 404s the app route (never 500s the page).
 *
 * Team/hybrid GATING (the host is mounted LOCAL-MODE ONLY) is enforced by `assembleSeams`
 * (security F-1) and proven in `tests/daemon/runtime/assemble.test.ts`; this suite drives
 * `mountDashboardHost` directly (the attach mechanics).
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import {
	DASHBOARD_APP_PATH,
	DASHBOARD_CSS_PATH,
	DASHBOARD_LOGO_PATH,
	mountDashboardHost,
} from "../../../../src/daemon/runtime/dashboard/host.js";
import { createWebAssets, type WebAssets } from "../../../../src/daemon/runtime/dashboard/web-assets.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

/** A trivial responder — the shell no longer reads storage, so any responder works. */
function makeDaemon() {
	const fake = new FakeDeepLakeTransport((_req: TransportRequest) => []);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
	return { daemon, storage };
}

/** A fixture asset reader so the host suite never depends on the real tree / a built bundle. */
function fixtureAssets(opts: { appJs?: string | null } = {}): WebAssets {
	const appJs = opts.appJs === undefined ? "/* stub bundle */ console.log('app');" : opts.appJs;
	return {
		css: () => ({ body: ":root{--honey:#F7A823}", contentType: "text/css; charset=utf-8" }),
		logo: () => ({ body: "<svg/>", contentType: "image/svg+xml" }),
		appJs: () => (appJs === null ? null : { body: appJs, contentType: "text/javascript; charset=utf-8" }),
		// A stub font reader honouring the same allow-list shape: a known woff2 → bytes, else null.
		font: (name: string) =>
			name === "JetBrainsMono-Regular.woff2"
				? { body: new Uint8Array([0x77, 0x4f, 0x46, 0x32]).buffer, contentType: "font/woff2" }
				: null,
	};
}

describe("PRD-024 mountDashboardHost serves the bundled brand dashboard", () => {
	it("BEFORE attach: GET /dashboard is not served", async () => {
		const { daemon } = makeDaemon();
		const res = await daemon.app.request("/dashboard");
		expect(res.status).toBe(404);
	});

	it("AC-1: AFTER attach: GET /dashboard returns the index shell with #root + DS CSS link + app script", async () => {
		const { daemon, storage } = makeDaemon();
		mountDashboardHost(daemon, { storage, assets: fixtureAssets() });
		const res = await daemon.app.request("/dashboard");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();

		// A real, standalone shell with the mount point + the asset references.
		expect(html).toContain("<!doctype html>");
		expect(html).toContain('<div id="root"');
		expect(html).toContain(`href="${DASHBOARD_CSS_PATH}"`);
		expect(html).toContain(`src="${DASHBOARD_APP_PATH}"`);
		// The layout CSS from the kit is inlined (the grid classes).
		expect(html).toContain(".grid2");
		expect(html).toContain(".kpirow");
		expect(html).toContain(".mem-enter");
	});

	it("AC-1: the shell is PRODUCTION-CLEAN — no unpkg/CDN React, no Babel, no text/babel", async () => {
		const { daemon, storage } = makeDaemon();
		mountDashboardHost(daemon, { storage, assets: fixtureAssets() });
		const html = await (await daemon.app.request("/dashboard")).text();
		expect(html).not.toContain("unpkg");
		expect(html).not.toContain("@babel/standalone");
		expect(html).not.toContain("babel.min.js");
		expect(html).not.toContain('type="text/babel"');
	});

	it("D-4: the shell carries NO token/secret/credential", async () => {
		const { daemon, storage } = makeDaemon();
		mountDashboardHost(daemon, { storage, assets: fixtureAssets() });
		const html = await (await daemon.app.request("/dashboard")).text();
		for (const needle of ["token", "secret", "bearer", "authorization", "api_key", "apikey", "password"]) {
			expect(html.toLowerCase()).not.toContain(needle);
		}
	});

	it("AC-1: GET /dashboard/app.js serves the bundled app with a JS content-type", async () => {
		const { daemon, storage } = makeDaemon();
		mountDashboardHost(daemon, { storage, assets: fixtureAssets() });
		const res = await daemon.app.request(DASHBOARD_APP_PATH);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("javascript");
		expect(await res.text()).toContain("stub bundle");
	});

	it("AC-1: GET /dashboard/styles.css serves the DS CSS; the logo serves SVG", async () => {
		const { daemon, storage } = makeDaemon();
		mountDashboardHost(daemon, { storage, assets: fixtureAssets() });
		const css = await daemon.app.request(DASHBOARD_CSS_PATH);
		expect(css.status).toBe(200);
		expect(css.headers.get("content-type")).toContain("text/css");
		expect(await css.text()).toContain("--honey");

		const logo = await daemon.app.request(DASHBOARD_LOGO_PATH);
		expect(logo.status).toBe(200);
		expect(logo.headers.get("content-type")).toContain("image/svg");
	});

	it("a not-yet-built bundle 404s the app route (never 500s the page)", async () => {
		const { daemon, storage } = makeDaemon();
		mountDashboardHost(daemon, { storage, assets: fixtureAssets({ appJs: null }) });
		const res = await daemon.app.request(DASHBOARD_APP_PATH);
		expect(res.status).toBe(404);
		// The shell still serves fine even when the bundle is missing.
		expect((await daemon.app.request("/dashboard")).status).toBe(200);
	});

	// PRD-024 Wave 3 — the brand fonts. The live page showed 404s for `../logos/fonts/*` because
	// the host only served the bundle/CSS/mark. The host now serves `/dashboard/fonts/<file>` and
	// the served CSS's `@font-face` URLs are rewritten to that route.
	it("Wave-3: GET /dashboard/fonts/<file> serves the allow-listed font with a font/* content-type + immutable cache", async () => {
		const { daemon, storage } = makeDaemon();
		mountDashboardHost(daemon, { storage, assets: fixtureAssets() });
		const res = await daemon.app.request("/dashboard/fonts/JetBrainsMono-Regular.woff2");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("font/woff2");
		// Long-lived immutable cache — the bytes are content-stable.
		expect(res.headers.get("cache-control")).toContain("immutable");
		const body = new Uint8Array(await res.arrayBuffer());
		expect(body.length).toBeGreaterThan(0);
	});

	it("Wave-3: an unknown / traversal font name 404s (the fixed allow-list rejects it)", async () => {
		const { daemon, storage } = makeDaemon();
		mountDashboardHost(daemon, { storage, assets: fixtureAssets() });
		// Not in the six known filenames.
		expect((await daemon.app.request("/dashboard/fonts/evil.woff2")).status).toBe(404);
		// A traversal attempt is not a known leaf filename either → 404 (allow-list, never path-joins it).
		expect((await daemon.app.request("/dashboard/fonts/..%2Fconfig.json")).status).toBe(404);
	});
});

/**
 * PRD-024 Wave 3 — the REAL asset reader (`createWebAssets`) reading the repo `assets/` tree.
 * Proves the live-page fix end to end: the served CSS points at `/dashboard/fonts/` (NOT the
 * unserved `../logos/fonts/`), the host serves the real font bytes, and the woff2/ttf content-type
 * mapping holds. These read the tracked binaries under `assets/logos/fonts/`.
 */
describe("PRD-024 Wave-3 real-assets font serving + CSS rewrite", () => {
	function realHost() {
		const { daemon, storage } = makeDaemon();
		mountDashboardHost(daemon, { storage, assets: createWebAssets() });
		return daemon;
	}

	it("the served /dashboard/styles.css references /dashboard/fonts/ and NOT ../logos/fonts/", async () => {
		const css = await (await realHost().app.request(DASHBOARD_CSS_PATH)).text();
		// The rewrite happened: the @font-face URLs are origin-rooted at the served route.
		expect(css).toContain("/dashboard/fonts/");
		// The on-disk prefix that 404'd in the browser is gone from the served bytes.
		expect(css).not.toContain("../logos/fonts/");
		expect(css).not.toContain("logos/fonts/Inter");
	});

	it("serves the real woff2 with font/woff2 and the real ttf with font/ttf (content-type mapping)", async () => {
		const daemon = realHost();
		const woff2 = await daemon.app.request("/dashboard/fonts/JetBrainsMono-Regular.woff2");
		expect(woff2.status).toBe(200);
		expect(woff2.headers.get("content-type")).toBe("font/woff2");
		expect((await woff2.arrayBuffer()).byteLength).toBeGreaterThan(0);

		const ttf = await daemon.app.request("/dashboard/fonts/Inter-VariableFont_opsz_wght.ttf");
		expect(ttf.status).toBe(200);
		expect(ttf.headers.get("content-type")).toBe("font/ttf");
		expect((await ttf.arrayBuffer()).byteLength).toBeGreaterThan(0);
	});

	it("rejects a name outside the six-font allow-list (real reader, no path-join) → 404", async () => {
		const daemon = realHost();
		expect((await daemon.app.request("/dashboard/fonts/styles.css")).status).toBe(404);
		expect((await daemon.app.request("/dashboard/fonts/honeycomb-mark.svg")).status).toBe(404);
	});
});
