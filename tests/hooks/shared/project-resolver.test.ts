/**
 * PRD-049a — per-session project identity & resolution (the thin-client resolver).
 *
 * Verification posture (mirrors `credential-reader.test.ts` / `onboarding-store.test.ts`):
 * a TEMP `~/.deeplake` dir per-test + `dir?` injection, so NO test ever touches the
 * real `~/.deeplake`. The resolver is a SELF-CONTAINED thin client — it imports
 * nothing from `daemon/storage` (the invariant suite enforces that boundary
 * separately); this file proves the RESOLUTION behavior.
 *
 * Coverage maps to the acceptance criteria:
 *   a-AC-1 canonicalizeRemote folds git@ ≡ https ≡ .git ≡ case → ONE project id;
 *   a-AC-2 two cwds resolve two project ids simultaneously, no shared mutable global;
 *   a-AC-3 identity-less folder → __unsorted__ inbox, bound:false, never throws;
 *          fail-soft on a missing/malformed projects.json;
 *   a-AC-4 a git remote matching a registry project binds that project, not the inbox.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type CachedProject,
	type FolderBinding,
	type GitRemoteReader,
	type ProjectsCache,
	UNSORTED_PROJECT_ID,
	canonicalizeRemote,
	emptyProjectsCache,
	loadProjectsCache,
	projectsCachePath,
	resolveScope,
	resolveScopeFromDisk,
} from "../../../src/hooks/shared/project-resolver.js";

/** Build a cache with the given bindings + projects (schema-valid). */
function cacheOf(opts: {
	org?: string;
	workspace?: string;
	bindings?: FolderBinding[];
	projects?: CachedProject[];
}): ProjectsCache {
	return {
		schemaVersion: 1,
		org: opts.org ?? "org-acme",
		workspace: opts.workspace ?? "ws-main",
		bindings: opts.bindings ?? [],
		projects: opts.projects ?? [],
	};
}

/** A reader that returns a fixed remote regardless of cwd. */
function fixedRemote(url: string | null): GitRemoteReader {
	return () => url;
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-projects-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// a-AC-1 — canonicalizeRemote: equivalence across remote-URL forms
// ─────────────────────────────────────────────────────────────────────────────

describe("a-AC-1 canonicalizeRemote folds equivalent remote forms to one identity", () => {
	const equivalent = [
		"git@github.com:org/x.git",
		"https://github.com/org/x",
		"https://github.com/org/x.git",
		"ssh://git@github.com/org/x.git",
		"https://github.com/org/x/",
		"git://github.com/org/x.git",
	];

	it("collapses every git@/https/ssh/.git/trailing-slash form to github.com/org/x", () => {
		for (const url of equivalent) {
			expect(canonicalizeRemote(url)).toBe("github.com/org/x");
		}
		// All forms produce the SAME canonical string (the equivalence class).
		const canon = new Set(equivalent.map(canonicalizeRemote));
		expect(canon.size).toBe(1);
	});

	it("lowercases host + owner/repo and strips userinfo + port (case-insensitive identity)", () => {
		expect(canonicalizeRemote("https://user@GitHub.com:443/Org/X/")).toBe("github.com/org/x");
		expect(canonicalizeRemote("git@GitHub.com:Org/X.git")).toBe("github.com/org/x");
	});

	it("keeps deep paths (GitLab subgroups) intact", () => {
		expect(canonicalizeRemote("git@gitlab.com:group/sub/proj.git")).toBe("gitlab.com/group/sub/proj");
		expect(canonicalizeRemote("https://gitlab.com/group/sub/proj")).toBe("gitlab.com/group/sub/proj");
	});

	it("returns '' for an empty / unusable remote (no host+path → no git signal)", () => {
		expect(canonicalizeRemote("")).toBe("");
		expect(canonicalizeRemote("   ")).toBe("");
		expect(canonicalizeRemote("not-a-url")).toBe("");
	});

	it("EQUIVALENCE end-to-end: git@ and https forms resolve to the SAME project id (a-AC-1)", () => {
		const cwd = join(dir, "clone");
		const cache = cacheOf({
			projects: [{ projectId: "proj-x", name: "X", remoteSignal: "github.com/org/x", boundPaths: [] }],
		});
		const viaSsh = resolveScope({ cwd, cache, readRemote: fixedRemote("git@github.com:org/x.git") });
		const viaHttps = resolveScope({ cwd, cache, readRemote: fixedRemote("https://github.com/org/x") });
		const viaGitSuffix = resolveScope({ cwd, cache, readRemote: fixedRemote("https://github.com/org/x.git") });
		expect(viaSsh.projectId).toBe("proj-x");
		expect(viaHttps.projectId).toBe("proj-x");
		expect(viaGitSuffix.projectId).toBe("proj-x");
		// Same bound folder across remote-URL forms → identical project id (a-AC-1).
		expect(new Set([viaSsh.projectId, viaHttps.projectId, viaGitSuffix.projectId]).size).toBe(1);
	});

	it("DETERMINISM: the same bound folder resolves the same id across runs (a-AC-1)", () => {
		const cwd = join(dir, "work", "api");
		const cache = cacheOf({ bindings: [{ path: join(dir, "work", "api"), projectId: "proj-api" }] });
		const first = resolveScope({ cwd, cache });
		const second = resolveScope({ cwd, cache });
		expect(first).toEqual(second);
		expect(first.projectId).toBe("proj-api");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// a-AC-2 — concurrency: two cwds resolve two ids, no shared mutable global
// ─────────────────────────────────────────────────────────────────────────────

describe("a-AC-2 concurrent resolution is per-call with no shared mutable global", () => {
	it("two cwds bound to two projects resolve two different ids SIMULTANEOUSLY", () => {
		const apiDir = join(dir, "work", "api");
		const webDir = join(dir, "work", "web");
		const cache = cacheOf({
			bindings: [
				{ path: apiDir, projectId: "proj-api" },
				{ path: webDir, projectId: "proj-web" },
			],
		});
		// Resolve both "simultaneously" — interleave the calls; a shared singleton
		// would let the second perturb the first.
		const [a, b] = [resolveScope({ cwd: apiDir, cache }), resolveScope({ cwd: webDir, cache })];
		expect(a.projectId).toBe("proj-api");
		expect(b.projectId).toBe("proj-web");
		expect(a.projectId).not.toBe(b.projectId);
	});

	it("a third session switching scope perturbs NEITHER of the first two", () => {
		const apiDir = join(dir, "work", "api");
		const webDir = join(dir, "work", "web");
		const spikeDir = join(dir, "scratch", "spike");
		const cache = cacheOf({
			bindings: [
				{ path: apiDir, projectId: "proj-api" },
				{ path: webDir, projectId: "proj-web" },
			],
		});
		const a1 = resolveScope({ cwd: apiDir, cache });
		const b1 = resolveScope({ cwd: webDir, cache });
		// A third (identity-less) session resolves to the inbox — and re-resolving the
		// first two yields IDENTICAL results (no global was mutated).
		const c = resolveScope({ cwd: spikeDir, cache });
		const a2 = resolveScope({ cwd: apiDir, cache });
		const b2 = resolveScope({ cwd: webDir, cache });
		expect(c.projectId).toBe(UNSORTED_PROJECT_ID);
		expect(a2).toEqual(a1);
		expect(b2).toEqual(b1);
	});

	it("resolveScope is pure: no exported mutable singleton across calls (snapshot-equal)", () => {
		const cwd = join(dir, "p");
		const cache = cacheOf({ bindings: [{ path: cwd, projectId: "proj-p" }] });
		const results = Array.from({ length: 5 }, () => resolveScope({ cwd, cache }));
		for (const r of results) expect(r).toEqual(results[0]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// a-AC-3 — identity-less folder → inbox, bound:false, fail-soft, never throws
// ─────────────────────────────────────────────────────────────────────────────

describe("a-AC-3 identity-less folder falls to the __unsorted__ inbox (never throws)", () => {
	it("no binding + no git remote → __unsorted__ inbox, bound:false, source:inbox", () => {
		const cwd = join(dir, "scratch", "spike");
		const result = resolveScope({ cwd, cache: emptyProjectsCache(), workspace: "ws-main" });
		expect(result.projectId).toBe(UNSORTED_PROJECT_ID);
		expect(result.bound).toBe(false);
		expect(result.source).toBe("inbox");
		expect(result.workspace).toBe("ws-main");
	});

	it("a git remote that matches NO registry project still falls to the inbox (never another id)", () => {
		const cwd = join(dir, "unknown");
		const cache = cacheOf({
			projects: [{ projectId: "proj-x", name: "X", remoteSignal: "github.com/org/x", boundPaths: [] }],
		});
		const result = resolveScope({ cwd, cache, readRemote: fixedRemote("git@github.com:other/repo.git") });
		expect(result.projectId).toBe(UNSORTED_PROJECT_ID);
		expect(result.bound).toBe(false);
	});

	it("loadProjectsCache fails soft to an EMPTY cache on a MISSING file (never throws)", () => {
		const cache = loadProjectsCache(dir); // no file written
		expect(cache).toEqual(emptyProjectsCache());
		expect(cache.bindings).toEqual([]);
		expect(cache.projects).toEqual([]);
	});

	it("loadProjectsCache fails soft on MALFORMED JSON (never throws)", () => {
		writeFileSync(projectsCachePath(dir), "{ not json at all");
		expect(() => loadProjectsCache(dir)).not.toThrow();
		expect(loadProjectsCache(dir)).toEqual(emptyProjectsCache());
	});

	it("loadProjectsCache fails soft on a schema-INVALID file (wrong version/shape)", () => {
		writeFileSync(projectsCachePath(dir), JSON.stringify({ schemaVersion: 99, bindings: "nope" }));
		expect(loadProjectsCache(dir)).toEqual(emptyProjectsCache());
	});

	it("resolveScopeFromDisk on a missing cache → inbox, bound:false (the hot-path fail-soft)", () => {
		const result = resolveScopeFromDisk({ cwd: join(dir, "x"), workspace: "ws-main", dir });
		expect(result.projectId).toBe(UNSORTED_PROJECT_ID);
		expect(result.bound).toBe(false);
		expect(result.workspace).toBe("ws-main");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// a-AC-4 — git remote matching a registry project binds it (not the inbox)
// ─────────────────────────────────────────────────────────────────────────────

describe("a-AC-4 a git remote matching a registry project resolves THAT project", () => {
	it("matches the canonical remote signal against a cached registry project", () => {
		const cwd = join(dir, "fresh-clone");
		const cache = cacheOf({
			projects: [
				{ projectId: "proj-api", name: "API", remoteSignal: "github.com/acme/api", boundPaths: [] },
				{ projectId: "proj-web", name: "Web", remoteSignal: "github.com/acme/web", boundPaths: [] },
			],
		});
		const result = resolveScope({ cwd, cache, readRemote: fixedRemote("git@github.com:acme/api.git") });
		expect(result.projectId).toBe("proj-api");
		expect(result.bound).toBe(true);
		expect(result.source).toBe("git");
	});

	it("an explicit binding WINS over the git signal (precedence: binding > git)", () => {
		const cwd = join(dir, "work", "api");
		const cache = cacheOf({
			bindings: [{ path: cwd, projectId: "proj-bound" }],
			projects: [{ projectId: "proj-git", name: "API", remoteSignal: "github.com/acme/api", boundPaths: [] }],
		});
		const result = resolveScope({ cwd, cache, readRemote: fixedRemote("git@github.com:acme/api.git") });
		expect(result.projectId).toBe("proj-bound");
		expect(result.source).toBe("binding");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Precedence — longest-prefix binding match (child wins over parent)
// ─────────────────────────────────────────────────────────────────────────────

describe("longest-prefix binding match (a child binding wins over a parent)", () => {
	it("a nested bound folder resolves the CHILD project, not the parent", () => {
		const parent = join(dir, "work");
		const child = join(dir, "work", "api");
		const cache = cacheOf({
			bindings: [
				{ path: parent, projectId: "proj-parent" },
				{ path: child, projectId: "proj-child" },
			],
		});
		expect(resolveScope({ cwd: join(child, "deep", "nested"), cache }).projectId).toBe("proj-child");
		expect(resolveScope({ cwd: join(parent, "other"), cache }).projectId).toBe("proj-parent");
	});

	it("a sibling that merely SHARES a prefix string does not match (segment-aware)", () => {
		const bound = join(dir, "work", "api");
		const sibling = join(dir, "work", "api-v2"); // shares the 'api' string prefix
		const cache = cacheOf({ bindings: [{ path: bound, projectId: "proj-api" }] });
		expect(resolveScope({ cwd: sibling, cache }).projectId).toBe(UNSORTED_PROJECT_ID);
	});

	it("a daemon-synced project boundPaths entry resolves a binding offline", () => {
		const cwd = join(dir, "synced");
		const cache = cacheOf({
			projects: [{ projectId: "proj-synced", name: "S", remoteSignal: "", boundPaths: [cwd] }],
		});
		const result = resolveScope({ cwd, cache });
		expect(result.projectId).toBe("proj-synced");
		expect(result.source).toBe("binding");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveScopeFromDisk — tenancy guard on a cross-workspace cache
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveScopeFromDisk ignores a cache synced for a DIFFERENT workspace", () => {
	it("a cache for ws-other does not bind a project when the active workspace is ws-main", () => {
		const cwd = join(dir, "work", "api");
		// Cache written for ws-other carries a binding that would otherwise match.
		const cache: ProjectsCache = cacheOf({
			workspace: "ws-other",
			bindings: [{ path: cwd, projectId: "proj-other-ws" }],
		});
		writeFileSync(projectsCachePath(dir), JSON.stringify(cache));
		const result = resolveScopeFromDisk({ cwd, workspace: "ws-main", dir });
		// The cross-workspace cache is dropped → inbox, never proj-other-ws.
		expect(result.projectId).toBe(UNSORTED_PROJECT_ID);
		expect(result.bound).toBe(false);
	});

	it("a cache for the ACTIVE workspace binds normally", () => {
		const cwd = join(dir, "work", "api");
		const cache = cacheOf({ workspace: "ws-main", bindings: [{ path: cwd, projectId: "proj-api" }] });
		writeFileSync(projectsCachePath(dir), JSON.stringify(cache));
		const result = resolveScopeFromDisk({ cwd, workspace: "ws-main", dir });
		expect(result.projectId).toBe("proj-api");
		expect(result.bound).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Windows drive-root binding — must NOT over-match every path on the drive
//
// REGRESSION: normalizePath stripped the trailing separator from a Windows drive
// root `C:\` (length 3 > 1), collapsing it to `"C:"`. Then isPathPrefix("C:", <any C: path>)
// matched EVERYTHING on the C: drive, so a binding to the drive root resolved
// unrelated sibling folders (e.g. `C:\Users\me\docs`) to that project instead of
// the inbox. The fix keeps a root's trailing separator. POSIX-only CI cannot hit
// this (its root `/` is length 1 and already preserved), so skip there.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(process.platform !== "win32")(
	"Windows drive-root binding does not over-match sibling folders",
	() => {
		it("a binding to the C:\\ drive root does NOT bind an unrelated sibling folder", () => {
			const cache = cacheOf({ bindings: [{ path: "C:\\", projectId: "proj-drive-root" }] });
			const sibling = "C:\\Users\\me\\docs";
			const result = resolveScope({ cwd: sibling, cache });
			// Bug: this resolved to "proj-drive-root". Correct: the sibling is NOT the
			// drive root, so it falls to the inbox, unbound.
			expect(result.projectId).toBe(UNSORTED_PROJECT_ID);
			expect(result.bound).toBe(false);
		});

		it("a binding to the C:\\ drive root still binds the root path itself", () => {
			const cache = cacheOf({ bindings: [{ path: "C:\\", projectId: "proj-drive-root" }] });
			const result = resolveScope({ cwd: "C:\\", cache });
			expect(result.projectId).toBe("proj-drive-root");
			expect(result.bound).toBe(true);
		});
	},
);
