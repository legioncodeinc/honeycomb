/**
 * Grok connector — installs into `~/.grok/hooks/honeycomb.json` through the inherited connector engine.
 */

import { describe, expect, it } from "vitest";

import { assertGrokHooksConform, isGrokEvent } from "../../references/grok/hooks-schema.js";
import { createFakeFs, GrokConnector, HarnessConnector } from "../../src/connectors/index.js";

const HOME = "/home/dev";
const BUNDLE = "/repo/harnesses/grok/bundle";
const CONFIG = `${HOME}/.grok/hooks/honeycomb.json`;

function seedFs(over: { files?: Record<string, string>; links?: Record<string, string> } = {}) {
	return createFakeFs({
		files: {
			[`${HOME}/.grok`]: "",
			[`${BUNDLE}/session-start.js`]: "// session-start",
			[`${BUNDLE}/capture.js`]: "// capture",
			[`${BUNDLE}/pre-tool-use.js`]: "// pre-tool-use",
			...over.files,
		},
		links: over.links,
	});
}

function connector(fs = seedFs(), skillSources: readonly string[] = []) {
	return new GrokConnector(fs, { home: HOME, bundleSource: BUNDLE, skillSources });
}

function commandsByEvent(text: string): Record<string, string[]> {
	const parsed = JSON.parse(text) as { hooks?: Record<string, { hooks: { command: string }[] }[]> };
	const out: Record<string, string[]> = {};
	for (const [event, blocks] of Object.entries(parsed.hooks ?? {})) {
		out[event] = blocks.flatMap((b) => b.hooks.map((h) => h.command));
	}
	return out;
}

describe("GrokConnector", () => {
	it("extends the shared connector base and inherits install/uninstall", () => {
		const c = connector();
		expect(c).toBeInstanceOf(HarnessConnector);
		expect(c.harness).toBe("grok");
	});

	it("writes Grok honeycomb.json with valid native event names and commands", async () => {
		const fs = seedFs();
		const result = await connector(fs).install();

		expect(result.wroteConfig).toBe(true);
		expect(result.handlers).toContain(`${HOME}/.grok/plugins/honeycomb/bundle/session-start.js`);

		const config = JSON.parse(fs.files.get(CONFIG) as string) as { hooks: Record<string, unknown> };
		for (const event of Object.keys(config.hooks)) {
			expect(isGrokEvent(event), `"${event}" is not a Grok hook event`).toBe(true);
		}
		expect(Object.keys(config.hooks)).toEqual(
			expect.arrayContaining(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]),
		);
		expect(() => assertGrokHooksConform(config)).not.toThrow();

		const commands = commandsByEvent(fs.files.get(CONFIG) as string);
		expect(commands.SessionStart.some((c) => c.includes("session-start.js"))).toBe(true);
		expect(commands.PreToolUse.some((c) => c.includes("pre-tool-use.js"))).toBe(true);
	});

	it("detects Grok when ~/.grok exists", async () => {
		const fs = seedFs();
		const detected = await connector(fs).detectPlatforms();
		expect(detected).toEqual([{ harness: "grok", configRoot: `${HOME}/.grok` }]);
	});
});
