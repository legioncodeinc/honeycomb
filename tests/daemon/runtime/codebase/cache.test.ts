/**
 * PRD-014a content-addressed cache — a-AC-2 (reuse by sha + rename rewrite) + a-AC-5
 * (CACHE_SCHEMA_VERSION bump invalidates). Source fixtures + a temp cache dir; no
 * DeepLake, no network.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CACHE_SCHEMA_VERSION, ExtractionCache } from "../../../../src/daemon/runtime/codebase/cache.js";
import { contentSha256, extractFile } from "../../../../src/daemon/runtime/codebase/extract.js";
import type { FileExtraction } from "../../../../src/daemon/runtime/codebase/contracts.js";

let baseDir: string;

beforeEach(() => {
	baseDir = mkdtempSync(join(tmpdir(), "hc-graph-cache-"));
});
afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
});

async function extract(path: string, content: string): Promise<FileExtraction> {
	const ex = await extractFile(path, content, contentSha256(content));
	if (ex === null) throw new Error("expected extraction");
	return ex;
}

describe("PRD-014a a-AC-2: unchanged file reused by content sha256", () => {
	it("a-AC-2 a write then a read of the same content returns the cached extraction (no re-parse)", async () => {
		const cache = new ExtractionCache(baseDir);
		const src = "export function foo(){ bar(); }";
		const sha = contentSha256(src);
		const original = await extract("src/a.ts", src);
		cache.write(original);

		const hit = cache.read(sha, "src/a.ts");
		expect(hit).not.toBeNull();
		// Same nodes/edges as the original (reused, not re-derived to something different).
		expect(hit!.nodes.map((n) => n.id)).toEqual(original.nodes.map((n) => n.id));
		expect(hit!.edges.map((e) => e.id)).toEqual(original.edges.map((e) => e.id));
		expect(hit!.contentSha256).toBe(sha);
	});

	it("a-AC-2 a miss (unknown sha) returns null", () => {
		const cache = new ExtractionCache(baseDir);
		expect(cache.read(contentSha256("nope"), "x.ts")).toBeNull();
	});
});

describe("PRD-014a a-AC-2: rename/copy rewrites source_file + edge-id prefixes + module labels", () => {
	it("a-AC-2 a cache hit at a NEW path rewrites every source_file + node id + edge id prefix", async () => {
		const cache = new ExtractionCache(baseDir);
		const src = "export class A extends B { m(){ foo(); } }";
		const sha = contentSha256(src);
		const original = await extract("src/old/a.ts", src);
		cache.write(original);

		// Read for a RENAMED path (same content, new location). No re-parse.
		const renamed = cache.read(sha, "src/new/renamed.ts");
		expect(renamed).not.toBeNull();
		const ex = renamed!;

		// Every source_file is the current path; the old path appears NOWHERE.
		expect(ex.sourceFile).toBe("src/new/renamed.ts");
		for (const n of ex.nodes) {
			expect(n.sourceFile).toBe("src/new/renamed.ts");
			expect(n.id.startsWith("src/old/")).toBe(false);
		}
		for (const e of ex.edges) {
			expect(e.id.startsWith("src/old/")).toBe(false);
			expect(e.id.startsWith("src/new/renamed.ts::")).toBe(true);
			// same-file src is repointed; external: targets are untouched (not a path).
			expect(e.src.startsWith("src/old/")).toBe(false);
		}
		// The file node's name is the new basename.
		const fileNode = ex.nodes.find((n) => n.kind === "file")!;
		expect(fileNode.name).toBe("renamed.ts");
		// Identical content as a re-extraction at the new path (the rewrite is faithful).
		const fresh = await extract("src/new/renamed.ts", src);
		expect(ex.nodes.map((n) => n.id).sort()).toEqual(fresh.nodes.map((n) => n.id).sort());
		expect(ex.edges.map((e) => e.id).sort()).toEqual(fresh.edges.map((e) => e.id).sort());
	});

	it("a-AC-2 an exact-path hit is returned unchanged (no spurious rewrite)", async () => {
		const cache = new ExtractionCache(baseDir);
		const src = "export const x = 1;";
		const sha = contentSha256(src);
		const original = await extract("a.ts", src);
		cache.write(original);
		const hit = cache.read(sha, "a.ts");
		expect(hit!.sourceFile).toBe("a.ts");
	});
});

describe("PRD-014a a-AC-5: CACHE_SCHEMA_VERSION bump invalidates old entries", () => {
	it("a-AC-5 an entry written under a different schema version is ignored and re-extracted", async () => {
		const cache = new ExtractionCache(baseDir);
		const src = "export function foo(){}";
		const sha = contentSha256(src);
		// Manually write a STALE entry (schemaVersion not matching the current one).
		const cacheDir = join(baseDir, ".cache");
		const original = await extract("a.ts", src);
		// Ensure the dir exists by doing one real write first, then overwrite stale.
		cache.write(original);
		const stale = {
			schemaVersion: CACHE_SCHEMA_VERSION + 1,
			contentSha256: sha,
			extraction: original,
		};
		writeFileSync(join(cacheDir, `${sha}.json`), JSON.stringify(stale), "utf8");

		// Read now misses (version mismatch) → caller re-extracts.
		expect(cache.read(sha, "a.ts")).toBeNull();
	});

	it("a-AC-5 a corrupt entry fails validation and is treated as a miss", () => {
		const cache = new ExtractionCache(baseDir);
		const src = "export const y = 2;";
		const sha = contentSha256(src);
		// Force the cache dir to exist, then drop garbage at the sha path.
		cache.write({
			sourceFile: "y.ts",
			language: "typescript",
			nodes: [],
			edges: [],
			parseErrors: [],
			contentSha256: sha,
		});
		writeFileSync(join(baseDir, ".cache", `${sha}.json`), "{ not valid json ", "utf8");
		expect(cache.read(sha, "y.ts")).toBeNull();
	});

	it("a-AC-5 an entry whose stored sha disagrees with its key is rejected", async () => {
		const cache = new ExtractionCache(baseDir);
		const src = "export const z = 3;";
		const sha = contentSha256(src);
		const original = await extract("z.ts", src);
		cache.write(original);
		// Tamper: rewrite the entry with a WRONG inner sha.
		const tampered = { schemaVersion: CACHE_SCHEMA_VERSION, contentSha256: "deadbeef", extraction: original };
		writeFileSync(join(baseDir, ".cache", `${sha}.json`), JSON.stringify(tampered), "utf8");
		expect(cache.read(sha, "z.ts")).toBeNull();
	});

	it("a-AC-5 identical content from two paths shares ONE cache file (content-addressed)", async () => {
		const cache = new ExtractionCache(baseDir);
		const src = "export function shared(){}";
		const sha = contentSha256(src);
		cache.write(await extract("one.ts", src));
		cache.write(await extract("two/also.ts", src));
		const files = readdirSync(join(baseDir, ".cache"));
		// Exactly one entry for the shared content (keyed by sha, not path).
		expect(files.filter((f) => f === `${sha}.json`).length).toBe(1);
		// And it can be reused for a THIRD path via the rewrite.
		const hit = cache.read(sha, "three/copy.ts");
		expect(hit!.sourceFile).toBe("three/copy.ts");
	});
});
