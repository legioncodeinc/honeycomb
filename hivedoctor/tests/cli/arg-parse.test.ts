/**
 * Hand-rolled arg parser tests (PRD-064f: built-in arg parsing, no framework).
 */

import { describe, expect, it } from "vitest";

import { parseArgs, hasFlag } from "../../src/cli/arg-parse.js";

describe("parseArgs", () => {
	it("treats the first positional as the command", () => {
		const p = parseArgs(["status"]);
		expect(p.command).toBe("status");
		expect(p.positionals).toEqual([]);
	});

	it("parses --flag as a boolean true", () => {
		const p = parseArgs(["update", "--check"]);
		expect(p.command).toBe("update");
		expect(p.flags.check).toBe(true);
	});

	it("parses --key=value as a string", () => {
		const p = parseArgs(["logs", "--lines=50"]);
		expect(p.flags.lines).toBe("50");
	});

	it("collects extra positionals after the command", () => {
		const p = parseArgs(["heal", "now", "--yes"]);
		expect(p.command).toBe("heal");
		expect(p.positionals).toEqual(["now"]);
		expect(p.flags.yes).toBe(true);
	});

	it("a bare invocation has an undefined command", () => {
		const p = parseArgs([]);
		expect(p.command).toBeUndefined();
	});

	it("ignores a lone -- and empty flag names", () => {
		const p = parseArgs(["status", "--"]);
		expect(p.command).toBe("status");
		expect(Object.keys(p.flags)).toHaveLength(0);
	});
});

describe("hasFlag", () => {
	it("is true for a present boolean flag", () => {
		expect(hasFlag(parseArgs(["x", "--yes"]), "yes")).toBe(true);
	});
	it("is true for a non-empty string flag", () => {
		expect(hasFlag(parseArgs(["x", "--lines=5"]), "lines")).toBe(true);
	});
	it("is false for an absent flag", () => {
		expect(hasFlag(parseArgs(["x"]), "yes")).toBe(false);
	});
});
