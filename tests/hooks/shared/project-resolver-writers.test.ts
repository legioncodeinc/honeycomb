/**
 * PRD-049d — the project-resolver CACHE WRITERS + the `HONEYCOMB_PROJECT_ID` override.
 *
 * 049a built the READ side (resolveScope + the fail-soft cache reader); 049d adds the WRITE side the
 * `honeycomb project bind/use` verbs + the daemon registry sync route through, plus the env override
 * the resolver honors. Verification posture: a temp `~/.deeplake` cache dir; pure functions over an
 * injected cache + a fixed cwd. No real home dir, no real git.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type ProjectsCache,
	bindFolderToProject,
	emptyProjectsCache,
	loadProjectsCache,
	resolveScope,
	resolveScopeFromDisk,
	saveProjectsCache,
} from "../../../src/hooks/shared/project-resolver.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-proj-writers-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("saveProjectsCache + loadProjectsCache round-trip", () => {
	it("writes a cache the reader validates and loads back identically", () => {
		const cache: ProjectsCache = {
			schemaVersion: 1,
			org: "acme",
			workspace: "backend",
			bindings: [{ path: resolve(dir, "work", "api"), projectId: "api" }],
			projects: [{ projectId: "api", name: "API", remoteSignal: "github.com/acme/api", boundPaths: [] }],
		};
		saveProjectsCache(cache, dir);
		const loaded = loadProjectsCache(dir);
		expect(loaded).toEqual(cache);
	});

	it("creates the parent dir if absent", () => {
		const nested = join(dir, "does", "not", "exist", "yet");
		const cache = emptyProjectsCache("acme", "backend");
		// Should not throw even though the dir tree is missing.
		expect(() => saveProjectsCache(cache, nested)).not.toThrow();
		expect(loadProjectsCache(nested)).toEqual(cache);
	});
});

describe("bindFolderToProject (the 049d bind/use writer)", () => {
	it("appends a folder→project binding so the round-trip resolves it", () => {
		const cwd = join(dir, "work", "api");
		bindFolderToProject({ cwd, projectId: "api", org: "acme", workspace: "backend", dir });
		const cache = loadProjectsCache(dir);
		const resolved = resolveScope({ cwd, cache, org: "acme", workspace: "backend" });
		expect(resolved.projectId).toBe("api");
		expect(resolved.source).toBe("binding");
	});

	it("UPSERTS the same folder (a re-bind replaces, never duplicates the path)", () => {
		const cwd = join(dir, "work", "api");
		bindFolderToProject({ cwd, projectId: "api", org: "acme", workspace: "backend", dir });
		bindFolderToProject({ cwd, projectId: "api-v2", org: "acme", workspace: "backend", dir });
		const cache = loadProjectsCache(dir);
		const norm = resolve(cwd);
		const forThisPath = cache.bindings.filter((b) => resolve(b.path) === norm);
		expect(forThisPath).toHaveLength(1);
		expect(forThisPath[0]?.projectId).toBe("api-v2");
	});

	it("creates the project INLINE with the git remote when absent", () => {
		const cwd = join(dir, "work", "api");
		bindFolderToProject({
			cwd,
			projectId: "api",
			org: "acme",
			workspace: "backend",
			name: "API",
			remoteSignal: "github.com/acme/api",
			dir,
		});
		const cache = loadProjectsCache(dir);
		const proj = cache.projects.find((p) => p.projectId === "api");
		expect(proj).toBeDefined();
		expect(proj?.name).toBe("API");
		expect(proj?.remoteSignal).toBe("github.com/acme/api");
	});

	it("RESETS a foreign-tenancy cache rather than appending onto it", () => {
		// Seed a cache synced for a DIFFERENT workspace.
		saveProjectsCache(
			{
				schemaVersion: 1,
				org: "acme",
				workspace: "OTHER-ws",
				bindings: [{ path: resolve(dir, "other"), projectId: "other-proj" }],
				projects: [{ projectId: "other-proj", name: "Other", remoteSignal: "", boundPaths: [] }],
			},
			dir,
		);
		const cwd = join(dir, "work", "api");
		bindFolderToProject({ cwd, projectId: "api", org: "acme", workspace: "backend", dir });
		const cache = loadProjectsCache(dir);
		// The new tenancy's cache drops the foreign binding/project — only the fresh bind survives.
		expect(cache.workspace).toBe("backend");
		expect(cache.bindings.some((b) => b.projectId === "other-proj")).toBe(false);
		expect(cache.projects.some((p) => p.projectId === "other-proj")).toBe(false);
		expect(cache.bindings.some((b) => b.projectId === "api")).toBe(true);
	});
});

describe("resolveScopeFromDisk honors HONEYCOMB_PROJECT_ID (49d-AC-6)", () => {
	it("the override WINS over a folder binding", () => {
		const cwd = join(dir, "work", "api");
		bindFolderToProject({ cwd, projectId: "api", org: "acme", workspace: "backend", dir });
		const resolved = resolveScopeFromDisk({
			cwd,
			org: "acme",
			workspace: "backend",
			dir,
			projectIdOverride: "ci-pinned",
		});
		expect(resolved.projectId).toBe("ci-pinned");
		expect(resolved.bound).toBe(true);
	});

	it("an empty/whitespace override is ignored (the binding resolves)", () => {
		const cwd = join(dir, "work", "api");
		bindFolderToProject({ cwd, projectId: "api", org: "acme", workspace: "backend", dir });
		const resolved = resolveScopeFromDisk({
			cwd,
			org: "acme",
			workspace: "backend",
			dir,
			projectIdOverride: "   ",
		});
		expect(resolved.projectId).toBe("api");
	});
});
