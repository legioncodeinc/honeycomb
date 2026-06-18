/**
 * PRD-014a discovery — a-AC-3 (git ls-files honors .gitignore + excludes .d.ts) +
 * a-AC-6 (no-git manual walk skips dotfiles + ignored dir names). Temp dirs + an
 * injected git lister; no real git dependency in the unit path (the fixture drives the
 * git output), plus a real manual-walk over a temp tree.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverSourceFiles } from "../../../../src/daemon/runtime/codebase/discovery.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hc-graph-disc-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A fake `git ls-files` that returns a NUL-delimited list (the real git output shape). */
function fakeGit(paths: readonly string[]): (repoRoot: string) => string | null {
	return () => paths.join("\0");
}

describe("PRD-014a a-AC-3: git ls-files honors .gitignore and excludes .d.ts", () => {
	it("a-AC-3 keeps source files git lists and excludes .d.ts declarations", () => {
		// git ls-files already applied .gitignore — its output excludes ignored files.
		// It DOES list a .d.ts (git tracks it); discovery must drop it.
		const r = discoverSourceFiles(root, {
			gitLsFiles: fakeGit([
				"src/a.ts",
				"src/b.py",
				"src/types.d.ts", // MUST be excluded (a-AC-3 / FR-6)
				"README.md", // not a source extension → dropped
				"src/c.go",
			]),
		});
		expect(r.mode).toBe("git");
		expect(r.files).toContain("src/a.ts");
		expect(r.files).toContain("src/b.py");
		expect(r.files).toContain("src/c.go");
		expect(r.files).not.toContain("src/types.d.ts");
		expect(r.files).not.toContain("README.md");
	});

	it("a-AC-3 a file git did NOT list (because .gitignore excluded it) is absent", () => {
		// git ls-files --exclude-standard already omitted the ignored file; discovery
		// simply never sees it. We assert the absence to document the .gitignore path.
		const r = discoverSourceFiles(root, {
			gitLsFiles: fakeGit(["src/keep.ts"]), // node_modules/ignored.ts NOT in the list
		});
		expect(r.files).toEqual(["src/keep.ts"]);
	});

	it("a-AC-3 the user graph-ignore.json safety net excludes a tracked dir", () => {
		const ignorePath = join(root, "graph-ignore.json");
		writeFileSync(ignorePath, JSON.stringify({ ignore: ["src/vendored/"] }), "utf8");
		const r = discoverSourceFiles(root, {
			gitLsFiles: fakeGit(["src/app.ts", "src/vendored/lib.ts"]),
			graphIgnorePath: ignorePath,
		});
		expect(r.files).toContain("src/app.ts");
		expect(r.files).not.toContain("src/vendored/lib.ts");
	});

	it("a-AC-3 paths are normalized, sorted, and deduped", () => {
		const r = discoverSourceFiles(root, {
			gitLsFiles: fakeGit(["./src/b.ts", "src/a.ts", "src/a.ts"]),
		});
		expect(r.files).toEqual(["src/a.ts", "src/b.ts"]);
	});
});

describe("PRD-014a a-AC-6: no git → manual walk skips dotfiles + ignored directory names", () => {
	it("a-AC-6 walks a real tree, skipping dotfiles, dot-dirs, and node_modules", () => {
		// Build a temp tree.
		mkdirSync(join(root, "src"), { recursive: true });
		mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
		mkdirSync(join(root, ".git"), { recursive: true });
		mkdirSync(join(root, ".hidden"), { recursive: true });
		writeFileSync(join(root, "src", "a.ts"), "export const a = 1;");
		writeFileSync(join(root, "src", "b.py"), "x = 1\n");
		writeFileSync(join(root, "src", "types.d.ts"), "export declare const t: number;");
		writeFileSync(join(root, ".env"), "SECRET=1"); // dotfile → skipped
		writeFileSync(join(root, "node_modules", "pkg", "index.js"), "module.exports={}"); // ignored dir
		writeFileSync(join(root, ".hidden", "x.ts"), "export const h = 1;"); // dot-dir → skipped

		// Force the manual-walk fallback: git lister returns null (git unavailable).
		const r = discoverSourceFiles(root, { gitLsFiles: () => null });
		expect(r.mode).toBe("manual");
		expect(r.files).toContain("src/a.ts");
		expect(r.files).toContain("src/b.py");
		// Excluded: .d.ts, dotfiles, dot-dirs, node_modules.
		expect(r.files).not.toContain("src/types.d.ts");
		expect(r.files.some((f) => f.includes(".env"))).toBe(false);
		expect(r.files.some((f) => f.includes("node_modules"))).toBe(false);
		expect(r.files.some((f) => f.includes(".hidden"))).toBe(false);
	});

	it("a-AC-6 an empty / source-free tree yields an empty list, not a crash", () => {
		writeFileSync(join(root, "notes.md"), "# hi"); // no source extension
		const r = discoverSourceFiles(root, { gitLsFiles: () => null });
		expect(r.mode).toBe("manual");
		expect(r.files).toEqual([]);
	});
});
