/**
 * The daemon-served dashboard HTML host serializer — PRD-021d (FR-3 / FR-4 / d-AC-3).
 *
 * This turns a 020b {@link RenderedDashboard} (the canonical `ViewBlock` tree the
 * daemon-served dashboard produces) into a COMPLETE, standalone HTML PAGE the daemon
 * serves at `GET /dashboard` so "the dashboard" is something an operator can open in a
 * browser, not just a data contract (FR-3). It is renderer-agnostic in the same sense the
 * Cursor webview serializer is: it adds NO view logic, it just serializes the canonical
 * blocks the 020b builders produced (FR-4). A daemon-down render carries the connectivity
 * banner block alone, so the page shows the clear connectivity state (d-AC-5), and a
 * not-built graph / empty session list renders the 020b empty-state block (d-AC-6) — never
 * a blank or an error.
 *
 * ── Why a standalone page (not the webview fragment) ─────────────────────────
 *   The Cursor extension's `render.ts` serializes a webview HTML FRAGMENT embedded in the
 *   editor chrome (it inherits the editor's styles). The daemon host serves a WHOLE page to
 *   a plain browser: it needs the `<!doctype>`, a `<head>`, self-contained CSS, and a
 *   live-log panel slot. The two serializers therefore differ by host, not by view logic —
 *   both consume the SAME `ViewBlock` tree the 020b builders emit.
 *
 * ── Pure ─────────────────────────────────────────────────────────────────────
 *   No IO, no daemon, no DeepLake. The data already came through the daemon (the host route
 *   builds the `RenderedDashboard` from the live storage before calling this). A test
 *   asserts the serialized HTML contains the six view titles + the connectivity/empty-state
 *   markers without a DOM.
 */

import type { RenderedDashboard } from "./dashboard.js";
import type { ViewBlock } from "./views.js";

/** Escape the five HTML-significant characters so view data never breaks the page markup. */
export function escapePageHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Serialize one {@link ViewBlock} (and its children) to a page section. Pure + recursive. */
function serializeBlock(block: ViewBlock): string {
	const out: string[] = [];
	const kindClass = `hc-block hc-kind-${escapePageHtml(block.kind)}`;
	out.push(`<section class="${kindClass}">`);
	if (block.title !== undefined) {
		out.push(`<h2 class="hc-block-title">${escapePageHtml(block.title)}</h2>`);
	}
	if (block.rows !== undefined && block.rows.length > 0) {
		out.push('<ul class="hc-rows">');
		for (const row of block.rows) out.push(`<li>${escapePageHtml(row)}</li>`);
		out.push("</ul>");
	}
	if (block.children !== undefined) {
		for (const child of block.children) out.push(serializeBlock(child));
	}
	out.push("</section>");
	return out.join("");
}

/** The self-contained page stylesheet (no external asset — the host serves one file). */
const PAGE_STYLE = [
	"body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:1.5rem;background:#0f1117;color:#e6e6e6}",
	".hc-dashboard{max-width:960px;margin:0 auto;display:grid;gap:1rem}",
	".hc-block{background:#1a1d27;border:1px solid #2a2e3a;border-radius:8px;padding:1rem}",
	".hc-block-title{margin:0 0 .5rem;font-size:1rem;color:#9ad}",
	".hc-rows{margin:0;padding-left:1.1rem;line-height:1.6}",
	".hc-kind-connectivity{border-color:#a33;background:#2a1416}",
	".hc-kind-empty-state{border-color:#665;background:#22220f}",
	"#hc-live-log{white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:.8rem}",
].join("");

/**
 * The id of the live-log panel slot the page exposes (FR-6 / d-AC-4). The daemon serves the
 * static page; a follower (the dashboard panel) streams `/api/logs/stream` into this slot.
 * Named so the eventual client script (and the panel block) target a stable element.
 */
export const LIVE_LOG_SLOT_ID = "hc-live-log" as const;

/**
 * Serialize the 020b {@link RenderedDashboard} into a COMPLETE HTML page the daemon serves
 * at `GET /dashboard` (FR-3 / FR-4 / d-AC-3). The blocks are the canonical 020b view tree —
 * KPIs/sessions/settings/graph/rules/skill-sync when reachable, or the connectivity banner
 * alone when the daemon is down (d-AC-5). This serializes them verbatim into a standalone
 * page (doctype + head + self-contained CSS), adding NO view logic. The `data-connectivity`
 * attribute lets a client style the daemon-down state.
 */
export function renderDashboardPage(rendered: RenderedDashboard): string {
	const reachable = rendered.connectivity.reachable;
	const body = rendered.views.map(serializeBlock).join("");
	const liveLog = reachable
		? `<section class="hc-block hc-kind-live-log"><h2 class="hc-block-title">Live log</h2><div id="${LIVE_LOG_SLOT_ID}"></div></section>`
		: "";
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		"<title>Honeycomb dashboard</title>",
		`<style>${PAGE_STYLE}</style>`,
		"</head>",
		"<body>",
		`<main class="hc-dashboard" data-connectivity="${reachable ? "reachable" : "unreachable"}">`,
		body,
		liveLog,
		"</main>",
		"</body>",
		"</html>",
	].join("");
}
