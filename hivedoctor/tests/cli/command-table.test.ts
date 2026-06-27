/**
 * Command-table tests (PRD-064f Scope; AC-064f.4 deferred-action enforcement).
 *
 * The command table is the single source for the dispatch surface AND the menu. These
 * tests freeze the binding rulings: self-update present, clear-credentials ABSENT.
 */

import { describe, expect, it } from "vitest";

import { COMMAND_MENU, KNOWN_COMMANDS, resolveCommand } from "../../src/cli/command-table.js";

describe("command table (PRD-064f)", () => {
	it("includes self-update (the sole self-update path, AC-064f.5)", () => {
		expect(KNOWN_COMMANDS.has("self-update")).toBe(true);
	});

	it("does NOT include clear-credentials (deferred, OD-4 / AC-064f.4)", () => {
		expect(KNOWN_COMMANDS.has("clear-credentials")).toBe(false);
		expect(COMMAND_MENU.some((e) => (e.invocation as string) === "clear-credentials")).toBe(false);
	});

	it("lists every PRD-064f command", () => {
		for (const cmd of [
			"status",
			"diagnose",
			"heal",
			"restart",
			"reinstall",
			"uninstall-hivemind",
			"update",
			"self-update",
			"install-service",
			"uninstall-service",
			"logs",
		]) {
			expect(KNOWN_COMMANDS.has(cmd)).toBe(true);
		}
	});

	it("resolveCommand maps known tokens and rejects unknown/empty", () => {
		expect(resolveCommand("status")).toBe("status");
		expect(resolveCommand("  diagnose  ")).toBe("diagnose");
		expect(resolveCommand("clear-credentials")).toBeNull();
		expect(resolveCommand("nonsense")).toBeNull();
		expect(resolveCommand(undefined)).toBeNull();
		expect(resolveCommand("")).toBeNull();
	});

	it("every menu entry has a non-empty summary", () => {
		for (const e of COMMAND_MENU) {
			expect(e.summary.length).toBeGreaterThan(0);
		}
	});
});
