/**
 * PRD-020d auto-wiring — d-AC-6: an unchanged config → no write, fingerprint stable.
 *
 * The engine DELEGATES to a real 019a `HarnessConnector` over a `createFakeFs` (D-4 — no forked
 * merge engine). This drives the idempotency end to end: a first `wire()` writes the config; a
 * second `wire()` over the SAME fs finds the byte-identical config and writes NOTHING, so the
 * hook-trust fingerprint is unchanged (d-AC-6). `unwire()` reverses cleanly.
 */

import { describe, expect, it } from "vitest";

import { ClaudeCodeConnector, createFakeFs } from "../../src/connectors/index.js";
import { createAutoWiring } from "../../src/notifications/index.js";

const HOME = "/home/dev";
const BUNDLE = "/repo/harnesses/claude-code/bundle";
const CONFIG = `${HOME}/.claude/settings.json`;

function fixture(seedFiles: Record<string, string> = {}) {
	const fs = createFakeFs({
		files: {
			[`${HOME}/.claude`]: "",
			[`${BUNDLE}/session-start.js`]: "x",
			[`${BUNDLE}/capture.js`]: "x",
			[`${BUNDLE}/pre-tool-use.js`]: "x",
			[`${BUNDLE}/session-end.js`]: "x",
			...seedFiles,
		},
	});
	const connector = new ClaudeCodeConnector(fs, { home: HOME, bundleSource: BUNDLE });
	const wiring = createAutoWiring({ connector });
	return { fs, wiring };
}

describe("d-AC-6: unchanged config → no write, fingerprint stable", () => {
	it("d-AC-6 the first wire() writes the config (true); a second wire() is a no-op (false)", async () => {
		const { fs, wiring } = fixture();

		const firstWrote = await wiring.wire();
		expect(firstWrote).toBe(true); // the config was created.

		const fingerprint = fs.files.get(CONFIG);
		const writesAfterFirst = fs.writes.filter((p) => p === CONFIG).length;

		const secondWrote = await wiring.wire();
		expect(secondWrote).toBe(false); // unchanged config → NOT rewritten (idempotent, d-AC-6).

		// No additional write to the config landed, and the bytes are unchanged → stable fingerprint.
		expect(fs.writes.filter((p) => p === CONFIG).length).toBe(writesAfterFirst);
		expect(fs.files.get(CONFIG)).toBe(fingerprint);
	});

	it("d-AC-6 wire() is idempotent across many runs (the fingerprint never drifts)", async () => {
		const { fs, wiring } = fixture();
		await wiring.wire();
		const fingerprint = fs.files.get(CONFIG);
		for (let i = 0; i < 3; i++) {
			expect(await wiring.wire()).toBe(false);
		}
		expect(fs.files.get(CONFIG)).toBe(fingerprint);
	});

	it("reversible: unwire() strips Honeycomb's hooks (the config is removed when emptied)", async () => {
		const { fs, wiring } = fixture();
		await wiring.wire();
		expect(fs.files.has(CONFIG)).toBe(true);

		await wiring.unwire();
		// The config held ONLY Honeycomb's hooks → it is cleanly unlinked, never left as `{}`.
		expect(fs.files.has(CONFIG)).toBe(false);
	});

	it("foreign-preserve: unwire() keeps a foreign hook entry", async () => {
		const foreign = `${JSON.stringify(
			{ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node /other/tool.js" }] }] } },
			null,
			2,
		)}\n`;
		const { fs, wiring } = fixture({ [CONFIG]: foreign });
		await wiring.wire();
		await wiring.unwire();
		// The foreign tool survives the uninstall (only Honeycomb's hooks are stripped).
		const remaining = fs.files.get(CONFIG);
		expect(remaining).toBeDefined();
		expect(remaining).toContain("node /other/tool.js");
		expect(remaining).not.toContain("bundle/session-start.js");
	});
});
