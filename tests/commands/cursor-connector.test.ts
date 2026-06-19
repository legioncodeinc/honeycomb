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
		// A real FLAT Cursor hook (the shape Cursor actually parses): the entry lives directly under
		// the event key, NOT in a Claude-Code-style nested matcher block.
		const foreign = {
			hooks: {
				sessionStart: [{ type: "command", command: "node /someone/else/hook.js" }],
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
		// Cursor's FLAT shape: each event value is the entry array directly (no nested `.hooks` block).
		const after = JSON.parse(fs.files.get(CONFIG)!) as { hooks: Record<string, { command: string }[]> };
		// The foreign hook survives byte-identical; no Honeycomb entry remains.
		const sessionStart = after.hooks.sessionStart ?? [];
		const commands = sessionStart.map((h) => h.command);
		expect(commands).toContain("node /someone/else/hook.js");
		expect(commands.some((cmd) => cmd.includes("honeycomb"))).toBe(false);
	});

	it("SECURITY: a foreign hook under a dangerous event key (__proto__/constructor) is PRESERVED, never silently dropped, and never pollutes Object.prototype", async () => {
		// Untrusted `~/.cursor/hooks.json` ingest: a foreign event key named `__proto__` (or
		// `constructor`) reaches `flatHooks`/`patchConfig`. If the accumulator were a plain `{}`,
		// `out[event] = entries` would assign through the prototype SETTER for `__proto__`, SILENTLY
		// DROPPING that foreign event (a foreign-preserve violation) — and worse, a crafted value
		// could attempt prototype pollution. The null-prototype accumulators keep the key as an OWN
		// data property (preserved, re-serialized) and make pollution impossible.
		// IMPORTANT: this must be a RAW JSON string, not a JS object literal — a `{__proto__: …}`
		// object literal sets the prototype (and JSON.stringify would NOT emit it), whereas a malicious
		// file on disk holds the LITERAL text `"__proto__"`, which `JSON.parse` turns into an OWN key.
		const hostileRaw = JSON.stringify({
			version: 1,
			hooks: {
				sessionStart: [{ type: "command", command: "node /foreign/normal.js" }],
			},
		});
		// Inject the dangerous keys textually so they land as OWN keys after JSON.parse.
		const hostile = hostileRaw.replace(
			'"hooks":{',
			'"hooks":{"__proto__":[{"type":"command","command":"node /foreign/proto-event.js"}],"constructor":[{"type":"command","command":"node /foreign/ctor-event.js"}],',
		);
		const fs = createFakeFs({
			files: {
				[CONFIG]: `${hostile}\n`,
				[`${BUNDLE}/session-start.js`]: "// s",
				[`${BUNDLE}/capture.js`]: "// c",
				[`${BUNDLE}/pre-tool-use.js`]: "// p",
				[`${BUNDLE}/session-end.js`]: "// e",
			},
		});
		const { c } = connector(fs);

		// No prototype pollution before, during, or after the round-trip.
		// biome-ignore lint/suspicious/noExplicitAny: probing Object.prototype for pollution is the point.
		expect(({} as any).command).toBeUndefined();

		await c.install();
		const afterInstall = fs.files.get(CONFIG)!;
		// The foreign hooks under the dangerous keys survive byte-for-byte through the flat merge.
		expect(afterInstall).toContain("/foreign/proto-event.js");
		expect(afterInstall).toContain("/foreign/ctor-event.js");
		expect(afterInstall).toContain("/foreign/normal.js");
		// biome-ignore lint/suspicious/noExplicitAny: pollution probe.
		expect(({} as any).command).toBeUndefined();

		await c.uninstall();
		const afterUninstall = fs.files.get(CONFIG)!;
		// Uninstall removes ONLY Honeycomb's entries; the foreign dangerous-key events still survive.
		expect(afterUninstall).toContain("/foreign/proto-event.js");
		expect(afterUninstall).toContain("/foreign/ctor-event.js");
		expect(afterUninstall).toContain("/foreign/normal.js");
		expect(afterUninstall.includes("honeycomb")).toBe(false);
		// biome-ignore lint/suspicious/noExplicitAny: pollution probe.
		expect(({} as any).command).toBeUndefined();
	});

	it("DoS: install/uninstall over adversarially malformed hooks.json shapes never throws", async () => {
		// The fix's whole point was a crash on a pre-existing flat config; harden against the rest of
		// the hostile shape space too. Every one of these must complete (no unhandled throw crashing
		// `honeycomb setup`), and a present foreign top-level key must survive.
		const malformedShapes: string[] = [
			'{"hooks":[1,2,3]}', // hooks as an array
			'{"hooks":"gotcha"}', // hooks as a string
			'{"hooks":null}', // hooks null
			'{"hooks":{"sessionStart":"x"}}', // event value a string
			'{"hooks":{"sessionStart":123}}', // event value a number
			'{"hooks":{"sessionStart":[null,42,"x",{"command":"node /keep.js"}]}}', // junk entries mixed with a real one
			'{"hooks":{"sessionStart":[{"hooks":[{"command":"node /nested.js"}]}]}}', // nested block (Claude shape)
		];
		for (const raw of malformedShapes) {
			const fs = createFakeFs({
				files: {
					[CONFIG]: raw,
					[`${BUNDLE}/session-start.js`]: "// s",
					[`${BUNDLE}/capture.js`]: "// c",
					[`${BUNDLE}/pre-tool-use.js`]: "// p",
					[`${BUNDLE}/session-end.js`]: "// e",
				},
			});
			const { c } = connector(fs);
			await expect(c.install(), `install must not throw over ${raw}`).resolves.toBeDefined();
			await expect(c.uninstall(), `uninstall must not throw over ${raw}`).resolves.toBeDefined();
		}
	});
});
