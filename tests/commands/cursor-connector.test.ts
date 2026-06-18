/**
 * PRD-020a (FR-6 / D-4) — the Cursor connector is a sibling of claude-code, install logic INHERITED.
 *
 * `honeycomb setup` wires Cursor through the `CursorConnector` (the 019a `HarnessConnector`
 * subclass landed by 020a). This suite proves the subclass-only seams (config path
 * `~/.cursor/hooks.json`, the cursor event names, skill dir) drive the INHERITED foreign-preserving
 * + idempotent install/uninstall — no second merge engine. Drives it against a `createFakeFs`
 * (no real `~`).
 */

import { describe, expect, it } from "vitest";

import { CursorConnector, createFakeFs } from "../../src/connectors/index.js";

const HOME = "/home/dev";
const BUNDLE = "/repo/harnesses/cursor/bundle";
const CONFIG = `${HOME}/.cursor/hooks.json`;

function connector(fs = createFakeFs(), skillSources: readonly string[] = []) {
	return {
		fs,
		c: new CursorConnector(fs, { home: HOME, bundleSource: BUNDLE, skillSources }),
	};
}

describe("PRD-020a — CursorConnector wires Cursor through the inherited 019a engine", () => {
	it("setup writes the cursor hooks.json under the native cursor event names", async () => {
		// Seed the bundle sources so the handler-copy step has bytes to write.
		const fs = createFakeFs({
			files: {
				[`${BUNDLE}/session-start.js`]: "// session-start",
				[`${BUNDLE}/capture.js`]: "// capture",
				[`${BUNDLE}/pre-tool-use.js`]: "// pre",
				[`${BUNDLE}/session-end.js`]: "// end",
			},
		});
		const { c } = connector(fs);
		const result = await c.install();
		expect(result.harness).toBe("cursor");
		expect(result.wroteConfig).toBe(true);

		const written = fs.files.get(CONFIG);
		expect(written).toBeDefined();
		const config = JSON.parse(written!) as { hooks: Record<string, unknown> };
		// The cursor-native event names the 019b cursor shim expects.
		expect(Object.keys(config.hooks)).toEqual(
			expect.arrayContaining(["sessionStart", "beforeSubmitPrompt", "beforeShellExecution", "postToolUse", "stop", "sessionEnd"]),
		);
	});

	it("install is idempotent — a no-change re-run writes the config NOTHING the second time", async () => {
		const fs = createFakeFs({
			files: {
				[`${BUNDLE}/session-start.js`]: "// s",
				[`${BUNDLE}/capture.js`]: "// c",
				[`${BUNDLE}/pre-tool-use.js`]: "// p",
				[`${BUNDLE}/session-end.js`]: "// e",
			},
		});
		const { c } = connector(fs);
		await c.install();
		const writesAfterFirst = fs.writes.filter((w) => w === CONFIG).length;
		const second = await c.install();
		expect(second.wroteConfig).toBe(false);
		const writesAfterSecond = fs.writes.filter((w) => w === CONFIG).length;
		expect(writesAfterSecond).toBe(writesAfterFirst);
	});

	it("install PRESERVES a foreign cursor hook and uninstall reverses ONLY Honeycomb's entries", async () => {
		const foreign = {
			hooks: {
				sessionStart: [{ hooks: [{ type: "command", command: "node /someone/else/hook.js" }] }],
			},
		};
		const fs = createFakeFs({
			files: {
				[CONFIG]: `${JSON.stringify(foreign, null, 2)}\n`,
				[`${BUNDLE}/session-start.js`]: "// s",
				[`${BUNDLE}/capture.js`]: "// c",
				[`${BUNDLE}/pre-tool-use.js`]: "// p",
				[`${BUNDLE}/session-end.js`]: "// e",
			},
		});
		const { c } = connector(fs);
		await c.install();
		await c.uninstall();
		const after = JSON.parse(fs.files.get(CONFIG)!) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
		// The foreign hook survives; no Honeycomb entry remains.
		const sessionStart = after.hooks.sessionStart ?? [];
		const commands = sessionStart.flatMap((b) => b.hooks.map((h) => h.command));
		expect(commands).toContain("node /someone/else/hook.js");
		expect(commands.some((cmd) => cmd.includes("honeycomb"))).toBe(false);
	});
});
