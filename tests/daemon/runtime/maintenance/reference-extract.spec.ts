/**
 * PRD-058c — the conservative reference-extractor suite.
 *
 * The load-bearing property: over-matching is SAFE (an out-of-graph token resolves to `unknown` in the
 * diagnostic), but prose that merely MENTIONS a common English word must NEVER be emitted as a candidate
 * that could match an indexed symbol. These tests pin the four reference shapes (path, file#symbol,
 * qualified, flag) and the prose-exclusion guarantee.
 */

import { describe, expect, it } from "vitest";

import { extractReferences } from "../../../../src/daemon/runtime/maintenance/reference-extract.js";

/** The raw tokens the extractor emitted, for terse assertions. */
function raws(content: string): string[] {
	return extractReferences(content).map((r) => r.raw);
}

describe("PRD-058c extractReferences — the four reference shapes", () => {
	it("extracts a path-like token (slash + source extension)", () => {
		const refs = extractReferences("the heal engine lives in src/daemon/storage/heal.ts today");
		expect(refs).toHaveLength(1);
		expect(refs[0]).toMatchObject({ raw: "src/daemon/storage/heal.ts", kind: "path", file: "src/daemon/storage/heal.ts" });
	});

	it("splits a file#symbol reference into file + symbol", () => {
		const refs = extractReferences("see src/foo/bar.ts#doThing for the call");
		expect(refs).toHaveLength(1);
		expect(refs[0]).toMatchObject({ raw: "src/foo/bar.ts#doThing", kind: "file-symbol", file: "src/foo/bar.ts", symbol: "doThing" });
	});

	it("extracts a bare module#symbol (no extension needed — the # is the signal)", () => {
		const refs = extractReferences("the helper heal#withHeal wraps the write");
		expect(refs.some((r) => r.kind === "file-symbol" && r.symbol === "withHeal")).toBe(true);
	});

	it("extracts a SCREAMING_SNAKE flag (≥ 2 segments)", () => {
		const refs = extractReferences("gated by HONEYCOMB_PIPELINE_ENABLED at boot");
		expect(refs).toEqual([{ raw: "HONEYCOMB_PIPELINE_ENABLED", kind: "flag", symbol: "HONEYCOMB_PIPELINE_ENABLED" }]);
	});

	it("extracts a dotted lower config path (≥ 3 segments)", () => {
		expect(raws("override memory.lifecycle.halfLifeDaysByClass per class")).toContain("memory.lifecycle.halfLifeDaysByClass");
	});

	it("extracts a ::-qualified symbol with last-segment symbol", () => {
		const refs = extractReferences("the call std::vector::push_back grows it");
		const q = refs.find((r) => r.kind === "qualified");
		expect(q?.raw).toBe("std::vector::push_back");
		expect(q?.symbol).toBe("push_back");
	});

	it("extracts a Class.member qualified reference", () => {
		const refs = extractReferences("recall calls EmbedClient.embed once per query");
		const q = refs.find((r) => r.kind === "qualified" && r.raw === "EmbedClient.embed");
		expect(q).toBeDefined();
		expect(q?.symbol).toBe("embed");
	});
});

describe("PRD-058c extractReferences — prose must NOT match an indexed symbol (the precision guarantee)", () => {
	it("a sentence of common words yields NO candidates", () => {
		expect(extractReferences("the quick brown fox jumps over the lazy dog and then rests")).toEqual([]);
	});

	it("a bare common word (no structural signal) is never a flag/symbol", () => {
		expect(extractReferences("we should handle the error and retry the request")).toEqual([]);
	});

	it("a single ALLCAPS word (TODO/NOTE) is NOT a flag (needs ≥ 2 segments)", () => {
		expect(raws("TODO fix this NOTE later")).toEqual([]);
	});

	it("a two-word dotted sentence fragment (a.b) is NOT a config path (needs ≥ 3 segments)", () => {
		// `end. The` and `e.g.`-style fragments carry < 3 identifier segments → no match.
		expect(raws("that is the end. The next step, e.g. later, is fine")).toEqual([]);
	});

	it("blank / whitespace input yields []", () => {
		expect(extractReferences("")).toEqual([]);
		expect(extractReferences("   \n\t ")).toEqual([]);
	});
});

describe("PRD-058c extractReferences — over-matching is safe, dedup is stable", () => {
	it("de-duplicates a token that appears twice", () => {
		const refs = extractReferences("src/a/b.ts and again src/a/b.ts");
		expect(refs.filter((r) => r.raw === "src/a/b.ts")).toHaveLength(1);
	});

	it("an external URL is still extracted as a raw token but is flagged as a path the diagnostic excludes", () => {
		// The extractor does not decide in/out-of-graph; it just produces candidates. A URL has no
		// source-extension path, so it does NOT match the path rule — it is simply not emitted, which is
		// the safe outcome (the diagnostic would treat it as `unknown` anyway).
		expect(raws("see https://example.com/docs for details")).not.toContain("https://example.com/docs");
	});

	it("emits multiple distinct references from one memory", () => {
		const refs = raws("src/daemon/storage/heal.ts uses HONEYCOMB_PIPELINE_ENABLED and EmbedClient.embed");
		expect(refs).toContain("src/daemon/storage/heal.ts");
		expect(refs).toContain("HONEYCOMB_PIPELINE_ENABLED");
		expect(refs).toContain("EmbedClient.embed");
	});
});
