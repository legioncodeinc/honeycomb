/**
 * PRD-059b / 059c / 059d — the dashboard onboarding folder-browse + bind routes suite.
 *
 *   059b — GET /api/diagnostics/fs/browse enumerates immediate child DIRECTORIES (daemon-served, so
 *          the path is a real absolute path, b-AC-2), marks git repos (b-AC-3), refuses traversal
 *          outside the allowed root, and POST /projects/bind writes the 049a store (b-AC-4).
 *   059c — POST /projects/unbind removes the LOCAL folder binding only; the registry copy is untouched.
 *   059d — POST /projects/bind-existing binds a folder to an EXISTING project_id (cross-device, d-AC-2).
 *   local-mode gate — a team-mode daemon never serves these (security F-1).
 *
 * Verification posture: a REAL daemon in `local` mode, exercised in-process via `daemon.app.request`.
 * A temp browse root + a temp projects-cache dir back the routes — NO real home, NO network, NO
 * DeepLake. A fixed git-remote reader drives the name suggestion deterministically.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { ok } from "../../../../src/daemon/storage/result.js";
import type { StorageQuery } from "../../../../src/daemon/storage/client.js";
import type { GitRemoteReader } from "../../../../src/hooks/shared/index.js";
import {
	type BindAck,
	type BrowseBody,
	type UnbindAck,
	mountOnboardingApi,
} from "../../../../src/daemon/runtime/projects/onboarding-api.js";

function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

let browseRoot: string;
let cacheDir: string;
beforeEach(() => {
	// `realpathSync` so the test's `browseRoot` MATCHES the handler's symlink-resolved canonical root
	// (the traversal guard now compares REAL on-disk paths). On platforms whose tmpdir is itself a
	// symlink (macOS `/var` → `/private/var`) the raw mkdtemp path and the canonical path differ; using
	// the canonical form here keeps every `path === browseRoot` assertion correct cross-platform.
	browseRoot = realpathSync(mkdtempSync(join(tmpdir(), "hc-browse-")));
	cacheDir = mkdtempSync(join(tmpdir(), "hc-onb-cache-"));
});
afterEach(() => {
	for (const d of [browseRoot, cacheDir]) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
});

/** A reader returning a fixed remote for a specific folder, else null. */
function readerFor(folder: string, remote: string): GitRemoteReader {
	return (cwd: string) => (cwd === folder ? remote : null);
}

function buildDaemon(opts: { mode?: RuntimeConfig["mode"]; readRemote?: GitRemoteReader } = {}): Daemon {
	const storage: StorageQuery = { async query() { return ok([], 0); } };
	const daemon = createDaemon({
		config: cfg({ mode: opts.mode ?? "local" }),
		storage: storage as never,
		logger: createRequestLogger({ silent: true }),
	});
	mountOnboardingApi(daemon, {
		org: "acme",
		workspace: "backend",
		projectsDir: cacheDir,
		browseRoot,
		...(opts.readRemote !== undefined ? { readRemote: opts.readRemote } : {}),
	});
	return daemon;
}

function readCache(): { bindings: Array<{ path: string; projectId: string }>; projects: Array<{ projectId: string; remoteSignal: string }> } {
	return JSON.parse(readFileSync(join(cacheDir, "projects.json"), "utf8"));
}

describe("PRD-059b GET /api/diagnostics/fs/browse (b-AC-2 / b-AC-3)", () => {
	it("lists immediate child directories with absolute paths, marking git repos", async () => {
		mkdirSync(join(browseRoot, "repo-a", ".git"), { recursive: true });
		mkdirSync(join(browseRoot, "plain-dir"), { recursive: true });
		writeFileSync(join(browseRoot, "a-file.txt"), "x"); // a FILE must not appear (dirs only).
		const daemon = buildDaemon();
		const res = await daemon.app.request(`/api/diagnostics/fs/browse?path=${encodeURIComponent(browseRoot)}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as BrowseBody;
		const names = body.children.map((ch) => ch.name);
		expect(names).toEqual(["plain-dir", "repo-a"]); // sorted, dirs only, no file.
		const repo = body.children.find((ch) => ch.name === "repo-a")!;
		expect(repo.isGitRepo).toBe(true); // b-AC-3: git marker.
		expect(repo.path).toBe(join(browseRoot, "repo-a")); // b-AC-2: real absolute path.
		const plain = body.children.find((ch) => ch.name === "plain-dir")!;
		expect(plain.isGitRepo).toBe(false);
	});

	it("refuses to traverse outside the allowed root (clamps an escape back to root)", async () => {
		const daemon = buildDaemon();
		// Attempt to escape upward with an absolute parent path.
		const res = await daemon.app.request(`/api/diagnostics/fs/browse?path=${encodeURIComponent(join(browseRoot, "..", ".."))}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as BrowseBody;
		expect(body.path).toBe(browseRoot); // clamped to the root, never above it.
		expect(body.parent).toBeNull(); // at the root → no climb above.
	});

	it("refuses to traverse outside the root through a symlink/junction planted INSIDE it (CWE-22)", async () => {
		// Plant a directory OUTSIDE the allowed root holding a secret child, then a symlink/junction
		// INSIDE the root that targets it. A purely-lexical clamp would let `?path=<root>/escape` pass
		// (it is lexically under root) and the OS would happily enumerate the outside target. The guard
		// must compare REAL on-disk paths so the link's outside target is refused.
		const outside = mkdtempSync(join(tmpdir(), "hc-outside-"));
		mkdirSync(join(outside, "secret-dir"));
		let linkMade = true;
		try {
			symlinkSync(outside, join(browseRoot, "escape"), "junction");
		} catch {
			linkMade = false; // unprivileged Windows runner without symlink rights — skip the assertion.
		}
		try {
			if (!linkMade) return;
			const daemon = buildDaemon();
			// Browse the in-root link directly: its REAL target is outside → clamp back to the root.
			const res = await daemon.app.request(`/api/diagnostics/fs/browse?path=${encodeURIComponent(join(browseRoot, "escape"))}`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as BrowseBody;
			// The clamp returned the root, NOT the outside target — so the outside "secret-dir" never leaks.
			expect(body.path).toBe(browseRoot);
			expect(body.children.map((ch) => ch.name)).not.toContain("secret-dir");
			// And a deeper climb through the link (escape/secret-dir) is equally refused.
			const deep = await daemon.app.request(`/api/diagnostics/fs/browse?path=${encodeURIComponent(join(browseRoot, "escape", "secret-dir"))}`);
			expect(((await deep.json()) as BrowseBody).path).toBe(browseRoot);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("is NOT served in team mode (local-mode-only — security F-1)", async () => {
		const daemon = buildDaemon({ mode: "team" });
		const res = await daemon.app.request(`/api/diagnostics/fs/browse?path=${encodeURIComponent(browseRoot)}`);
		expect([401, 403, 404]).toContain(res.status);
		expect(res.status).not.toBe(200);
	});
});

describe("PRD-059b POST /api/diagnostics/projects/bind (b-AC-4)", () => {
	it("binds the folder to a git-suggested name and writes the 049a store (single-sourced)", async () => {
		const folder = join(browseRoot, "my-repo");
		mkdirSync(folder, { recursive: true });
		const daemon = buildDaemon({ readRemote: readerFor(folder, "git@github.com:acme/api.git") });
		const res = await daemon.app.request("/api/diagnostics/projects/bind", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: folder }),
		});
		expect(res.status).toBe(200);
		const ack = (await res.json()) as BindAck;
		expect(ack.bound).toBe(true);
		expect(ack.path).toBe(folder); // absolute path recorded (b-AC-4).
		expect(ack.projectId).toBe("api"); // suggested from the canonical git remote's repo segment.
		const cache = readCache();
		expect(cache.bindings).toContainEqual({ path: folder, projectId: "api" });
		expect(cache.projects.find((p) => p.projectId === "api")?.remoteSignal).toBe("github.com/acme/api");
	});

	it("honors an explicit name and rejects a non-absolute path", async () => {
		const folder = join(browseRoot, "web");
		mkdirSync(folder, { recursive: true });
		const daemon = buildDaemon();
		const ok = await daemon.app.request("/api/diagnostics/projects/bind", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: folder, name: "web-app" }),
		});
		expect(((await ok.json()) as BindAck).projectId).toBe("web-app");

		const bad = await daemon.app.request("/api/diagnostics/projects/bind", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "relative/not/absolute" }),
		});
		expect(bad.status).toBe(400);
	});

	it("rejects binding the reserved __unsorted__ inbox id", async () => {
		const folder = join(browseRoot, "scratch");
		mkdirSync(folder, { recursive: true });
		const daemon = buildDaemon();
		const res = await daemon.app.request("/api/diagnostics/projects/bind", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: folder, name: "__unsorted__" }),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as BindAck).bound).toBe(false);
	});
});

describe("PRD-059d POST /api/diagnostics/projects/bind-existing (d-AC-2)", () => {
	it("binds a local folder to an EXISTING project_id without recording a new remote", async () => {
		const folder = join(browseRoot, "desktop-api");
		mkdirSync(folder, { recursive: true });
		const daemon = buildDaemon({ readRemote: readerFor(folder, "git@github.com:acme/api.git") });
		const res = await daemon.app.request("/api/diagnostics/projects/bind-existing", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: folder, projectId: "existing-api" }),
		});
		expect(res.status).toBe(200);
		const ack = (await res.json()) as BindAck;
		expect(ack.bound).toBe(true);
		expect(ack.projectId).toBe("existing-api"); // bound to the chosen registry id (d-AC-2).
		const cache = readCache();
		expect(cache.bindings).toContainEqual({ path: folder, projectId: "existing-api" });
		// bind-existing does NOT stamp a remote (the registry keeps its own remote_signal).
		expect(cache.projects.find((p) => p.projectId === "existing-api")?.remoteSignal).toBe("");
	});
});

describe("PRD-059c POST /api/diagnostics/projects/unbind", () => {
	it("removes the local folder binding, leaving the registry projects copy intact", async () => {
		const folder = join(browseRoot, "api");
		mkdirSync(folder, { recursive: true });
		const daemon = buildDaemon();
		// First bind it, then unbind.
		await daemon.app.request("/api/diagnostics/projects/bind", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: folder, name: "api" }),
		});
		expect(readCache().bindings.length).toBe(1);

		const res = await daemon.app.request("/api/diagnostics/projects/unbind", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: folder }),
		});
		expect(res.status).toBe(200);
		const ack = (await res.json()) as UnbindAck;
		expect(ack.unbound).toBe(true);
		const cache = readCache();
		expect(cache.bindings).toEqual([]); // local binding removed.
		// The registry projects copy (the inline-created project) is UNTOUCHED by unbind.
		expect(cache.projects.find((p) => p.projectId === "api")).toBeDefined();
	});

	it("returns unbound:false when no binding matches the folder", async () => {
		const daemon = buildDaemon();
		const res = await daemon.app.request("/api/diagnostics/projects/unbind", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: join(browseRoot, "never-bound") }),
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as UnbindAck).unbound).toBe(false);
	});
});
