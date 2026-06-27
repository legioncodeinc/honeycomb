/**
 * The HiveDoctor ASCII banner + command menu (PRD-063f AC-063f.1 / parent AC-7).
 *
 * A cute "hive doctor" - a bee wearing a head-mirror and carrying a little doctor's
 * bag - rendered on bare invocation, followed by a focused command menu. Aligned with
 * the branded Honeycomb CLI voice (warm, amber, concise). Built-ins only; the art is a
 * plain template string, colorized through the injected {@link Colors} surface so it
 * degrades cleanly under NO_COLOR / non-TTY.
 *
 * The art and the menu are pure string builders (no I/O), so a test can capture the
 * exact output without spawning a process.
 */

import type { Colors } from "./colors.js";
import { COMMAND_MENU } from "./command-table.js";
import { HIVEDOCTOR_VERSION } from "../version.js";

/**
 * The raw hive-doctor art. A bee with a doctor's head-mirror (the `(+)`), holding a
 * stethoscope, beside a small medical bag marked with a cross. Drawn with characters
 * that survive any code page (no box-drawing required for the figure itself).
 */
const ART = String.raw`
        __        _,-._
       /  \      / .-. \      .-=-.
      |    |    | (+ +) |    /  +  \
       \__/      \  ^  /     | _|_ |
        ||    .===) ~ (===.  '-----'
     ___||___ /  /     \  \   doctor's
    | ~~~~~~ |(  ( bzz ) )    bag
    |________| \  \_._/  /
                '-.___.-'
`;

/** The tagline under the figure (brand voice: warm, plain, a little playful). */
const TAGLINE = "HiveDoctor - the little bee that keeps your hive healthy.";

/** Build the full banner: art + tagline + version line. Pure; colorized via `colors`. */
export function renderBanner(colors: Colors): string {
	const art = colors.amber(ART.replace(/^\n/, ""));
	const tagline = colors.bold(TAGLINE);
	const version = colors.dim(`v${HIVEDOCTOR_VERSION}`);
	return `${art}\n${tagline}  ${version}\n`;
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

/** Build the full bare-invocation output: banner + menu (AC-063f.1). */
export function renderBannerWithMenu(colors: Colors): string {
	return `${renderBanner(colors)}\n${renderMenu(colors)}`;
}
