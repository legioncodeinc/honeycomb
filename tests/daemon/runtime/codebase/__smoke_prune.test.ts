import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { writeSnapshotAtomic } from "../../../../src/daemon/runtime/codebase/snapshot.js";
import { ExtractionCache } from "../../../../src/daemon/runtime/codebase/cache.js";
import type { Snapshot } from "../../../../src/daemon/runtime/codebase/contracts.js";

function fakeSnapshot(commit: string): Snapshot {
	return {
		directed: true,
		multigraph: true,
		graph: { org: "o", workspace: "w", repo: "r", user: "u", worktree: "wt", commit },
		nodes: [],
		links: [],
		observation: {
			generatedAt: new Date().toISOString(),
			generatorVersion: "smoke",
			worktreePath: "/repo",
			fileCount: 0,
			nodeCount: 0,
			edgeCount: 0,
			parseErrorCount: 0,
		},
	};
}

describe("SMOKE: unbounded-growth fix verification (delete this file after verifying)", () => {
	it("writeSnapshotAtomic keeps only the freshest snapshot across multiple commits", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "smoke-snap-"));
		try {
			writeSnapshotAtomic(fakeSnapshot("commit-1"), baseDir);
			writeSnapshotAtomic(fakeSnapshot("commit-2"), baseDir);
			writeSnapshotAtomic(fakeSnapshot("commit-3"), baseDir);
			const files = readdirSync(join(baseDir, "snapshots")).filter((f) => f.endsWith(".json"));
			expect(files).toEqual(["commit-3.json"]);
			expect(existsSync(join(baseDir, "snapshots", "commit-1.json"))).toBe(false);
			expect(existsSync(join(baseDir, "snapshots", "commit-2.json"))).toBe(false);
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("ExtractionCache sweeps entries older than the age ceiling on construction", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "smoke-cache-"));
		try {
			// Prime one entry via a real write, then age it out artificially.
			new ExtractionCache(baseDir).write({
				sourceFile: "a.ts",
				language: "ts",
				nodes: [],
				edges: [],
				parseErrors: [],
				contentSha256: "deadbeef",
			});
			const entryPath = join(baseDir, ".cache", "deadbeef.json");
			expect(existsSync(entryPath)).toBe(true);
			const ancient = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
			utimesSync(entryPath, ancient, ancient);

			// A fresh, unrelated entry that should SURVIVE the sweep.
			writeFileSync(join(baseDir, ".cache", "fresh.json"), "{}", "utf-8");

			// Constructing a NEW cache instance (as every build does) sweeps stale entries.
			new ExtractionCache(baseDir);
			expect(existsSync(entryPath)).toBe(false); // swept — 200 days old.
			expect(existsSync(join(baseDir, ".cache", "fresh.json"))).toBe(true); // untouched.
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});
