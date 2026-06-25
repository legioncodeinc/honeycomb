/**
 * PRD-049d — `honeycomb project list/bind/use/status` CLI (each AC-named).
 *
 * Verification posture: a temp `~/.deeplake` dir holding BOTH the shared credentials file (the
 * Hivemind disk shape, seeded with an `encodeStubToken` token so the 011a integrity gate passes) AND
 * the local `projects.json` cache the bind/use verbs write + the status verb reads. A fixed `cwd` and
 * an injected git reader drive resolution deterministically — no real `~/.deeplake`, no real git, no
 * network. The CLI imports NO daemon/storage path (the invariant test enforces it separately).
 *
 * 49d-AC-2 `project bind <p>` writes the cwd→project binding; a subsequent resolve returns `<p>`.
 * 49d-AC-3 `project use`/`bind` perform NO token re-mint (the credential token is byte-identical after).
 * 49d-AC-4 two cwds: a bind/use in one folder leaves the OTHER folder's resolved scope unchanged.
 * 49d-AC-5 `project status` reports Org→Workspace→Project (or __unsorted__) + agent; marks unbound.
 * 49d-AC-6 `HONEYCOMB_PROJECT_ID` overrides the cwd-resolved project (PRD-011 parity).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type Clock,
	type DiskCredentials,
	credentialsPath,
	encodeStubToken,
	saveDiskCredentials,
} from "../../src/daemon/runtime/auth/index.js";
import { type ProjectResult, runProjectCommand } from "../../src/cli/project.js";
import {
	loadProjectsCache,
	resolveScope,
	type GitRemoteReader,
} from "../../src/hooks/shared/index.js";

const FIXED = "2026-06-20T12:00:00.000Z";
const ORG = "org-acme-222";
const WORKSPACE = "backend";

function clock(): Clock {
	return { now: () => FIXED };
}

/**
 * Seed a Hivemind-shape `~/.deeplake/credentials.json` whose token DECODES back to `ORG` (so the
 * 011a integrity gate `project status` runs passes). The token is the secret we assert is never
 * re-minted by bind/use (49d-AC-3).
 */
function seedDisk(dir: string, over: Partial<DiskCredentials> = {}): DiskCredentials {
	const base: DiskCredentials = {
		token: encodeStubToken({ org: ORG, workspace: WORKSPACE, agentId: "agent-1" }),
		orgId: ORG,
		orgName: "Acme Inc",
		userName: "Ada",
		workspaceId: WORKSPACE,
		agentId: "agent-1",
		apiUrl: "https://api.deeplake.ai",
		savedAt: "",
		...over,
	};
	return saveDiskCredentials(base, dir, clock());
}

function readDisk(dir: string): DiskCredentials {
	return JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as DiskCredentials;
}

function captured(): { out: (l: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { out: (l: string) => lines.push(l), lines };
}

/** A git reader that always returns the same remote (the git-signal branch driver). */
function fixedRemote(url: string | null): GitRemoteReader {
	return () => url;
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-proj-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("49d-AC-2 project bind writes the folder→project mapping and the round-trip resolves it", () => {
	it("binds the cwd to <p> so resolveScope(cwd) returns <p> (the 049a/049b round-trip)", () => {
		seedDisk(dir);
		const cwd = join(dir, "work", "api");
		const cap = captured();
		const result: ProjectResult = runProjectCommand(
			{ command: "bind", arg: "api" },
			{ dir, cwd, env: {}, readRemote: fixedRemote(null), out: cap.out, clock: clock() },
		);
		expect(result.exitCode).toBe(0);
		expect(result.wrote).toBe(true);

		// Prove the round-trip: the resolver (the capture/recall hot path) now resolves <p> for cwd.
		const cache = loadProjectsCache(dir);
		const resolved = resolveScope({ cwd, cache, org: ORG, workspace: WORKSPACE });
		expect(resolved.projectId).toBe("api");
		expect(resolved.bound).toBe(true);
		expect(resolved.source).toBe("binding");
	});

	it("creates the project INLINE when absent (operator decision: that is the point)", () => {
		seedDisk(dir);
		const cwd = join(dir, "work", "newproj");
		runProjectCommand(
			{ command: "bind", arg: "brand-new" },
			{ dir, cwd, env: {}, readRemote: fixedRemote(null), out: () => {}, clock: clock() },
		);
		const cache = loadProjectsCache(dir);
		// The inline-created project is in the cached registry copy (so the daemon sync can mirror it).
		expect(cache.projects.some((p) => p.projectId === "brand-new")).toBe(true);
		expect(cache.org).toBe(ORG);
		expect(cache.workspace).toBe(WORKSPACE);
	});

	it("derives the name from the git remote when no <p> is given", () => {
		seedDisk(dir);
		const cwd = join(dir, "work", "anything");
		const result = runProjectCommand(
			{ command: "bind" },
			{ dir, cwd, env: {}, readRemote: fixedRemote("git@github.com:acme/widget.git"), out: () => {}, clock: clock() },
		);
		expect(result.exitCode).toBe(0);
		const cache = loadProjectsCache(dir);
		const resolved = resolveScope({ cwd, cache, org: ORG, workspace: WORKSPACE });
		// The canonical remote's repo segment is the derived id.
		expect(resolved.projectId).toBe("widget");
	});
});

describe("49d-AC-3 bind/use perform NO token re-mint (a project is not a token claim)", () => {
	it("leaves the credential token byte-identical after bind AND use", () => {
		seedDisk(dir);
		const before = readDisk(dir).token;
		const cwd = join(dir, "work", "api");

		runProjectCommand(
			{ command: "bind", arg: "api" },
			{ dir, cwd, env: {}, readRemote: fixedRemote(null), out: () => {}, clock: clock() },
		);
		expect(readDisk(dir).token).toBe(before);

		runProjectCommand(
			{ command: "use", arg: "other" },
			{ dir, cwd, env: {}, readRemote: fixedRemote(null), out: () => {}, clock: clock() },
		);
		// The credential is untouched by a project verb — only projects.json changed (no re-mint).
		expect(readDisk(dir).token).toBe(before);
	});
});

describe("49d-AC-4 two cwds do not interfere (session-safe, NO machine-global active project)", () => {
	it("a bind in folder A leaves folder B's resolved scope unchanged", () => {
		seedDisk(dir);
		const folderA = join(dir, "work", "api");
		const folderB = join(dir, "scratch", "spike");

		// Bind ONLY folder A.
		runProjectCommand(
			{ command: "bind", arg: "api" },
			{ dir, cwd: folderA, env: {}, readRemote: fixedRemote(null), out: () => {}, clock: clock() },
		);

		// Folder B (a different cwd, never bound, no git) still resolves to the inbox — folder A's
		// bind did NOT mutate a machine-global active-project field that B would read.
		const cache = loadProjectsCache(dir);
		const aScope = resolveScope({ cwd: folderA, cache, org: ORG, workspace: WORKSPACE });
		const bScope = resolveScope({ cwd: folderB, cache, org: ORG, workspace: WORKSPACE });
		expect(aScope.projectId).toBe("api");
		expect(aScope.bound).toBe(true);
		expect(bScope.bound).toBe(false);
		expect(bScope.projectId).toBe("__unsorted__");
	});

	it("a use in folder B does not perturb folder A's prior binding", () => {
		seedDisk(dir);
		const folderA = join(dir, "work", "api");
		const folderB = join(dir, "scratch", "spike");
		runProjectCommand(
			{ command: "bind", arg: "api" },
			{ dir, cwd: folderA, env: {}, readRemote: fixedRemote(null), out: () => {}, clock: clock() },
		);
		runProjectCommand(
			{ command: "use", arg: "spike-proj" },
			{ dir, cwd: folderB, env: {}, readRemote: fixedRemote(null), out: () => {}, clock: clock() },
		);
		const cache = loadProjectsCache(dir);
		// Both folders keep THEIR OWN resolution — neither write clobbered the other.
		expect(resolveScope({ cwd: folderA, cache, org: ORG, workspace: WORKSPACE }).projectId).toBe("api");
		expect(resolveScope({ cwd: folderB, cache, org: ORG, workspace: WORKSPACE }).projectId).toBe("spike-proj");
	});
});

describe("49d-AC-5 project status reports the resolved scope for the current cwd", () => {
	it("reports Org→Workspace→Project + agent for a BOUND folder", () => {
		seedDisk(dir);
		const cwd = join(dir, "work", "api");
		runProjectCommand(
			{ command: "bind", arg: "api" },
			{ dir, cwd, env: {}, readRemote: fixedRemote(null), out: () => {}, clock: clock() },
		);
		const cap = captured();
		const result = runProjectCommand(
			{ command: "status" },
			{ dir, cwd, env: {}, readRemote: fixedRemote(null), out: cap.out, clock: clock() },
		);
		expect(result.exitCode).toBe(0);
		const text = cap.lines.join("\n");
		expect(text).toContain(ORG);
		expect(text).toContain(WORKSPACE);
		expect(text).toContain("api");
		expect(text).toContain("agent-1");
		// The token is NEVER printed (D-4).
		expect(text).not.toContain(readDisk(dir).token);
	});

	it("marks an UNBOUND folder explicitly as the __unsorted__ inbox", () => {
		seedDisk(dir);
		const cwd = join(dir, "scratch", "spike");
		const cap = captured();
		runProjectCommand(
			{ command: "status" },
			{ dir, cwd, env: {}, readRemote: fixedRemote(null), out: cap.out, clock: clock() },
		);
		const text = cap.lines.join("\n");
		expect(text).toContain("__unsorted__");
		expect(text.toUpperCase()).toContain("UNBOUND");
	});
});

describe("49d-AC-6 HONEYCOMB_PROJECT_ID overrides the cwd-resolved project (PRD-011 parity)", () => {
	it("the env override wins over a folder binding for the same cwd", () => {
		seedDisk(dir);
		const cwd = join(dir, "work", "api");
		// Bind the folder to `api`…
		runProjectCommand(
			{ command: "bind", arg: "api" },
			{ dir, cwd, env: {}, readRemote: fixedRemote(null), out: () => {}, clock: clock() },
		);
		// …but with HONEYCOMB_PROJECT_ID set, status reports the OVERRIDE, not the binding (49d-AC-6).
		const cap = captured();
		runProjectCommand(
			{ command: "status" },
			{
				dir,
				cwd,
				env: { HONEYCOMB_PROJECT_ID: "ci-pinned" },
				readRemote: fixedRemote(null),
				out: cap.out,
				clock: clock(),
			},
		);
		const text = cap.lines.join("\n");
		expect(text).toContain("ci-pinned");
		expect(text).not.toContain("api (resolved");
	});

	it("an empty HONEYCOMB_PROJECT_ID is treated as ABSENT (the binding resolves)", () => {
		seedDisk(dir);
		const cwd = join(dir, "work", "api");
		runProjectCommand(
			{ command: "bind", arg: "api" },
			{ dir, cwd, env: {}, readRemote: fixedRemote(null), out: () => {}, clock: clock() },
		);
		const cap = captured();
		runProjectCommand(
			{ command: "status" },
			{ dir, cwd, env: { HONEYCOMB_PROJECT_ID: "   " }, readRemote: fixedRemote(null), out: cap.out, clock: clock() },
		);
		expect(cap.lines.join("\n")).toContain("api");
	});
});

describe("project list shows the active workspace's registry projects", () => {
	it("marks the project the current folder resolves to", () => {
		seedDisk(dir);
		const cwd = join(dir, "work", "api");
		runProjectCommand(
			{ command: "bind", arg: "api" },
			{ dir, cwd, env: {}, readRemote: fixedRemote(null), out: () => {}, clock: clock() },
		);
		const cap = captured();
		const result = runProjectCommand(
			{ command: "list" },
			{ dir, cwd, env: {}, readRemote: fixedRemote(null), out: cap.out, clock: clock() },
		);
		expect(result.exitCode).toBe(0);
		const text = cap.lines.join("\n");
		expect(text).toContain("api");
		expect(text).toContain("(this folder)");
	});

	it("prints a bind hint when the workspace has no projects yet", () => {
		seedDisk(dir);
		const cap = captured();
		runProjectCommand(
			{ command: "list" },
			{ dir, cwd: join(dir, "empty"), env: {}, readRemote: fixedRemote(null), out: cap.out, clock: clock() },
		);
		expect(cap.lines.join("\n").toLowerCase()).toContain("project bind");
	});
});

describe("not-logged-in + usage", () => {
	it("prints a login prompt when no credential is present", () => {
		const cap = captured();
		const result = runProjectCommand(
			{ command: "status" },
			{ dir, cwd: dir, env: {}, readRemote: fixedRemote(null), out: cap.out, clock: clock() },
		);
		// status returns a non-error exit so a script can branch on "not logged in".
		expect(result.exitCode).toBe(0);
		expect(cap.lines.join("\n")).toContain("Not logged in");
	});

	it("prints usage for an unknown sub-command", () => {
		const cap = captured();
		const result = runProjectCommand({ command: "frobnicate" }, { dir, cwd: dir, env: {}, out: cap.out });
		expect(result.exitCode).toBe(1);
		expect(cap.lines.join("\n")).toContain("usage: honeycomb project");
	});
});
