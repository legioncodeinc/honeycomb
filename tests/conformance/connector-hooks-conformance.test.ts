/**
 * HARNESS-CONTRACT CONFORMANCE — the references gate, now EXECUTABLE.
 *
 * ── Why this suite exists ────────────────────────────────────────────────────
 * PRDs 019a/020c/020d cited each harness's `hooks.json` protocol as a "references gate =
 * documented CONVENTION" (D-3). No `references/<harness>/` repo existed, so the gate was never
 * machine-checkable: the 019a unit tests (`tests/connectors/connector-base.test.ts`) only assert
 * that "an entry was added", never that the emitted config matches what the REAL harness accepts.
 * A typo'd or renamed event name, or a merge that produces a structure the harness rejects, would
 * sail through them and silently break that harness on a real user install.
 *
 * This suite closes that gap. It runs the REAL connectors (`ClaudeCodeConnector`,
 * `CursorConnector`) through their REAL 019a install path over the in-memory {@link createFakeFs}
 * seam (so no real `~/.claude` / `~/.cursor` is touched — same pattern as the base test), captures
 * the emitted hook config, and validates it against an INDEPENDENT zod oracle that encodes the
 * EXTERNAL harness protocol (`references/claude-code/hooks-schema.ts`,
 * `references/cursor/hooks-schema.ts`). The schemas are NOT relaxed to make a connector pass: a
 * connector that emits a non-conformant config is REPORTED as a finding (see the Cursor block).
 *
 * Per harness:
 *   - event-name validity: every event the connector writes is one the harness ACTUALLY accepts;
 *   - structural conformance: the emitted entry shape parses (unknown/missing required → fail);
 *   - foreign-preserve under a REALISTIC seeded config: a real-shaped third-party hook survives
 *     byte-identical, the merged whole still conforms, and uninstall restores the foreign-only
 *     config (still conformant);
 *   - schema-level idempotency: re-install produces a still-conformant, unchanged config.
 */

import { describe, expect, it } from "vitest";

import {
	assertClaudeCodeHooksConform,
	CLAUDE_CODE_EVENT_NAMES,
	claudeCodeSettings,
	isClaudeCodeEvent,
} from "../../references/claude-code/hooks-schema.js";
import {
	assertCursorHooksConform,
	CURSOR_EVENT_NAMES,
	cursorHooksEntryArray,
	cursorHooksFile,
	isCursorEvent,
	looksLikeNestedMatcherBlocks,
} from "../../references/cursor/hooks-schema.js";
import { ClaudeCodeConnector, CursorConnector } from "../../src/connectors/index.js";
import {
	commandsByEvent,
	flatCommandsByEvent,
	foreignHookEntry,
	parseEmittedConfig,
	seedHandlerBundle,
} from "./harness-conformance-helpers.js";

// ─────────────────────────────────────────────────────────────────────────────
// Claude Code — emits the native settings.json#hooks lingua franca it accepts.
// ─────────────────────────────────────────────────────────────────────────────

describe("conformance: ClaudeCodeConnector emits a config the REAL Claude Code harness accepts", () => {
	const HOME = "/home/dev";
	const SETTINGS = `${HOME}/.claude/settings.json`;
	const BUNDLE = "/repo/harnesses/claude-code/bundle";
	const PROOF = `${HOME}/.claude`;

	const build = (fs: ReturnType<typeof seedHandlerBundle>, skillSources: readonly string[] = []) =>
		new ClaudeCodeConnector(fs, { home: HOME, bundleSource: BUNDLE, skillSources });

	it("every event key the connector writes is an event Claude Code ACTUALLY accepts", async () => {
		const fs = seedHandlerBundle(BUNDLE, PROOF);
		await build(fs).install();

		const config = parseEmittedConfig(fs.files.get(SETTINGS));
		const events = Object.keys((config as { hooks: Record<string, unknown> }).hooks);

		expect(events.length).toBeGreaterThan(0);
		for (const event of events) {
			expect(isClaudeCodeEvent(event), `"${event}" is not a real Claude Code event`).toBe(true);
		}
		// And the specific six Honeycomb registers under are all valid native names.
		expect(events).toEqual(
			expect.arrayContaining(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionEnd"]),
		);
	});

	it("the emitted entry STRUCTURE conforms to the harness schema (parse succeeds)", async () => {
		const fs = seedHandlerBundle(BUNDLE, PROOF);
		await build(fs).install();

		const config = parseEmittedConfig(fs.files.get(SETTINGS));
		// The full assert: structure parses AND every event key is a real harness event.
		expect(() => assertClaudeCodeHooksConform(config)).not.toThrow();

		// Every handler carries the required `type` + `command` the harness needs.
		const settings = claudeCodeSettings.parse(config);
		for (const blocks of Object.values(settings.hooks ?? {})) {
			for (const block of blocks) {
				for (const h of block.hooks) {
					expect(h.type).toBe("command");
					expect(typeof h.command).toBe("string");
					expect((h.command as string).length).toBeGreaterThan(0);
				}
			}
		}
	});

	it("a missing required field (command) is REJECTED by the oracle (the schema actually bites)", () => {
		// Negative control: prove the oracle fails a malformed entry rather than rubber-stamping.
		const malformed = { hooks: { SessionStart: [{ hooks: [{ type: "command" /* no command */ }] }] } };
		expect(() => assertClaudeCodeHooksConform(malformed)).toThrow();
	});

	it("a typo'd event name is REJECTED by the oracle (the rename/typo catch)", () => {
		const typo = { hooks: { SessionStarted: [{ hooks: [{ type: "command", command: "node x.js" }] }] } };
		expect(() => assertClaudeCodeHooksConform(typo)).toThrow(/not an event name/);
	});

	it("foreign-preserve: a realistic third-party hook survives + the merged whole conforms", async () => {
		const foreign = foreignHookEntry();
		// Seed a realistic, harness-conformant third-party hook under a real event.
		const seeded = `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [foreign] }] } }, null, 2)}\n`;
		const fs = seedHandlerBundle(BUNDLE, PROOF, { files: { [SETTINGS]: seeded } });

		// The seeded foreign-only config must itself conform (sanity: our fixture is realistic).
		expect(() => assertClaudeCodeHooksConform(JSON.parse(seeded))).not.toThrow();

		await build(fs).install();
		const merged = parseEmittedConfig(fs.files.get(SETTINGS));

		// (a) the foreign entry survives byte-identical.
		const after = commandsByEvent(merged);
		expect(after.PreToolUse).toContain(foreign.command);
		// (b) Honeycomb's own pre-tool handler landed alongside it.
		expect(after.PreToolUse.some((c) => c.includes("pre-tool-use.js"))).toBe(true);
		// (c) the MERGED whole still conforms — Honeycomb did not produce a config the harness rejects.
		expect(() => assertClaudeCodeHooksConform(merged)).not.toThrow();
	});

	it("foreign-preserve: uninstall restores the foreign-only config and it still conforms", async () => {
		const foreign = foreignHookEntry();
		const seeded = `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [foreign] }] } }, null, 2)}\n`;
		const fs = seedHandlerBundle(BUNDLE, PROOF, { files: { [SETTINGS]: seeded } });

		await build(fs).install();
		await build(fs).uninstall();

		// The config still exists (foreign hook remains) and conforms; no Honeycomb event survives.
		const restored = parseEmittedConfig(fs.files.get(SETTINGS));
		expect(() => assertClaudeCodeHooksConform(restored)).not.toThrow();
		const after = commandsByEvent(restored);
		expect(after.PreToolUse).toEqual([foreign.command]);
		expect(after.SessionStart).toBeUndefined();
		expect(after.SessionEnd).toBeUndefined();
	});

	it("schema-level idempotency: re-install produces a still-conformant, unchanged config", async () => {
		const fs = seedHandlerBundle(BUNDLE, PROOF);
		await build(fs).install();
		const first = fs.files.get(SETTINGS) as string;

		const second = await build(fs).install();

		expect(second.wroteConfig).toBe(false); // no-change re-install touches nothing
		const reparsed = parseEmittedConfig(fs.files.get(SETTINGS));
		expect(() => assertClaudeCodeHooksConform(reparsed)).not.toThrow();
		expect(fs.files.get(SETTINGS)).toBe(first); // byte-identical fingerprint
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Cursor — the connector OVERRIDES the config-shape seams so it emits + merges the
// REAL Cursor FLAT per-event entry array (`hooks[event] = [{ command, type?, … }]`),
// NOT the Claude-Code-style nested matcher block. This block asserts the emitted
// config CONFORMS to `references/cursor/hooks-schema.ts` (flat + valid event names +
// schema-valid), preserves a realistic FLAT foreign hook, is idempotent and
// reversible, and does NOT crash over a pre-existing flat config (bug #2 regression).
// The negative controls (typo'd event / malformed entry) still bite — the oracle is
// never relaxed to make the connector pass.
// ─────────────────────────────────────────────────────────────────────────────

describe("conformance: CursorConnector against the REAL Cursor hooks.json contract", () => {
	const HOME = "/home/dev";
	const HOOKS = `${HOME}/.cursor/hooks.json`;
	const BUNDLE = "/repo/harnesses/cursor/bundle";
	const PROOF = `${HOME}/.cursor`;

	const build = (fs: ReturnType<typeof seedHandlerBundle>, skillSources: readonly string[] = []) =>
		new CursorConnector(fs, { home: HOME, bundleSource: BUNDLE, skillSources });

	it("every event key the connector writes is an event Cursor ACTUALLY accepts", async () => {
		const fs = seedHandlerBundle(BUNDLE, PROOF);
		await build(fs).install();

		const config = parseEmittedConfig(fs.files.get(HOOKS));
		const events = Object.keys((config as { hooks: Record<string, unknown> }).hooks);

		expect(events.length).toBeGreaterThan(0);
		for (const event of events) {
			expect(isCursorEvent(event), `"${event}" is not a real Cursor event`).toBe(true);
		}
		// The six native Cursor events the connector maps to are all valid — incl. the
		// pre-tool → beforeShellExecution mapping (Cursor's shell-command gate).
		expect(events).toEqual(
			expect.arrayContaining([
				"sessionStart",
				"beforeSubmitPrompt",
				"beforeShellExecution",
				"postToolUse",
				"stop",
				"sessionEnd",
			]),
		);
	});

	it("the emitted config CONFORMS to the REAL Cursor hooks.json contract (flat + schema-valid)", async () => {
		const fs = seedHandlerBundle(BUNDLE, PROOF);
		await build(fs).install();

		const config = parseEmittedConfig(fs.files.get(HOOKS));
		const hooks = (config as { hooks: Record<string, unknown> }).hooks;

		// (a) every event value is a FLAT entry array, NOT a Claude-Code-style nested matcher block.
		for (const [event, value] of Object.entries(hooks)) {
			expect(looksLikeNestedMatcherBlocks(value), `${event} must be a FLAT entry array, not nested`).toBe(false);
			expect(() => cursorHooksEntryArray.parse(value), `${event} must parse as a flat entry array`).not.toThrow();
		}
		// (b) the full-file assert passes: structure conforms AND every event key is a real event.
		expect(() => assertCursorHooksConform(config)).not.toThrow();

		// (c) every emitted Honeycomb entry carries the required `command` + the sentinel, and the
		// pre-tool → beforeShellExecution gate carries Cursor's `Shell` matcher.
		const flat = cursorHooksFile.parse(config);
		for (const entries of Object.values(flat.hooks ?? {})) {
			for (const e of entries) {
				expect(typeof e.command).toBe("string");
				expect((e.command as string).length).toBeGreaterThan(0);
				expect((e as { _honeycomb?: unknown })._honeycomb).toBe(true);
			}
		}
		const shellGate = (flat.hooks ?? {}).beforeShellExecution ?? [];
		expect(shellGate.length).toBeGreaterThan(0);
		expect(shellGate.every((e) => (e as { matcher?: unknown }).matcher === "Shell")).toBe(true);
		// And Honeycomb's pre-tool handler is the one that landed under the shell gate.
		expect(shellGate.some((e) => (e.command as string).includes("pre-tool-use.js"))).toBe(true);
	});

	it("a typo'd Cursor event name is REJECTED by the oracle (the rename/typo catch)", () => {
		const typo = { hooks: { sessionStarted: [{ command: "node x.js" }] } };
		expect(() => assertCursorHooksConform(typo)).toThrow(/not an event name/);
	});

	it("a malformed FLAT entry (missing required command) is REJECTED by the oracle (it bites)", () => {
		// Negative control: a flat entry with no `command` must fail the flat-entry-array schema.
		const malformed = { hooks: { sessionStart: [{ type: "command" /* no command */ }] } };
		expect(() => assertCursorHooksConform(malformed)).toThrow();
	});

	it("a real FLAT-shaped Cursor config conforms (proves the oracle accepts valid Cursor config)", () => {
		// Positive control in the REAL Cursor shape: a flat array of entries per event.
		const real = {
			version: 1,
			hooks: {
				beforeShellExecution: [{ command: "node hook.js", type: "command", timeout: 60 }],
				sessionStart: [{ command: "node start.js" }],
			},
		};
		expect(() => assertCursorHooksConform(real)).not.toThrow();
		// And each event value is a flat entry array, not a nested matcher block.
		for (const value of Object.values(real.hooks)) {
			expect(() => cursorHooksEntryArray.parse(value)).not.toThrow();
			expect(looksLikeNestedMatcherBlocks(value)).toBe(false);
		}
	});

	it(
		"foreign-preserve: a realistic FLAT third-party Cursor hook survives byte-identical + the " +
			"merged whole conforms (the connector emits the flat shape Cursor reads)",
		async () => {
			// A realistic foreign Cursor hook in the REAL flat shape, under a real Cursor event — exactly
			// what a Cursor user who already configured hooks would have on disk. Carries NO sentinel.
			const foreign = { command: "node /opt/acme/cursor-guard.js", type: "command", timeout: 15 };
			const seeded = `${JSON.stringify({ hooks: { beforeShellExecution: [foreign] } }, null, 2)}\n`;
			// Sanity: the seeded foreign-only config itself conforms to the REAL Cursor schema.
			expect(() => assertCursorHooksConform(JSON.parse(seeded))).not.toThrow();

			const fs = seedHandlerBundle(BUNDLE, PROOF, { files: { [HOOKS]: seeded } });
			await build(fs).install();
			const merged = parseEmittedConfig(fs.files.get(HOOKS));

			// (a) the foreign FLAT entry survives byte-identical, alongside Honeycomb's own entry.
			const after = flatCommandsByEvent(merged);
			expect(after.beforeShellExecution).toContain(foreign.command);
			expect(after.beforeShellExecution.some((c) => c.includes("pre-tool-use.js"))).toBe(true);
			// The foreign entry is preserved with ALL its fields (not just its command) — byte-identical.
			const flatMerged = cursorHooksFile.parse(merged);
			const survivor = (flatMerged.hooks ?? {}).beforeShellExecution?.find((e) => e.command === foreign.command);
			expect(survivor).toEqual(foreign);
			// (b) the MERGED whole conforms — Honeycomb did not produce a config Cursor rejects.
			expect(() => assertCursorHooksConform(merged)).not.toThrow();
		},
	);

	it("foreign-preserve: uninstall restores the FLAT foreign-only config and it still conforms", async () => {
		const foreign = { command: "node /opt/acme/cursor-guard.js", type: "command", timeout: 15 };
		const seeded = `${JSON.stringify({ hooks: { beforeShellExecution: [foreign] } }, null, 2)}\n`;
		const fs = seedHandlerBundle(BUNDLE, PROOF, { files: { [HOOKS]: seeded } });

		await build(fs).install();
		await build(fs).uninstall();

		// The config still exists (foreign hook remains) and conforms; no Honeycomb entry survives.
		const restored = parseEmittedConfig(fs.files.get(HOOKS));
		expect(() => assertCursorHooksConform(restored)).not.toThrow();
		const after = flatCommandsByEvent(restored);
		expect(after.beforeShellExecution).toEqual([foreign.command]);
		expect(after.sessionStart).toBeUndefined();
		expect(after.sessionEnd).toBeUndefined();
	});

	it("schema-level idempotency: re-install produces a still-conformant, unchanged FLAT config", async () => {
		const fs = seedHandlerBundle(BUNDLE, PROOF);
		await build(fs).install();
		const first = fs.files.get(HOOKS) as string;

		const second = await build(fs).install();

		expect(second.wroteConfig).toBe(false); // no-change re-install touches nothing
		expect(fs.files.get(HOOKS)).toBe(first); // byte-identical fingerprint
		const reparsed = parseEmittedConfig(fs.files.get(HOOKS));
		expect(() => assertCursorHooksConform(reparsed)).not.toThrow();
		// Event keys remain valid Cursor events after the no-op re-install.
		const events = Object.keys((reparsed as { hooks: Record<string, unknown> }).hooks);
		for (const event of events) expect(isCursorEvent(event)).toBe(true);
	});

	it(
		"REGRESSION (bug #2): install over a pre-existing FLAT Cursor hook does NOT throw and preserves it",
		async () => {
			// The exact crash repro from the original finding: a real FLAT Cursor entry (no `.hooks`).
			// The inherited base merge did `block.hooks.filter(...)` → `Cannot read properties of
			// undefined`. The Cursor override now merges the flat shape, so install completes cleanly.
			const foreign = { command: "node /opt/acme/cursor-guard.js", type: "command", timeout: 15 };
			const seeded = `${JSON.stringify({ hooks: { beforeShellExecution: [foreign] } }, null, 2)}\n`;
			const fs = seedHandlerBundle(BUNDLE, PROOF, { files: { [HOOKS]: seeded } });

			// Must NOT throw (the severe install-crash bug is closed).
			await expect(build(fs).install()).resolves.toBeDefined();

			// The pre-existing flat hook is preserved and the result conforms.
			const config = parseEmittedConfig(fs.files.get(HOOKS));
			expect(() => assertCursorHooksConform(config)).not.toThrow();
			expect(flatCommandsByEvent(config).beforeShellExecution).toContain(foreign.command);
		},
	);

	it(
		"crash-safe over an (unlikely) pre-existing NESTED Cursor config: install does NOT throw and " +
			"flattens the foreign handler forward",
		async () => {
			// Defensive: even if a config somehow holds a Claude-Code-shaped nested block, the Cursor
			// override flattens it forward rather than throwing — and the emitted config conforms.
			const foreign = { type: "command", command: "node /opt/acme/cursor-guard.js", timeout: 15 };
			const seeded = `${JSON.stringify({ hooks: { beforeShellExecution: [{ hooks: [foreign] }] } }, null, 2)}\n`;
			const fs = seedHandlerBundle(BUNDLE, PROOF, { files: { [HOOKS]: seeded } });

			await expect(build(fs).install()).resolves.toBeDefined();

			const config = parseEmittedConfig(fs.files.get(HOOKS));
			// The result is FLAT + conformant, and the foreign handler survived the flattening.
			expect(() => assertCursorHooksConform(config)).not.toThrow();
			expect(flatCommandsByEvent(config).beforeShellExecution).toContain(foreign.command);
		},
	);
});

// A guard so the imported event-name lists can't silently shrink to empty (which would make the
// membership checks vacuously pass).
describe("conformance: the vendored event-name oracles are non-empty", () => {
	it("Claude Code + Cursor event-name sets are populated", () => {
		expect(CLAUDE_CODE_EVENT_NAMES.length).toBeGreaterThanOrEqual(6);
		expect(CURSOR_EVENT_NAMES.length).toBeGreaterThanOrEqual(6);
	});
});
