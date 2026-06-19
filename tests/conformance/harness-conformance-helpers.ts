/**
 * Shared helpers for the harness-contract conformance suite.
 *
 * Factored out so the two connector conformance flows (Claude Code, Cursor) share ONE
 * assertion/seed shape instead of copy-pasting it (jscpd threshold 7). Each helper drives the
 * REAL connector over the 019a {@link createFakeFs} in-memory seam — no real `~`, no temp dir,
 * no daemon — captures the emitted hook-config text, and exposes it for the per-harness zod
 * oracle to validate.
 *
 * The schemas under `references/<harness>/` are the contract; this file is only plumbing.
 */

import { createFakeFs, type FakeFs } from "../../src/connectors/index.js";

/** The compiled handler files a hooks-based connector copies from its bundle source. */
export const BUNDLE_HANDLER_FILES = [
	"session-start.js",
	"capture.js",
	"pre-tool-use.js",
	"session-end.js",
] as const;

/** Seed the bundle-source handler files + the install-proof dir into a fresh fake fs. */
export function seedHandlerBundle(
	bundleSource: string,
	configRootProof: string,
	over: { files?: Record<string, string>; links?: Record<string, string> } = {},
): FakeFs {
	const files: Record<string, string> = {
		// Make the harness "installed" (the connector's configRoot probe) so detect passes.
		[configRootProof]: "",
		...Object.fromEntries(BUNDLE_HANDLER_FILES.map((f) => [`${bundleSource}/${f}`, `// ${f}`])),
		...over.files,
	};
	return createFakeFs({ files, ...(over.links ? { links: over.links } : {}) });
}

/** Parse the JSON text a connector wrote to its config path into an unknown object. */
export function parseEmittedConfig(text: string | undefined): unknown {
	if (text === undefined) throw new Error("conformance: connector wrote no config file");
	return JSON.parse(text);
}

/**
 * A realistic THIRD-PARTY hook entry in the Claude Code lingua franca (`{ type, command,
 * timeout }`), shaped so it itself conforms to a harness hooks schema. Used to seed a foreign
 * entry before install and assert it survives byte-identical + the merged whole still conforms.
 * Carries NO `_honeycomb` sentinel and NO `honeycomb/bundle/` path → the connector treats it as
 * foreign and must preserve it.
 */
export function foreignHookEntry(): { type: string; command: string; timeout: number } {
	return { type: "command", command: "node /opt/acme-linter/cursor-hook.js", timeout: 20 };
}

/**
 * Flatten an emitted Claude-Code-style hooks map (`{ event: [{ hooks: [entry] }] }`) to the
 * command strings per event — used to assert which events carry Honeycomb vs foreign entries.
 */
export function commandsByEvent(config: unknown): Record<string, string[]> {
	const hooks = (config as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }).hooks ?? {};
	const out: Record<string, string[]> = {};
	for (const [event, blocks] of Object.entries(hooks)) {
		out[event] = blocks.flatMap((b) => (b.hooks ?? []).map((h) => h.command ?? "")).filter((c) => c !== "");
	}
	return out;
}

/**
 * Flatten an emitted Cursor FLAT hooks map (`{ event: [{ command, … }] }`) to the command strings
 * per event — the Cursor analogue of {@link commandsByEvent}, used to assert which events carry
 * Honeycomb vs foreign FLAT entries.
 */
export function flatCommandsByEvent(config: unknown): Record<string, string[]> {
	const hooks = (config as { hooks?: Record<string, Array<{ command?: string }>> }).hooks ?? {};
	const out: Record<string, string[]> = {};
	for (const [event, entries] of Object.entries(hooks)) {
		out[event] = (entries ?? []).map((e) => e.command ?? "").filter((c) => c !== "");
	}
	return out;
}
