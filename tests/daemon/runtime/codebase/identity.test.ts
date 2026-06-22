/**
 * PRD-014 daemon-assembly wiring — snapshot-identity resolution (`identity.ts`).
 *
 * The build's identity tuple `(org, workspace, repo, user, worktree, commit)` is what the
 * deferred wiring needed to feed the worker. The tenant half comes from the scope; the repo
 * half from git probes. This suite proves both the git-present and the fail-soft (non-git)
 * branches through the INJECTABLE {@link GitProbe} seam — no real `git`.
 */

import { describe, expect, it } from "vitest";

import {
	type GitProbe,
	repoSlugFromOrigin,
	resolveSnapshotIdentity,
} from "../../../../src/daemon/runtime/codebase/identity.js";
import type { QueryScope } from "../../../../src/daemon/storage/client.js";

const SCOPE: QueryScope = { org: "acme", workspace: "default" };

/** A realistic 40-hex git object name — the shape `git rev-parse HEAD` always emits. */
const HEAD_SHA = "1f0a9c3e5b7d2048a6c1e3f50917bd24ae6f0c1b";

/** A git probe that answers from a fixed record (null where a field is "unavailable"). */
function fakeGit(over: Partial<Record<keyof GitProbe, string | null>> = {}): GitProbe {
	return {
		headCommit: () => (over.headCommit !== undefined ? over.headCommit : HEAD_SHA),
		originUrl: () => (over.originUrl !== undefined ? over.originUrl : "git@github.com:acme/honeycomb.git"),
		worktreeRoot: () => (over.worktreeRoot !== undefined ? over.worktreeRoot : "/home/u/honeycomb"),
	};
}

describe("repoSlugFromOrigin", () => {
	it("derives the slug from an ssh remote", () => {
		expect(repoSlugFromOrigin("git@github.com:acme/honeycomb.git")).toBe("honeycomb");
	});
	it("derives the slug from an https remote", () => {
		expect(repoSlugFromOrigin("https://github.com/acme/honeycomb.git")).toBe("honeycomb");
	});
	it("returns null for an unusable url", () => {
		expect(repoSlugFromOrigin("")).toBe(null);
	});
});

describe("resolveSnapshotIdentity", () => {
	it("maps the tenant half from the scope and the repo half from git", () => {
		const id = resolveSnapshotIdentity("/home/u/honeycomb", SCOPE, { git: fakeGit(), user: "alice" });
		expect(id.org).toBe("acme");
		expect(id.workspace).toBe("default");
		expect(id.repo).toBe("honeycomb");
		expect(id.user).toBe("alice");
		expect(id.worktree).toBe("/home/u/honeycomb");
		expect(id.commit).toBe(HEAD_SHA);
	});

	it("rejects a non-OID commit probe output to '' (path-traversal defense-in-depth)", () => {
		// `<commit>.json` names a snapshot FILE on the HTTP-reachable build path. A probe output
		// that is not a git object name (here a traversal payload) must collapse to "" — which the
		// 014c push skips and the local write names by sha256 — never reaching the path layer.
		for (const evil of ["../../etc/passwd", "..\\..\\win", "a/b", "deadbeef", "DEADBEEF", "head; rm -rf /"]) {
			const git = fakeGit({ headCommit: evil });
			expect(resolveSnapshotIdentity("/home/u/honeycomb", SCOPE, { git }).commit).toBe("");
		}
	});

	it("accepts a 64-hex (SHA-256) object name unchanged", () => {
		const sha256 = "a".repeat(64);
		const git = fakeGit({ headCommit: sha256 });
		expect(resolveSnapshotIdentity("/home/u/honeycomb", SCOPE, { git }).commit).toBe(sha256);
	});

	it("fails soft on a non-git workspace: repo ← dir basename, commit ← '' (push self-skips, no throw)", () => {
		const git = fakeGit({ headCommit: null, originUrl: null, worktreeRoot: null });
		const id = resolveSnapshotIdentity("/tmp/scratch-project", SCOPE, { git, user: "u1" });
		expect(id.repo).toBe("scratch-project"); // basename fallback (no origin remote).
		expect(id.worktree).toBe("/tmp/scratch-project"); // workspace dir fallback.
		expect(id.commit).toBe(""); // no HEAD → empty commit → 014c push skips "no-commit".
	});

	it("defaults the workspace to 'default' when the scope omits it", () => {
		const id = resolveSnapshotIdentity("/home/u/honeycomb", { org: "acme" }, { git: fakeGit(), user: "u1" });
		expect(id.workspace).toBe("default");
	});
});
