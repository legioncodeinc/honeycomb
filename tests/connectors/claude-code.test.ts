/**
 * PRD-019a a-AC-5 — the Claude Code connector is a SUBCLASS overriding ONLY the four seams.
 *
 * The reference concrete connector proves the base is subclass-only (FR-1 / a-AC-5): a new
 * harness is a SMALL subclass that overrides config path, hook-handler set, skill-link targets,
 * and event-name map — NOT a copy-paste fork of install logic. This test asserts the shape:
 *   - the four seams are the connector's OWN declarations (right values);
 *   - install/uninstall are INHERITED verbatim from {@link HarnessConnector} (not redeclared);
 *   - the connector adds no install/patch/link method of its own.
 *
 * Verification posture: introspect the prototype chain + drive a real install over a
 * {@link createFakeFs}. No real `~/.claude`, no daemon.
 */

import { describe, expect, it } from "vitest";

import { ClaudeCodeConnector, createFakeFs, HarnessConnector } from "../../src/connectors/index.js";

const HOME = "/home/dev";
const BUNDLE = "/repo/harnesses/claude-code/bundle";

function fsWithBundle() {
	return createFakeFs({
		files: {
			[`${HOME}/.claude`]: "",
			[`${BUNDLE}/session-start.js`]: "x",
			[`${BUNDLE}/capture.js`]: "x",
			[`${BUNDLE}/pre-tool-use.js`]: "x",
			[`${BUNDLE}/session-end.js`]: "x",
		},
	});
}

describe("PRD-019a a-AC-5 — ClaudeCodeConnector subclasses the base, overrides only 4 seams", () => {
	it("a-AC-5 the connector extends HarnessConnector", () => {
		const c = new ClaudeCodeConnector(createFakeFs(), { home: HOME, bundleSource: BUNDLE });
		expect(c).toBeInstanceOf(HarnessConnector);
		expect(c.harness).toBe("claude-code");
	});

	it("a-AC-5 install/uninstall are INHERITED from the base, not redeclared on the subclass", () => {
		// The whole point of a-AC-5: the subclass adds NO install logic. install/uninstall live on
		// the base prototype, not on ClaudeCodeConnector's own prototype.
		const ownProps = Object.getOwnPropertyNames(ClaudeCodeConnector.prototype);
		expect(ownProps).not.toContain("install");
		expect(ownProps).not.toContain("uninstall");
		expect(ownProps).not.toContain("patchConfig");
		expect(ownProps).not.toContain("linkSkills");
		expect(ownProps).not.toContain("writeJsonIfChanged");
		// install/uninstall ARE reachable (inherited).
		expect(typeof new ClaudeCodeConnector(createFakeFs(), { home: HOME, bundleSource: BUNDLE }).install).toBe(
			"function",
		);
		expect(typeof new ClaudeCodeConnector(createFakeFs(), { home: HOME, bundleSource: BUNDLE }).uninstall).toBe(
			"function",
		);
	});

	it("a-AC-5 the subclass declares ONLY the seam overrides (plus its ctor/static helper)", () => {
		// Every own method on the subclass prototype must be one of the four seams, the optional
		// configRoot detection seam, the constructor, or the static helper — never install logic.
		const allowed = new Set([
			"constructor",
			"configPath",
			"hookHandlers",
			"skillLinkTargets",
			"eventNameMap",
			"configRoot",
		]);
		const own = Object.getOwnPropertyNames(ClaudeCodeConnector.prototype);
		for (const name of own) {
			expect(allowed.has(name), `unexpected own method on subclass: ${name}`).toBe(true);
		}
	});

	it("a-AC-5 the four seams declare the right Claude Code values", async () => {
		// Drive a real install so the seams' effects are observable through the base machinery.
		const fs = fsWithBundle();
		const result = await new ClaudeCodeConnector(fs, {
			home: HOME,
			bundleSource: BUNDLE,
			skillSources: ["/repo/skills/org"],
		}).install();

		// SEAM 1 — config path is `~/.claude/settings.json`.
		expect(fs.files.has(`${HOME}/.claude/settings.json`)).toBe(true);
		// SEAM 2 — handlers written under the plugin root's bundle dir.
		expect(result.handlers).toContain(`${HOME}/.claude/plugins/honeycomb/bundle/session-start.js`);
		// SEAM 4 — native event names appear as the config's hook keys.
		const config = JSON.parse(fs.files.get(`${HOME}/.claude/settings.json`) as string) as {
			hooks: Record<string, unknown>;
		};
		for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]) {
			expect(Object.keys(config.hooks)).toContain(event);
		}
		// SEAM 3 — the org skill is linked into `~/.claude/skills`.
		expect(fs.links.get(`${HOME}/.claude/skills/org`)).toBe("/repo/skills/org");
	});

	it("a-AC-5 detectPlatforms reports claude-code when ~/.claude exists, nothing otherwise", async () => {
		const present = new ClaudeCodeConnector(fsWithBundle(), { home: HOME, bundleSource: BUNDLE });
		expect((await present.detectPlatforms()).map((p) => p.harness)).toEqual(["claude-code"]);

		const absent = new ClaudeCodeConnector(createFakeFs(), { home: "/nope", bundleSource: BUNDLE });
		expect(await absent.detectPlatforms()).toEqual([]);
	});
});
