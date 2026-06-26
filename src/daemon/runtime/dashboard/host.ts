/**
 * The viewable dashboard HOST route — PRD-021d (FR-3) re-skinned to the brand UI kit by
 * PRD-024 Wave 2 (AC-1 production-clean bundle).
 *
 * ── What changed in PRD-024 ──────────────────────────────────────────────────
 *   `GET /dashboard` no longer server-renders the 020b `ViewBlock` tree as a static HTML
 *   page. It now serves the INDEX SHELL of a real React app — the faithful re-creation of
 *   `assets/ui_kits/dashboard/index.html`, bundled production-clean by esbuild
 *   (`src/dashboard/web/main.tsx` → `daemon/dashboard-app.js`). The shell is `<div id="root">`
 *   plus a `<link>` to the design-system CSS and a `<script>` to the bundled app; the app then
 *   hydrates ITSELF from the daemon's live endpoints (kpis/sessions/recall/logs/health/pollinate).
 *
 *   This is exactly what D-1 demands: NO `unpkg`/CDN React, NO in-browser `@babel/standalone`,
 *   NO `type="text/babel"`. The shell references ONLY same-origin loopback assets the host
 *   serves, and carries NO token/secret (D-4) — the app reads only what the daemon chooses to
 *   serve over loopback.
 *
 * ── The four routes this seam registers (all under the unprotected root group) ──
 *   GET /dashboard                    → the index shell (this module's {@link renderShell})
 *   GET /dashboard/app.js             → the esbuild bundle (React + ReactDOM + the app)
 *   GET /dashboard/styles.css         → the concatenated design-system CSS
 *   GET /dashboard/honeycomb-memory-cluster.svg → the brand mark
 *
 * ── LOCAL-MODE ONLY (D-4 / security F-1) ─────────────────────────────────────
 *   `assembleSeams` fires this seam ONLY when `daemon.config.mode === "local"` (the
 *   single-user loopback dogfood target). In team/hybrid the route is never mounted, so a
 *   tenant's KPIs/sessions HTML is never served without auth. This module does not re-check
 *   the mode (the composition root owns the gate), but it never reads a secret to render.
 */

import { createWebAssets, type WebAssets } from "./web-assets.js";
import type { StorageQuery } from "../../storage/client.js";
import type { Daemon } from "../server.js";

/** The route the viewable dashboard host is served at (FR-3). */
export const DASHBOARD_HOST_PATH = "/dashboard" as const;

/** The same-origin path the host serves the bundled app JS at. */
export const DASHBOARD_APP_PATH = "/dashboard/app.js" as const;

/** The same-origin path the host serves the concatenated design-system CSS at. */
export const DASHBOARD_CSS_PATH = "/dashboard/styles.css" as const;

/** The same-origin path the host serves the brand mark at. */
export const DASHBOARD_LOGO_PATH = "/dashboard/honeycomb-memory-cluster.svg" as const;

/**
 * The same-origin path prefix the host serves the brand fonts under. The served DS CSS's
 * `@font-face` URLs are rewritten to this prefix (see `web-assets.ts` `rewriteFontUrls`) so the
 * browser fetches `/dashboard/fonts/<file>` instead of the unserved on-disk `../logos/fonts/<file>`.
 * The `:name` is matched against a FIXED allow-list in `web-assets.ts` `font()` — anything not in
 * the six known filenames 404s (no attacker-controlled path component).
 */
export const DASHBOARD_FONT_PATH = "/dashboard/fonts/:name" as const;

/** The base path (relative to `/dashboard`) the app resolves the logo under. */
const ASSET_BASE = "/dashboard" as const;

/** The root route group the host attaches to (already mounted, UNPROTECTED, in `server.ts`). */
export const DASHBOARD_HOST_GROUP = "/" as const;

/** Options for {@link mountDashboardHost}. */
export interface MountDashboardHostOptions {
	/**
	 * The live storage client. ACCEPTED for seam-signature compatibility with the composition
	 * root (`assembleSeams` passes `{ storage }`), but the shell no longer reads storage to
	 * render — the bundled app hydrates itself from the daemon's HTTP endpoints. Kept optional
	 * so a test can mount the host with no storage.
	 */
	readonly storage?: StorageQuery;
	/**
	 * The web-asset reader (the CSS/logo/bundle source). Defaults to {@link createWebAssets}
	 * (resolve the repo `assets/` + the bundle beside the daemon). A test injects a fixture
	 * reader so the host suite never depends on the real tree or a built bundle.
	 */
	readonly assets?: WebAssets;
}

/**
 * The static layout CSS the UI kit declares inline in `index.html` (`.wrap`, `.grid2`,
 * `.kpirow`, `.mem-enter`, `.col`). Ported verbatim so the served page lays out exactly like
 * the kit. The DS TOKENS + component styles come from the linked `/dashboard/styles.css`; this
 * is only the page's own grid/animation rules.
 */
const LAYOUT_CSS = [
	"body { margin: 0; background: var(--bg-canvas); min-height: 100vh; }",
	".wrap { max-width: 1180px; margin: 0 auto; padding: 28px 28px 48px; }",
	".grid2 { display: grid; grid-template-columns: 1.15fr 1fr; gap: 16px; }",
	"@media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } }",
	".kpirow { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }",
	"@media (max-width: 720px) { .kpirow { grid-template-columns: repeat(2, 1fr); } }",
	".mem-enter { opacity: 1; }",
	"@media (prefers-reduced-motion: no-preference) {",
	"  .mem-enter { animation: memIn var(--dur-base) var(--ease-out) both; }",
	"  @keyframes memIn { from { transform: translateY(10px); } to { transform: none; } }",
	"}",
	".col { display: flex; flex-direction: column; gap: 16px; }",
].join("\n");

/**
 * Build the index SHELL HTML (AC-1). It is a COMPLETE page: doctype, head with the DS CSS
 * `<link>` + the inline layout CSS, a `<div id="root">` (the app mounts here) carrying the
 * asset base, and the bundled-app `<script type="module">`. NO inline data, NO token/secret,
 * NO CDN/Babel reference — the bundle is same-origin loopback. The app self-hydrates.
 */
export function renderShell(): string {
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		"<title>Honeycomb — Dashboard</title>",
		`<link rel="stylesheet" href="${DASHBOARD_CSS_PATH}">`,
		`<link rel="icon" href="${DASHBOARD_LOGO_PATH}">`,
		`<style>${LAYOUT_CSS}</style>`,
		"</head>",
		"<body>",
		`<div id="root" data-asset-base="${ASSET_BASE}"></div>`,
		`<script type="module" src="${DASHBOARD_APP_PATH}"></script>`,
		"</body>",
		"</html>",
	].join("\n");
}

/**
 * Attach the viewable dashboard host onto the daemon's already-mounted root group (FR-3),
 * re-skinned to serve the bundled brand UI kit (PRD-024 Wave 2). Registers the shell route
 * plus the three static-asset routes (app JS, CSS, logo). Call ONCE after `createDaemon(...)`;
 * `assembleSeams` fires it LOCAL-MODE ONLY (security F-1). If the root group is not mounted the
 * attach is a no-op. The shell carries no secret/token; the asset routes serve only the DS
 * CSS/logo + the bundle (a not-yet-built bundle 404s rather than 500s).
 */
export function mountDashboardHost(daemon: Daemon, options: MountDashboardHostOptions = {}): void {
	const root = daemon.group(DASHBOARD_HOST_GROUP);
	if (root === undefined) return;

	const assets = options.assets ?? createWebAssets();

	// GET /dashboard — the index shell (the app mounts into #root and self-hydrates).
	// `no-cache` (revalidate every load): the shell + app.js + css filenames are NOT
	// content-hashed, so a daemon UPGRADE rebuilds them in place at the SAME URL. Without a
	// revalidation directive the browser HEURISTICALLY caches the bundle (no Cache-Control,
	// no Last-Modified) and keeps running a STALE app.js across a daemon restart — the exact
	// trap behind a "fixed in the bundle but still broken in my tab" report. `no-cache` forces
	// the browser to re-pull on each load (cheap over loopback), so a rebuilt dashboard is
	// always the one that runs. The brand mark + fonts stay long-lived `immutable` below —
	// their bytes are content-stable, and the mark is fetched by URL from the fresh app.js.
	root.get(DASHBOARD_HOST_PATH, (c) => {
		c.header("cache-control", "no-cache");
		return c.html(renderShell());
	});

	// GET /dashboard/app.js — the esbuild bundle (React + ReactDOM + the dashboard app).
	root.get(DASHBOARD_APP_PATH, (c) => {
		const asset = assets.appJs();
		if (asset === null) return c.text("dashboard bundle not built", 404);
		return c.body(asset.body, 200, { "content-type": asset.contentType, "cache-control": "no-cache" });
	});

	// GET /dashboard/styles.css — the concatenated design-system CSS.
	root.get(DASHBOARD_CSS_PATH, (c) => {
		const asset = assets.css();
		if (asset === null) return c.text("dashboard styles unavailable", 404);
		return c.body(asset.body, 200, { "content-type": asset.contentType, "cache-control": "no-cache" });
	});

	// GET /dashboard/honeycomb-memory-cluster.svg — the brand mark. Content-stable bytes, but
	// served `no-cache` too: it shares the un-hashed URL contract with the shell, and revalidating
	// a ~1 KB SVG over loopback is free — cheaper than another stale-asset report.
	root.get(DASHBOARD_LOGO_PATH, (c) => {
		const asset = assets.logo();
		if (asset === null) return c.text("dashboard logo unavailable", 404);
		return c.body(asset.body, 200, { "content-type": asset.contentType, "cache-control": "no-cache" });
	});

	// GET /dashboard/fonts/<file> — the brand fonts (Inter + JetBrains Mono). The DS CSS's
	// `@font-face` URLs are rewritten to this route. `:name` is allow-listed in `font()` (only the
	// six known filenames resolve; anything else — incl. traversal — 404s). Fonts carry no secret,
	// so they need no token; a long-lived immutable cache-control since the bytes are content-stable.
	root.get(DASHBOARD_FONT_PATH, (c) => {
		const asset = assets.font(c.req.param("name"));
		if (asset === null) return c.text("dashboard font not found", 404);
		return c.body(asset.body, 200, {
			"content-type": asset.contentType,
			"cache-control": "public, max-age=31536000, immutable",
		});
	});
}
