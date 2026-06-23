/**
 * Codex connector — installs into `~/.codex/hooks.json` through the inherited connector engine.
 */

import { describe, expect, it } from "vitest";

import { assertCodexHooksConform, isCodexEvent } from "../../references/codex/hooks-schema.js";
import { CodexConnector, createFakeFs, HarnessConnector } from "../../src/connectors/index.js";

const HOME = "/home/dev";
const BUNDLE = "/repo/harnesses/codex/bundle";
const CONFIG = `${HOME}/.codex/hooks.json`;

function seedFs(over: { files?: Record<string, string>; links?: Record<string, string> } = {}) {
	return createFakeFs({
		files: {
			[`${HOME}/.codex`]: "",
			[`${BUNDLE}/session-start.js`]: "// session-start",
			[`${BUNDLE}/capture.js`]: "// capture",
			[`${BUNDLE}/pre-tool-use.js`]: "// pre-tool-use",
			...over.files,
		},
		links: over.links,
	});
}

function connector(fs = seedFs(), skillSources: readonly string[] = []) {
	return new CodexConnector(fs, { home: HOME, bundleSource: BUNDLE, skillSources });
}

function commandsByEvent(text: string): Record<string, string[]> {
	const parsed = JSON.parse(text) as { hooks?: Record<string, { hooks: { command: string }[] }[]> };
	const out: Record<string, string[]> = {};
	for (const [event, blocks] of Object.entries(parsed.hooks ?? {})) {
		out[event] = blocks.flatMap((b) => b.hooks.map((h) => h.command));
	}
	return out;
}

describe("CodexConnector", () => {
	it("extends the shared connector base and inherits install/uninstall", () => {
		const c = connector();
		expect(c).toBeInstanceOf(HarnessConnector);
		expect(c.harness).toBe("codex");
		const ownProps = Object.getOwnPropertyNames(CodexConnector.prototype);
		expect(ownProps).not.toContain("install");
		expect(ownProps).not.toContain("uninstall");
	});

	it("writes Codex hooks.json with valid native event names and commands", async () => {
		const fs = seedFs();
		const result = await connector(fs).install();

		expect(result.wroteConfig).toBe(true);
		expect(result.handlers).toContain(`${HOME}/.codex/plugins/honeycomb/bundle/session-start.js`);
		expect(result.handlers).toContain(`${HOME}/.codex/plugins/honeycomb/bundle/capture.js`);
		expect(result.handlers).toContain(`${HOME}/.codex/plugins/honeycomb/bundle/pre-tool-use.js`);

		const config = JSON.parse(fs.files.get(CONFIG) as string) as { hooks: Record<string, unknown> };
		for (const event of Object.keys(config.hooks)) {
			expect(isCodexEvent(event), `"${event}" is not a Codex hook event`).toBe(true);
		}
		expect(Object.keys(config.hooks)).toEqual(
			expect.arrayContaining(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]),
		);
		expect(() => assertCodexHooksConform(config)).not.toThrow();

		const commands = commandsByEvent(fs.files.get(CONFIG) as string);
		expect(commands.SessionStart.some((c) => c.includes("session-start.js"))).toBe(true);
		expect(commands.UserPromptSubmit.some((c) => c.includes("capture.js"))).toBe(true);
		expect(commands.PreToolUse.some((c) => c.includes("pre-tool-use.js"))).toBe(true);
	});

	it("preserves foreign hooks and uninstall removes only Honeycomb entries", async () => {
		const foreign = "node /opt/foreign/codex-hook.js";
		const fs = seedFs({
			files: {
				[CONFIG]: `${JSON.stringify(
					{ hooks: { SessionStart: [{ hooks: [{ type: "command", command: foreign }] }] } },
					null,
					2,
				)}\n`,
			},
		});

		await connector(fs).install();
		await connector(fs).uninstall();

		const after = commandsByEvent(fs.files.get(CONFIG) as string);
		expect(after.SessionStart).toEqual([foreign]);
		expect(after.PreToolUse).toBeUndefined();
	});

	it("detects Codex when ~/.codex exists and links skills into ~/.codex/skills", async () => {
		const fs = seedFs();
		const c = connector(fs, ["/repo/skills/org"]);
		expect((await c.detectPlatforms()).map((p) => p.harness)).toEqual(["codex"]);

		const result = await c.install();
		expect(result.skillLinks).toContain(`${HOME}/.codex/skills/org`);
		expect(fs.links.get(`${HOME}/.codex/skills/org`)).toBe("/repo/skills/org");
	});
});
