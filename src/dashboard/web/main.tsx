/**
 * The dashboard web-app ENTRY — PRD-024 Wave 2 (AC-1, D-1).
 *
 * This is the esbuild bundle entry. esbuild compiles the JSX at BUILD time and bundles
 * React + ReactDOM in (no CDN React, no `@babel/standalone`, no `type="text/babel"` — the
 * three things the UI kit's `index.html` did that D-1 forbids). The host serves the produced
 * bundle as a single static `<script>`; this module finds `#root` (created by the shell) and
 * renders the live {@link App} into it.
 *
 * The shell stamps the asset base path onto `#root` as `data-asset-base` so the app knows
 * where the host serves the DS logo (loopback, no secret in the attribute).
 */

import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.js";

/** Mount the live dashboard app into the shell's `#root` element. Idempotent-safe per load. */
function mount(): void {
	const root = document.getElementById("root");
	if (root === null) return;
	const assetBase = root.getAttribute("data-asset-base") ?? "assets";
	createRoot(root).render(
		<React.StrictMode>
			<App assetBase={assetBase} />
		</React.StrictMode>,
	);
}

mount();
