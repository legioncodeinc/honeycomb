/**
 * The dashboard web-app ENTRY — PRD-024 Wave 2 (AC-1, D-1) · PRD-037b (renders the multi-page Shell).
 *
 * This is the esbuild bundle entry. esbuild compiles the JSX at BUILD time and bundles
 * React + ReactDOM in (no CDN React, no `@babel/standalone`, no `type="text/babel"` — the
 * three things the UI kit's `index.html` did that D-1 forbids). The host serves the produced
 * bundle as a single static `<script>`; this module finds `#root` (created by the host shell HTML)
 * and renders the live {@link Shell} (sidebar + routed outlet) into it.
 *
 * The host stamps the asset base path onto `#root` as `data-asset-base` so the app knows
 * where the host serves the DS logo (loopback, no secret in the attribute).
 */

import React from "react";
import { createRoot } from "react-dom/client";

import { Shell } from "./app.js";

/** Mount the live dashboard SHELL into the host's `#root` element. Idempotent-safe per load. */
function mount(): void {
	const root = document.getElementById("root");
	if (root === null) return;
	// Sanitize the DOM-read base path before it flows into any asset `src` (e.g. the sidebar
	// mark `<img>`). Only a safe relative path is allowed — letters/digits/`. _ - /` — so a value
	// carrying a scheme (`javascript:`) or markup meta-characters can never reach a URL/HTML sink.
	// The host (not the user) sets `data-asset-base`, but this hard barrier closes the DOM-text→sink
	// taint flow by construction (CodeQL js/xss-through-dom) and fails safe to the default.
	const rawAssetBase = root.getAttribute("data-asset-base") ?? "assets";
	const assetBase = /^[A-Za-z0-9._/-]*$/.test(rawAssetBase) ? rawAssetBase : "assets";
	// PRD-037b: render the multi-page <Shell> (sidebar + routed outlet) instead of the old single
	// <App>. Same #root + data-asset-base contract; the esbuild entry + host shell HTML are untouched.
	createRoot(root).render(
		<React.StrictMode>
			<Shell assetBase={assetBase} />
		</React.StrictMode>,
	);
}

mount();
