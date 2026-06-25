/**
 * PRD-049a a-AC-5 — per-REQUEST, cwd-aware scope resolution.
 *
 * `resolveRequestScope({cwd})` extends the 011a tenancy resolution (org/workspace
 * partition + the integrity gate, UNCHANGED) with the cwd-resolved PROJECT within
 * that workspace. The load-bearing assertion (a-AC-5) is STRUCTURAL: when a binding
 * resolves a project, `credentials.json.workspaceId` is consulted ONLY as the
 * fallback DEFAULT (the partition the project lives in), NEVER as the authoritative
 * active project. Two concurrent cwds resolve two projects in the SAME workspace.
 *
 * Verification posture: a temp `~/.deeplake` projects cache (`projectsDir`) + an
 * injected git reader + injected credentials, so no real home dir, no real git, no
 * network. Tokens are minted via `encodeStubToken` so the integrity gate passes.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Credentials, encodeStubToken } from "../../../../src/daemon/runtime/auth/contracts.js";
import { resolveRequestScope } from "../../../../src/daemon/runtime/auth/tenancy-resolution.js";
import {
	type ProjectsCache,
	UNSORTED_PROJECT_ID,
	projectsCachePath,
} from "../../../../src/hooks/shared/project-resolver.js";

/** A credentials record whose token decodes back to `org` (passes the integrity gate). */
function credsFor(org: string, workspace: string): Credentials {
	return {
		token: encodeStubToken({ org, workspace, agentId: "agent-1" }),
		orgId: org,
		orgName: `${org} Inc`,
		workspace,
		agentId: "agent-1",
		savedAt: "2026-06-01T00:00:00.000Z",
	};
}

/** Write a schema-valid projects.json into the temp cache dir. */
function writeCache(dir: string, cache: ProjectsCache): void {
	writeFileSync(projectsCachePath(dir), `${JSON.stringify(cache, null, 2)}\n`);
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-reqscope-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("a-AC-5 resolveRequestScope threads Org→Workspace→Project per request", () => {
	it("resolves the cwd's bound project WITHIN the credential's workspace partition", () => {
		const cwd = join(dir, "work", "api");
		writeCache(dir, {
			schemaVersion: 1,
			org: "acme",
			workspace: "ws-main",
			bindings: [{ path: cwd, projectId: "proj-api" }],
			projects: [],
		});
		const result = resolveRequestScope({
			cwd,
			credentials: credsFor("acme", "ws-main"),
			env: {},
			projectsDir: dir,
		});
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		// The PARTITION is the credential's workspace (unchanged 011a isolation)…
		expect(result.scope.tenancy.scope.workspace).toBe("ws-main");
		expect(result.scope.tenancy.scope.org).toBe("acme");
		// …and the PROJECT is the cwd binding, not the workspace id (a-AC-5).
		expect(result.scope.project.projectId).toBe("proj-api");
		expect(result.scope.project.bound).toBe(true);
		expect(result.scope.project.source).toBe("binding");
	});

	it("STRUCTURAL a-AC-5: the resolved project is NOT the workspaceId when a binding resolves one", () => {
		const cwd = join(dir, "work", "api");
		const workspaceId = "ws-main";
		writeCache(dir, {
			schemaVersion: 1,
			org: "acme",
			workspace: workspaceId,
			bindings: [{ path: cwd, projectId: "proj-api" }],
			projects: [],
		});
		const result = resolveRequestScope({
			cwd,
			credentials: credsFor("acme", workspaceId),
			env: {},
			projectsDir: dir,
		});
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		// The project authority is the binding — the workspaceId is NEVER adopted as
		// the active project. (If the seam wrongly used workspaceId as the project,
		// projectId would equal "ws-main".)
		expect(result.scope.project.projectId).not.toBe(workspaceId);
		expect(result.scope.project.projectId).toBe("proj-api");
	});

	it("workspaceId is the FALLBACK only: an identity-less cwd → inbox, partition still set", () => {
		const cwd = join(dir, "scratch", "spike"); // no binding, no git
		const result = resolveRequestScope({
			cwd,
			credentials: credsFor("acme", "ws-main"),
			env: {},
			projectsDir: dir, // no cache file written → fail-soft empty
		});
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		// Falls to the inbox (never throws), but the workspace partition is still the
		// credential's workspace — workspaceId is the fallback default (a-AC-5).
		expect(result.scope.project.projectId).toBe(UNSORTED_PROJECT_ID);
		expect(result.scope.project.bound).toBe(false);
		expect(result.scope.tenancy.scope.workspace).toBe("ws-main");
	});

	it("two concurrent cwds resolve two projects in the SAME workspace (a-AC-2 at the request seam)", () => {
		const apiDir = join(dir, "work", "api");
		const webDir = join(dir, "work", "web");
		writeCache(dir, {
			schemaVersion: 1,
			org: "acme",
			workspace: "ws-main",
			bindings: [
				{ path: apiDir, projectId: "proj-api" },
				{ path: webDir, projectId: "proj-web" },
			],
			projects: [],
		});
		const creds = credsFor("acme", "ws-main");
		const a = resolveRequestScope({ cwd: apiDir, credentials: creds, env: {}, projectsDir: dir });
		const b = resolveRequestScope({ cwd: webDir, credentials: creds, env: {}, projectsDir: dir });
		expect(a.kind).toBe("ok");
		expect(b.kind).toBe("ok");
		if (a.kind !== "ok" || b.kind !== "ok") return;
		expect(a.scope.project.projectId).toBe("proj-api");
		expect(b.scope.project.projectId).toBe("proj-web");
		// Same partition, different projects — per-session project identity (a-AC-2).
		expect(a.scope.tenancy.scope.workspace).toBe(b.scope.tenancy.scope.workspace);
		expect(a.scope.project.projectId).not.toBe(b.scope.project.projectId);
	});

	it("a git remote matching a synced registry project binds it per request (a-AC-4)", () => {
		const cwd = join(dir, "fresh-clone");
		writeCache(dir, {
			schemaVersion: 1,
			org: "acme",
			workspace: "ws-main",
			bindings: [],
			projects: [{ projectId: "proj-api", name: "API", remoteSignal: "github.com/acme/api", boundPaths: [] }],
		});
		const result = resolveRequestScope({
			cwd,
			credentials: credsFor("acme", "ws-main"),
			env: {},
			projectsDir: dir,
			readRemote: () => "git@github.com:acme/api.git",
		});
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.scope.project.projectId).toBe("proj-api");
		expect(result.scope.project.source).toBe("git");
	});

	it("fails CLOSED before project resolution when tenancy integrity fails (no creds)", () => {
		const result = resolveRequestScope({
			cwd: join(dir, "x"),
			credentials: null,
			env: {},
			projectsDir: dir,
		});
		expect(result.kind).toBe("denied");
		if (result.kind !== "denied") return;
		expect(result.reason).toContain("no credentials");
	});
});
