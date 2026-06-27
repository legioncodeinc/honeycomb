/**
 * safe-path tests (PRD-064 Aikido SAST hardening): {@link resolveInBase} must accept a
 * normal fixed filename joined under a base, reject any traversal / separator / escaping
 * segment, and {@link assertWithinBase} must reject a composed path outside the base. The
 * containment assertion is the genuine defense-in-depth a poisoned workspace cannot defeat.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertWithinBase, PathContainmentError, resolveInBase } from "../src/safe-path.js";

describe("resolveInBase", () => {
	let base: string;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "hivedoctor-safe-path-"));
	});
	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	it("accepts a normal fixed filename and returns a contained absolute path", () => {
		const result = resolveInBase(base, "state.json");
		expect(result).toBe(join(resolve(base), "state.json"));
		expect(result.startsWith(resolve(base) + sep)).toBe(true);
	});

	it("accepts multiple fixed segments that stay inside the base", () => {
		const result = resolveInBase(base, "sub", "file.txt");
		expect(result).toBe(join(resolve(base), "sub", "file.txt"));
	});

	it("rejects a '..' traversal segment", () => {
		expect(() => resolveInBase(base, "..")).toThrow(PathContainmentError);
	});

	it("rejects a segment containing a POSIX separator", () => {
		expect(() => resolveInBase(base, "../escape.json")).toThrow(PathContainmentError);
		expect(() => resolveInBase(base, "a/b")).toThrow(PathContainmentError);
	});

	it("rejects a segment containing a Windows separator", () => {
		expect(() => resolveInBase(base, "a\\b")).toThrow(PathContainmentError);
	});

	it("rejects an empty segment and a missing segment", () => {
		expect(() => resolveInBase(base, "")).toThrow(PathContainmentError);
		expect(() => resolveInBase(base)).toThrow(PathContainmentError);
	});

	it("rejects a lone '.' segment", () => {
		expect(() => resolveInBase(base, ".")).toThrow(PathContainmentError);
	});

	it("does not treat a sibling-prefix dir as contained (the /a/bc vs /a/b trap)", () => {
		// resolveInBase only joins fixed segments, but assertWithinBase guards composed paths.
		const sibling = `${resolve(base)}-evil`;
		expect(() => assertWithinBase(base, join(sibling, "x.json"))).toThrow(PathContainmentError);
	});
});

describe("assertWithinBase", () => {
	const base = resolve(sep, "home", "ada", "ws");

	it("accepts a path nested under the base", () => {
		const p = join(base, "Library", "x.plist");
		expect(assertWithinBase(base, p)).toBe(p);
	});

	it("accepts the base itself", () => {
		expect(assertWithinBase(base, base)).toBe(base);
	});

	it("rejects a path that escapes via '..'", () => {
		expect(() => assertWithinBase(base, join(base, "..", "..", "etc", "passwd"))).toThrow(
			PathContainmentError,
		);
	});

	it("rejects a non-absolute candidate", () => {
		expect(() => assertWithinBase(base, "relative/path.json")).toThrow(PathContainmentError);
	});
});
