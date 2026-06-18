/**
 * The webview HTML + status-bar painters — PRD-020c (FR-4 / FR-6 / FR-9 / c-AC-4 / c-AC-6).
 *
 * Pure (no editor, no daemon, no DeepLake) presentation helpers the shell uses to PAINT the
 * already-built render tree:
 *   - {@link renderDashboardHtml} turns a 020b {@link RenderedDashboard} (the SAME `ViewBlock`
 *     tree the daemon-served dashboard produces, D-6) into webview HTML — it adds NO view logic,
 *     it just serializes the canonical blocks (c-AC-6 / b-AC-5). A daemon-down render carries the
 *     connectivity banner block ALONE, so the webview shows the clear connectivity state (FR-9).
 *   - {@link paintStatusBar} turns the D1–D5 dimension lines into the compact status-bar text +
 *     the per-dimension tooltip, visibly flagging a failing dimension (c-AC-4).
 *
 * Keeping these pure (render tree → string) is what lets the webview embed the canonical 020b
 * views with no duplicate view code: the views are built by 020b; this module only serializes.
 */

import type { RenderedDashboard } from "../../../src/dashboard/index.js";
import type { ViewBlock } from "../../../src/dashboard/index.js";

/** Escape the five HTML-significant characters so view data never breaks the webview markup. */
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Render one {@link ViewBlock} (and its children) to an HTML section. Pure + recursive. */
function renderBlock(block: ViewBlock): string {
	const parts: string[] = [];
	const titleAttr = block.title !== undefined ? ` data-title="${escapeHtml(block.title)}"` : "";
	parts.push(`<section class="hc-block hc-kind-${escapeHtml(block.kind)}"${titleAttr}>`);
	if (block.title !== undefined) parts.push(`<h2>${escapeHtml(block.title)}</h2>`);
	if (block.rows !== undefined && block.rows.length > 0) {
		parts.push("<ul>");
		for (const row of block.rows) parts.push(`<li>${escapeHtml(row)}</li>`);
		parts.push("</ul>");
	}
	if (block.children !== undefined) {
		for (const child of block.children) parts.push(renderBlock(child));
	}
	parts.push("</section>");
	return parts.join("");
}

/**
 * Render the 020b {@link RenderedDashboard} to webview HTML (FR-6 / FR-9 / c-AC-6 / b-AC-5). The
 * blocks are the canonical 020b view tree (KPIs/sessions/settings/graph/rules/skill-sync when
 * reachable, or the connectivity banner alone when the daemon is down) — this serializes them
 * verbatim, adding NO view logic. The `data-connectivity` attribute lets the host style the
 * daemon-down state + a fast-start affordance (FR-9).
 */
export function renderDashboardHtml(rendered: RenderedDashboard): string {
	const reachable = rendered.connectivity.reachable;
	const body = rendered.views.map(renderBlock).join("");
	return [
		`<main class="hc-dashboard" data-connectivity="${reachable ? "reachable" : "unreachable"}">`,
		body,
		"</main>",
	].join("");
}

/** A D1–D5 dimension line the status bar paints. */
export interface StatusDimensionLine {
	readonly id: string;
	readonly label: string;
	readonly ok: boolean;
	readonly detail?: string;
}

/** The compact glyph + the hover tooltip the status bar is set to. */
export interface StatusBarPaint {
	/** The compact text (one glyph per dimension, e.g. `Honeycomb ✓✓✗✓✓`). */
	readonly text: string;
	/** The per-dimension tooltip (one line each, the failing ones marked). */
	readonly tooltip: string;
	/** True when ANY dimension is failing (so the host can color the item, c-AC-4). */
	readonly hasFailure: boolean;
}

/** The glyph for a passing dimension. */
export const OK_GLYPH = "✓"; // ✓
/** The glyph for a FAILING dimension (the visible flag, c-AC-4). */
export const FAIL_GLYPH = "✗"; // ✗

/**
 * Paint the D1–D5 health into the status-bar text + tooltip (FR-4 / c-AC-4). The text is a
 * compact glyph row (one ✓/✗ per dimension); the tooltip lists each dimension `id label: state`
 * with its detail, and a FAILING dimension is visibly flagged (the ✗ glyph + the word `FAILING`).
 * `hasFailure` lets the host color the item. The painter SURFACES the 020d result — it adds no
 * health logic.
 */
export function paintStatusBar(dimensions: readonly StatusDimensionLine[]): StatusBarPaint {
	const glyphs = dimensions.map((d) => (d.ok ? OK_GLYPH : FAIL_GLYPH)).join("");
	const hasFailure = dimensions.some((d) => !d.ok);
	const text = `Honeycomb ${glyphs}`;
	const tooltipLines = dimensions.map((d) => {
		const state = d.ok ? "ok" : "FAILING";
		const glyph = d.ok ? OK_GLYPH : FAIL_GLYPH;
		const detail = d.detail !== undefined ? ` — ${d.detail}` : "";
		return `${glyph} ${d.id} ${d.label}: ${state}${detail}`;
	});
	return { text, tooltip: tooltipLines.join("\n"), hasFailure };
}
