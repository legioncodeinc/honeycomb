/**
 * Dependency-free semver compare (PRD-064e version source). Pure logic; no seams.
 */

import { describe, expect, it } from "vitest";

import { compareParsed, isSameVersion, isStrictlyNewer, parseVersion } from "../../src/update/version.js";

describe("parseVersion", () => {
	it("parses a plain MAJOR.MINOR.PATCH", () => {
		expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
	});

	it("tolerates a leading v and ignores build metadata", () => {
		expect(parseVersion("v1.2.3+build.7")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
	});

	it("splits a prerelease into numeric and alphanumeric identifiers", () => {
		expect(parseVersion("1.2.0-rc.1")).toEqual({ major: 1, minor: 2, patch: 0, prerelease: ["rc", 1] });
	});

	it("returns null for garbage / partial versions", () => {
		expect(parseVersion("not-a-version")).toBeNull();
		expect(parseVersion("1.2")).toBeNull();
		expect(parseVersion("")).toBeNull();
		expect(parseVersion("1.2.x")).toBeNull();
	});
});

describe("compareParsed precedence (semver #11)", () => {
	const cmp = (a: string, b: string): number => {
		const pa = parseVersion(a);
		const pb = parseVersion(b);
		if (pa === null || pb === null) throw new Error("test fixture must be valid");
		return compareParsed(pa, pb);
	};

	it("orders by core fields", () => {
		expect(cmp("1.0.0", "2.0.0")).toBe(-1);
		expect(cmp("1.2.0", "1.1.0")).toBe(1);
		expect(cmp("1.1.1", "1.1.1")).toBe(0);
	});

	it("ranks a release above its prerelease", () => {
		expect(cmp("1.2.0", "1.2.0-rc.1")).toBe(1);
		expect(cmp("1.2.0-rc.1", "1.2.0")).toBe(-1);
	});

	it("orders prerelease identifiers left to right", () => {
		expect(cmp("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
		expect(cmp("1.0.0-rc.1", "1.0.0-rc.2")).toBe(-1);
		// numeric identifiers rank below alphanumeric ones
		expect(cmp("1.0.0-1", "1.0.0-alpha")).toBe(-1);
		// a longer identifier list wins when shared identifiers are equal
		expect(cmp("1.0.0-rc.1", "1.0.0-rc.1.1")).toBe(-1);
	});
});

describe("isStrictlyNewer (fail-closed)", () => {
	it("true only when the candidate is strictly newer", () => {
		expect(isStrictlyNewer("0.1.8", "0.1.7")).toBe(true);
		expect(isStrictlyNewer("0.1.7", "0.1.7")).toBe(false); // equal is NOT newer
		expect(isStrictlyNewer("0.1.6", "0.1.7")).toBe(false);
	});

	it("treats any unparseable input as NOT newer (a garbage version never triggers an update)", () => {
		expect(isStrictlyNewer("garbage", "0.1.7")).toBe(false);
		expect(isStrictlyNewer("0.1.8", "garbage")).toBe(false);
		expect(isStrictlyNewer("", "0.1.7")).toBe(false);
	});
});

describe("isSameVersion", () => {
	it("equates versions of identical precedence and ignores build metadata", () => {
		expect(isSameVersion("0.1.8", "0.1.8")).toBe(true);
		expect(isSameVersion("0.1.8+a", "0.1.8+b")).toBe(true);
		expect(isSameVersion("0.1.8", "0.1.9")).toBe(false);
	});

	it("returns false for unparseable input", () => {
		expect(isSameVersion("0.1.8", "nope")).toBe(false);
	});
});
