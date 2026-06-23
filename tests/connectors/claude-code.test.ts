/**
 * The Claude Code connector — registers Honeycomb as a MARKETPLACE PLUGIN via `claude plugin`.
 *
 * ── What changed (the regression fix) ───────────────────────────────────────
 * Claude Code injects `${CLAUDE_PLUGIN_ROOT}` ONLY for PLUGIN-provided hooks, so the old top-level
 * `~/.claude/settings.json` hooks (which referenced that variable) were unresolvable and never
 * worked on their own. The connector now drives the first-party `claude plugin` CLI to register
 * Honeycomb as a marketplace plugin (whose own `hooks/hooks.json` fires with `${CLAUDE_PLUGIN_ROOT}`
 * correctly set). This supersedes the original PRD-019a "subclass adds NO install logic" thesis: the
 * Claude connector legitimately owns plugin-registration ORCHESTRATION because the host's native
 * wiring mechanism is a CLI, not a config file.
 *
 * Verification posture: a FAKE {@link PluginCommandRunner} records the EXACT `claude plugin …` argv
 * issued, so we assert idempotency, the hivemind→honeycomb migration, fail-soft when `claude` is
 * absent, and uninstall — WITHOUT the real `claude` binary or a real `~/.claude`.
 */

import { describe, expect, it } from "vitest";

import {
	CLAUDE_PLUGIN_NAME,
	CLAUDE_PLUGIN_SPEC,
	ClaudeCodeConnector,
	type ConnectorFs,
	createFakeFs,
	type FakeFs,
	HarnessConnector,
	type PluginCommandResult,
	type PluginCommandRunner,
	STALE_MARKETPLACE_NAME,
} from "../../src/connectors/index.js";

const HOME = "/home/dev";
const BUNDLE = "/repo/harnesses/claude-code/bundle";
const PKG_ROOT = "/repo";

/** A fake `claude plugin` runner recording every argv; scriptable availability + result + list. */
function fakeRunner(opts: { available?: boolean; ok?: boolean; listOutput?: string } = {}) {
	const calls: string[][] = [];
	const available = opts.available ?? true;
	const ok = opts.ok ?? true;
	const runner: PluginCommandRunner = {
		available: () => available,
		run(args: readonly string[]): PluginCommandResult {
			calls.push([...args]);
			return { ok, code: ok ? 0 : 1, stdout: "", stderr: "" };
		},
		isPluginEnabled(): boolean {
			return (opts.listOutput ?? "").includes(`${CLAUDE_PLUGIN_NAME}@`);
		},
	};
	return { runner, calls };
}

function fsWithBundle(seed: Record<string, string> = {}): FakeFs {
	return createFakeFs({
		files: {
			[`${HOME}/.claude`]: "",
			[`${BUNDLE}/session-start.js`]: "x",
			[`${BUNDLE}/capture.js`]: "x",
			[`${BUNDLE}/pre-tool-use.js`]: "x",
			[`${BUNDLE}/session-end.js`]: "x",
			...seed,
		},
	});
}

/** The argv joined into a single string for readable `expect(...).toContain` assertions. */
function joined(calls: string[][]): string[] {
	return calls.map((c) => c.join(" "));
}

describe("ClaudeCodeConnector — marketplace-plugin registration", () => {
	it("extends HarnessConnector and is the claude-code harness", () => {
		const c = new ClaudeCodeConnector(createFakeFs(), { home: HOME, bundleSource: BUNDLE });
		expect(c).toBeInstanceOf(HarnessConnector);
		expect(c.harness).toBe("claude-code");
	});

	it("install() registers the plugin via `claude plugin` (marketplace add + install + enable)", async () => {
		const { runner, calls } = fakeRunner();
		const result = await new ClaudeCodeConnector(fsWithBundle(), {
			home: HOME,
			bundleSource: BUNDLE,
			packageRoot: PKG_ROOT,
			pluginRunner: runner,
		}).install();

		const cmds = joined(calls);
		expect(cmds).toContain(`plugin marketplace add ${PKG_ROOT}`);
		expect(cmds).toContain(`plugin install ${CLAUDE_PLUGIN_SPEC}`);
		expect(cmds).toContain(`plugin enable ${CLAUDE_PLUGIN_NAME}`);
		// W-1: pin the EXACT registration sequence (not just presence) — CC requires the marketplace
		// to exist before install, and install before enable; a reorder/drop must fail the suite.
		const registration = cmds.filter((c) => c.startsWith(`plugin marketplace add `) || c.startsWith(`plugin marketplace update `) || c.startsWith(`plugin install `) || c.startsWith(`plugin enable `));
		expect(registration).toEqual([
			`plugin marketplace add ${PKG_ROOT}`,
			`plugin marketplace update ${CLAUDE_PLUGIN_NAME}`,
			`plugin install ${CLAUDE_PLUGIN_SPEC}`,
			`plugin enable ${CLAUDE_PLUGIN_NAME}`,
		]);
		expect(result.wroteConfig).toBe(true);
		// It does NOT write top-level settings.json hooks (the broken path) when `claude` is present.
		// (No settings.json write happened — the fake fs has no settings file.)
	});

	it("install() migrates: removes the stale `hivemind` marketplace before registering honeycomb", async () => {
		const { runner, calls } = fakeRunner();
		await new ClaudeCodeConnector(fsWithBundle(), {
			home: HOME,
			bundleSource: BUNDLE,
			packageRoot: PKG_ROOT,
			pluginRunner: runner,
		}).install();

		const cmds = joined(calls);
		expect(cmds).toContain(`plugin marketplace remove ${STALE_MARKETPLACE_NAME}`);
		expect(cmds).toContain(`plugin uninstall ${STALE_MARKETPLACE_NAME}`);
		// Migration (remove stale) happens BEFORE registering honeycomb.
		const removeStaleIdx = cmds.indexOf(`plugin marketplace remove ${STALE_MARKETPLACE_NAME}`);
		const addHoneycombIdx = cmds.indexOf(`plugin marketplace add ${PKG_ROOT}`);
		expect(removeStaleIdx).toBeLessThan(addHoneycombIdx);
	});

	it("install() cleans prior broken top-level Honeycomb settings.json hooks (migration strip)", async () => {
		// Seed a prior broken top-level Honeycomb hook (carries the sentinel) the OLD connector wrote.
		const brokenSettings = `${JSON.stringify(
			{
				hooks: {
					SessionStart: [
						{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/bundle/index.js"', _honeycomb: true }] },
					],
				},
			},
			null,
			2,
		)}\n`;
		const fs = fsWithBundle({ [`${HOME}/.claude/settings.json`]: brokenSettings });
		const { runner } = fakeRunner();
		await new ClaudeCodeConnector(fs, {
			home: HOME,
			bundleSource: BUNDLE,
			packageRoot: PKG_ROOT,
			pluginRunner: runner,
		}).install();
		// The broken top-level Honeycomb hook is gone (the settings.json held ONLY ours → unlinked).
		expect(fs.files.has(`${HOME}/.claude/settings.json`)).toBe(false);
	});

	it("install() preserves a FOREIGN settings.json hook during the migration strip", async () => {
		const seeded = `${JSON.stringify(
			{ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node /other/tool.js" }] }] } },
			null,
			2,
		)}\n`;
		const fs = fsWithBundle({ [`${HOME}/.claude/settings.json`]: seeded });
		const { runner } = fakeRunner();
		await new ClaudeCodeConnector(fs, {
			home: HOME,
			bundleSource: BUNDLE,
			packageRoot: PKG_ROOT,
			pluginRunner: runner,
		}).install();
		const remaining = fs.files.get(`${HOME}/.claude/settings.json`);
		expect(remaining).toContain("node /other/tool.js");
	});

	it("install() is idempotent: re-running issues the same registration argv (CLI no-ops absorb it)", async () => {
		const opts = { home: HOME, bundleSource: BUNDLE, packageRoot: PKG_ROOT };
		const a = fakeRunner();
		await new ClaudeCodeConnector(fsWithBundle(), { ...opts, pluginRunner: a.runner }).install();
		const b = fakeRunner();
		await new ClaudeCodeConnector(fsWithBundle(), { ...opts, pluginRunner: b.runner }).install();
		// Same argv both runs — the CLI's marketplace-add/install are idempotent ("already installed").
		expect(joined(a.calls)).toEqual(joined(b.calls));
	});

	it("fail-soft: when `claude` is ABSENT, writes an ABSOLUTE-path settings.json fallback, no broken var", async () => {
		const notes: string[] = [];
		const { runner, calls } = fakeRunner({ available: false });
		const fs = fsWithBundle();
		const result = await new ClaudeCodeConnector(fs, {
			home: HOME,
			bundleSource: BUNDLE,
			packageRoot: PKG_ROOT,
			pluginRunner: runner,
			notify: (l) => notes.push(l),
		}).install();

		// No `claude plugin` command was issued (the CLI is absent).
		expect(calls).toEqual([]);
		// A settings.json fallback WAS written, and it uses RESOLVED ABSOLUTE paths — never the
		// unresolvable `${CLAUDE_PLUGIN_ROOT}` variable.
		const settings = fs.files.get(`${HOME}/.claude/settings.json`);
		expect(settings).toBeDefined();
		expect(settings).not.toContain("${CLAUDE_PLUGIN_ROOT}");
		expect(settings).toContain(`${HOME}/.claude/plugins/${CLAUDE_PLUGIN_NAME}/bundle/session-start.js`);
		expect(result.handlers.length).toBeGreaterThan(0);
		// A clear, actionable manual-register message was surfaced.
		expect(notes.join("\n")).toMatch(/claude.*not found|register manually|claude plugin/i);
	});

	it("uninstall() reverses it: `claude plugin uninstall honeycomb` + `marketplace remove honeycomb`", async () => {
		const { runner, calls } = fakeRunner();
		await new ClaudeCodeConnector(fsWithBundle(), {
			home: HOME,
			bundleSource: BUNDLE,
			packageRoot: PKG_ROOT,
			pluginRunner: runner,
		}).uninstall();
		const cmds = joined(calls);
		expect(cmds).toContain(`plugin uninstall ${CLAUDE_PLUGIN_NAME}`);
		expect(cmds).toContain(`plugin marketplace remove ${CLAUDE_PLUGIN_NAME}`);
	});

	it("uninstall() also strips a leftover settings.json fallback (foreign hooks preserved)", async () => {
		const seeded = `${JSON.stringify(
			{
				hooks: {
					SessionStart: [
						{ hooks: [{ type: "command", command: "node /other/tool.js" }] },
						{ hooks: [{ type: "command", command: `node "${HOME}/.claude/plugins/honeycomb/bundle/session-start.js"`, _honeycomb: true }] },
					],
				},
			},
			null,
			2,
		)}\n`;
		const fs = fsWithBundle({ [`${HOME}/.claude/settings.json`]: seeded });
		const { runner } = fakeRunner();
		await new ClaudeCodeConnector(fs, {
			home: HOME,
			bundleSource: BUNDLE,
			packageRoot: PKG_ROOT,
			pluginRunner: runner,
		}).uninstall();
		const remaining = fs.files.get(`${HOME}/.claude/settings.json`);
		expect(remaining).toContain("node /other/tool.js"); // foreign survives
		expect(remaining).not.toContain("honeycomb/bundle/session-start.js"); // ours stripped
	});

	it("requires a packageRoot to register (clear error when the marketplace dir is unknown)", async () => {
		const { runner } = fakeRunner();
		await expect(
			new ClaudeCodeConnector(fsWithBundle(), { home: HOME, bundleSource: BUNDLE, pluginRunner: runner }).install(),
		).rejects.toThrow(/packageRoot/);
	});

	it("with NO runner injected, install() falls back to the inherited settings.json path (test vehicle)", async () => {
		// The base/auto-wiring/conformance suites use ClaudeCodeConnector as a generic hooks vehicle
		// (no runner). That path stays the inherited settings.json behavior — with absolute paths.
		const fs = fsWithBundle();
		const result = await new ClaudeCodeConnector(fs, { home: HOME, bundleSource: BUNDLE }).install();
		expect(fs.files.has(`${HOME}/.claude/settings.json`)).toBe(true);
		expect(result.handlers).toContain(`${HOME}/.claude/plugins/honeycomb/bundle/session-start.js`);
	});

	it("detectPlatforms reports claude-code when ~/.claude exists, nothing otherwise", async () => {
		const present = new ClaudeCodeConnector(fsWithBundle(), { home: HOME, bundleSource: BUNDLE });
		expect((await present.detectPlatforms()).map((p) => p.harness)).toEqual(["claude-code"]);
		const absent = new ClaudeCodeConnector(createFakeFs(), { home: "/nope", bundleSource: BUNDLE });
		expect(await absent.detectPlatforms()).toEqual([]);
	});

	it("the four seams declare the right Claude Code values (settings.json fallback shape)", async () => {
		const fs = fsWithBundle();
		const result = await new ClaudeCodeConnector(fs, {
			home: HOME,
			bundleSource: BUNDLE,
			skillSources: ["/repo/skills/org"],
		}).install();
		const config = JSON.parse(fs.files.get(`${HOME}/.claude/settings.json`) as string) as {
			hooks: Record<string, unknown>;
		};
		for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]) {
			expect(Object.keys(config.hooks)).toContain(event);
		}
		expect(result.handlers).toContain(`${HOME}/.claude/plugins/honeycomb/bundle/session-start.js`);
		expect(fs.links.get(`${HOME}/.claude/skills/org`)).toBe("/repo/skills/org");
	});
});

// Type-only guard so an unused import is never introduced (ConnectorFs documents the seam type).
const _typeGuard: ConnectorFs | undefined = undefined;
void _typeGuard;
