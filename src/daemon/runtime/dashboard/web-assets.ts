/**
 * The daemon-side ASSET RESOLVER for the bundled dashboard web app — PRD-024 Wave 2 (AC-1).
 *
 * The viewable `/dashboard` is now a real React app (`src/dashboard/web/*`) bundled by esbuild
 * to a single static JS file, styled by the design-system CSS (`assets/styles.css` + tokens),
 * and marked by the honeycomb logo. The host (`host.ts`) serves four things on loopback:
 *
 *   GET /dashboard                  → the index SHELL (`<div id="root">` + <link> + <script>)
 *   GET /dashboard/app.js           → the esbuild bundle (React+ReactDOM+the app, build-time JSX)
 *   GET /dashboard/styles.css       → the concatenated DS CSS (tokens + base, no @import chain)
 *   GET /dashboard/honeycomb-memory-cluster.svg → the brand mark
 *
 * This module owns LOCATING those source assets on disk and reading them. It lives under
 * `src/daemon/` (it does Node `fs` IO) and is the ONLY place the host touches the filesystem.
 *
 * ── Why concatenate the CSS here (not ship the @import chain) ─────────────────
 *   `assets/styles.css` is `@import url('tokens/…')` lines — those resolve RELATIVE to the
 *   served URL. Rather than serve five files + rewrite the relative URLs, we read the token
 *   files in declared order and concatenate them into ONE payload. One request, no relative
 *   `@import` resolution, deterministic across install layouts.
 *
 * ── Resolution + injectability ───────────────────────────────────────────────
 *   The assets dir defaults to {@link resolveAssetsDir} (walk up from this module to the repo
 *   root that contains `assets/styles.css`). A test injects a fixture dir so it never depends
 *   on the real tree. Reads fail SOFT (a missing asset yields an empty string / a 404 at the
 *   route), never a throw that would 500 the page.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The token files, in the SAME order `assets/styles.css` @imports them (order matters). */
const CSS_FILES = ["tokens/fonts.css", "tokens/colors.css", "tokens/typography.css", "tokens/spacing.css", "tokens/base.css"] as const;

/** The design-system logo the header renders. */
const LOGO_FILE = "logos/honeycomb-memory-cluster.svg";

/**
 * The on-disk dir (under `assets/`) the brand fonts live in, and the FIXED allow-list of the
 * six font filenames the host will serve. The host route serves ONLY a name in this set — there
 * is NO attacker-controlled path component (mirrors {@link LOGO_FILE}'s hard-coded-filename
 * safety). Anything not in this set yields `null` → a 404 at the route.
 */
const FONTS_DIR = "logos/fonts";
const FONT_FILES = [
	"Inter-VariableFont_opsz_wght.ttf",
	"Inter-Italic-VariableFont_opsz_wght.ttf",
	"JetBrainsMono-Regular.woff2",
	"JetBrainsMono-Medium.woff2",
	"JetBrainsMono-SemiBold.woff2",
	"JetBrainsMono-Bold.woff2",
] as const;
const FONT_ALLOW = new Set<string>(FONT_FILES);

/** The same-origin path the host serves the fonts under (origin-rooted; see {@link rewriteFontUrls}). */
const FONT_ROUTE_PREFIX = "/dashboard/fonts/";

/** Map a font filename to its `content-type` by extension (`.woff2` → `font/woff2`, `.ttf` → `font/ttf`). */
function fontContentType(name: string): string {
	return name.endsWith(".woff2") ? "font/woff2" : "font/ttf";
}

/**
 * Rewrite the DS `@font-face` `url(...)` prefix in the SERVED CSS so the fonts resolve to the
 * host's `/dashboard/fonts/<file>` route instead of the on-disk `../logos/fonts/<file>` (which the
 * host does not serve at that path → 404). The replacement is ORIGIN-ROOTED (leading `/`) so it
 * resolves regardless of the stylesheet's own URL. ONLY the `logos/fonts/` prefix is touched — the
 * `../` is consumed with it, and no other `url(...)` (the mark SVG etc.) is mangled. Byte-identical
 * otherwise.
 */
function rewriteFontUrls(css: string): string {
	return css.replaceAll("../logos/fonts/", FONT_ROUTE_PREFIX).replaceAll("logos/fonts/", FONT_ROUTE_PREFIX);
}

/**
 * The bundled web-app filename the build emits beside the daemon bundle. esbuild
 * (`esbuild.config.mjs`) bundles `src/dashboard/web/main.tsx` → `daemon/dashboard-app.js`.
 */
export const DASHBOARD_APP_BUNDLE = "dashboard-app.js" as const;

/**
 * Resolve the repo `assets/` directory by walking up from this module until a dir with
 * `assets/styles.css` is found. Works from `src/` (tsc/vitest run from source) and from the
 * bundled `daemon/` layout (the file is bundled, but `import.meta.url` still points into a dir
 * under the repo/install root). Returns `null` when no `assets/` is found (a stripped install).
 */
export function resolveAssetsDir(startUrl: string = import.meta.url): string | null {
	let dir: string;
	try {
		dir = dirname(fileURLToPath(startUrl));
	} catch {
		return null;
	}
	// Walk up to the filesystem root looking for `<dir>/assets/styles.css`.
	for (let i = 0; i < 12; i++) {
		const candidate = join(dir, "assets");
		if (existsSync(join(candidate, "styles.css"))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Resolve the directory the bundled `dashboard-app.js` lives in. It is emitted beside the
 * daemon bundle (`daemon/`), and in the bundled layout this module IS inside `daemon/`, so
 * the bundle sits next to it. From source (vitest) the bundle may not exist yet — the read
 * fails soft. Returns `null` when the dir cannot be resolved.
 */
export function resolveBundleDir(startUrl: string = import.meta.url): string | null {
	try {
		return dirname(fileURLToPath(startUrl));
	} catch {
		return null;
	}
}

/** Options for {@link createWebAssets}. */
export interface WebAssetsOptions {
	/** The `assets/` source dir. Defaults to {@link resolveAssetsDir}. A test injects a fixture. */
	readonly assetsDir?: string | null;
	/** The dir the bundled app JS lives in. Defaults to {@link resolveBundleDir}. */
	readonly bundleDir?: string | null;
	/** Override the bundled app JS content directly (a test serves a stub bundle). */
	readonly appJs?: string;
}

/** A served text asset: its UTF-8 body + content type, or `null` when missing (→ 404). */
export interface ServedAsset {
	readonly body: string;
	readonly contentType: string;
}

/** A served BINARY asset (the fonts): raw bytes + content type, or `null` when missing (→ 404). */
export interface ServedBinaryAsset {
	readonly body: ArrayBuffer;
	readonly contentType: string;
}

/** Read a UTF-8 file, returning `null` (never throwing) on any IO error. */
function readSoft(path: string): string | null {
	try {
		return existsSync(path) ? readFileSync(path, "utf-8") : null;
	} catch {
		return null;
	}
}

/**
 * Read a file as a raw `ArrayBuffer` (fonts are binary; a UTF-8 round-trip would corrupt them).
 * Returns an exact-length `ArrayBuffer` slice so the served body is a non-shared buffer Hono
 * accepts as a binary `Data`.
 */
function readBinarySoft(path: string): ArrayBuffer | null {
	try {
		if (!existsSync(path)) return null;
		const buf = readFileSync(path);
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	} catch {
		return null;
	}
}

/** The host-facing asset reader: the concatenated CSS, the logo, the app bundle, and the fonts. */
export interface WebAssets {
	/** The concatenated DS CSS (tokens + base), font URLs rewritten, or `null` when the assets dir is missing. */
	css(): ServedAsset | null;
	/** The honeycomb logo SVG, or `null` when missing. */
	logo(): ServedAsset | null;
	/** The bundled web-app JS, or `null` when the bundle has not been built. */
	appJs(): ServedAsset | null;
	/** A brand font's bytes + content type for an allow-listed `name`, or `null` (→ 404) otherwise. */
	font(name: string): ServedBinaryAsset | null;
}

/**
 * Build the host-side asset reader (AC-1). Resolves the assets + bundle dirs once and reads on
 * demand. Every read fails soft (missing → `null` → the route 404s), so a stripped install or
 * a not-yet-built bundle never 500s the page. The CSS is concatenated from the token files in
 * declared order so the served page needs ONE stylesheet request and no relative `@import`
 * resolution.
 */
export function createWebAssets(options: WebAssetsOptions = {}): WebAssets {
	const assetsDir = options.assetsDir === undefined ? resolveAssetsDir() : options.assetsDir;
	const bundleDir = options.bundleDir === undefined ? resolveBundleDir() : options.bundleDir;
	const appJsOverride = options.appJs;

	return {
		css(): ServedAsset | null {
			if (assetsDir === null) return null;
			const parts: string[] = [];
			for (const rel of CSS_FILES) {
				const text = readSoft(join(assetsDir, rel));
				if (text !== null) parts.push(`/* ${rel} */\n${text}`);
			}
			if (parts.length === 0) return null;
			// Rewrite the `@font-face` URL prefix so the fonts resolve to the served `/dashboard/fonts/`
			// route (the host does not serve the on-disk `../logos/fonts/` path → 404). See rewriteFontUrls.
			return { body: rewriteFontUrls(parts.join("\n\n")), contentType: "text/css; charset=utf-8" };
		},
		logo(): ServedAsset | null {
			if (assetsDir === null) return null;
			const svg = readSoft(join(assetsDir, LOGO_FILE));
			return svg === null ? null : { body: svg, contentType: "image/svg+xml" };
		},
		font(name: string): ServedBinaryAsset | null {
			if (assetsDir === null) return null;
			// Allow-list ONLY: a name not in the fixed six is rejected (→ 404). No attacker-controlled
			// path component — `name` is never joined unless it is a known leaf filename.
			if (!FONT_ALLOW.has(name)) return null;
			const bytes = readBinarySoft(join(assetsDir, FONTS_DIR, name));
			return bytes === null ? null : { body: bytes, contentType: fontContentType(name) };
		},
		appJs(): ServedAsset | null {
			if (appJsOverride !== undefined) return { body: appJsOverride, contentType: "text/javascript; charset=utf-8" };
			if (bundleDir === null) return null;
			const js = readSoft(join(bundleDir, DASHBOARD_APP_BUNDLE));
			return js === null ? null : { body: js, contentType: "text/javascript; charset=utf-8" };
		},
	};
}
