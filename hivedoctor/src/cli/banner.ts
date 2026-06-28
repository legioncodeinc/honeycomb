/**
 * The HiveDoctor banner + command menu (PRD-064f AC-064f.1 / parent AC-7).
 *
 * A clean attribution banner - the Legion Code Inc. and Activeloop wordmarks with a
 * collaboration line - rendered on bare invocation, followed by a focused command menu.
 * Aligned with the branded Honeycomb CLI voice (warm, amber, concise). ASCII-only by
 * design so it renders identically on every terminal and code page (no box-drawing or
 * exotic glyphs to mojibake). The `[LC]` / `[AL]` marks are plain monogram stand-ins for
 * the real brand logos, which a terminal cannot render; swap in proper glyphs if desired.
 * Colorized through the injected {@link Colors} surface so it degrades cleanly under
 * NO_COLOR / non-TTY.
 *
 * The banner and the menu are pure string builders (no I/O), so a test can capture the
 * exact output without spawning a process.
 */

import type { Colors } from "./colors.js";
import { COMMAND_MENU } from "./command-table.js";
import { HIVEDOCTOR_VERSION } from "../version.js";

/**
 * The attribution banner: the two wordmarks (with monogram marks) on one ruled line,
 * then the collaboration line. ASCII-only so it survives any code page.
 */
const ART = String.raw`
  ================================================================
    [LC]  LEGION CODE INC.            [AL]  ACTIVELOOP
  ================================================================
  A collaboration between Legion Code Inc. x Activeloop,
  powered by deeplake.ai
`;

/** Product identity line shown beneath the collaboration banner. */
const NAME = "HiveDoctor";

/** Build the full banner: collaboration banner + product name + version. Pure; colorized via `colors`. */
export function renderBanner(colors: Colors): string {
	const art = colors.amber(ART.replace(/^\n/, ""));
	const name = colors.bold(NAME);
	const version = colors.dim(`v${HIVEDOCTOR_VERSION}`);
	return `${art}\n${name}  ${version}\n`;
}

/** Build the command-menu block from the single-sourced command table. Pure. */
export function renderMenu(colors: Colors): string {
	const header = colors.bold("Usage:");
	const usage = `  ${colors.cyan("hivedoctor")} ${colors.dim("<command> [options]")}`;
	const commandsHeader = colors.bold("Commands:");

	// Right-pad the command column so the descriptions align.
	const width = COMMAND_MENU.reduce((max, e) => Math.max(max, e.invocation.length), 0);
	const lines = COMMAND_MENU.map((e) => {
		const name = colors.cyan(e.invocation.padEnd(width));
		return `  ${name}  ${e.summary}`;
	});

	return [header, usage, "", commandsHeader, ...lines, ""].join("\n");
}

/** Build the full bare-invocation output: banner + menu (AC-064f.1). */
export function renderBannerWithMenu(colors: Colors): string {
	return `${renderBanner(colors)}\n${renderMenu(colors)}`;
}
