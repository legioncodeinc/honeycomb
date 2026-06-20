/**
 * PRD-011a + PRD-023 Wave 3 — `honeycomb org/workspace/workspaces/status` CLI (each AC-named).
 *
 * Verification posture: a FAKE {@link DeeplakeAuthClient} (canned listOrgs/listWorkspaces/reMint) + a
 * temp credentials dir (the SHARED `~/.deeplake` shape) + a fake clock. No real auth server, no real
 * `~/.deeplake`. The CLI imports NO daemon/storage path (the invariant test enforces it separately).
 *
 * PRD-023 Wave 3 MIGRATED `org switch` off the PRD-011 stub TokenIssuer onto the real client, and
 * added `org list` (AC-4), `workspaces` / `workspace switch` (AC-5). The `workspace use` alias +
 * `status` keep their PRD-011a behavior.
 *
 * AC-4 `org list` prints the accessible orgs (active marked); `org switch <name|id>` re-mints a fresh
 *      org-bound token and updates the shared file's orgId/orgName/token (by NAME and by id).
 * AC-5 `workspaces` prints the org's workspaces (active marked); `workspace switch <name|id>` updates
 *      the shared file's `workspaceId` (resolving a NAME → id), no re-mint.
 * a-AC-6 `status` prints org id/name/workspace/agent and NEVER the bearer token.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type Clock,
	type DeeplakeAuthClient,
	type DeviceCodeResponse,
	type DeviceTokenResponse,
	type DiskCredentials,
	type MeResponse,
	type OrgRow,
	type WorkspaceRow,
	credentialsPath,
	saveDiskCredentials,
} from "../../src/daemon/runtime/auth/index.js";
import { type OrgResult, runOrgCommand } from "../../src/cli/org.js";

const FIXED = "2026-06-20T12:00:00.000Z";
const SEED_TOKEN = "dl-seed-token-OLD-must-never-print";
const MINTED_TOKEN = "dl-minted-token-NEW-acme-999";

function clock(): Clock {
	return { now: () => FIXED };
}

/** Seed a Hivemind-shape `~/.deeplake/credentials.json` in the temp dir. */
function seedDisk(dir: string, over: Partial<DiskCredentials> = {}): DiskCredentials {
	const base: DiskCredentials = {
		token: SEED_TOKEN,
		orgId: "org-old-111",
		orgName: "Old Org",
		userName: "Ada",
		workspaceId: "backend",
		apiUrl: "https://api.deeplake.ai",
		savedAt: "",
		...over,
	};
	return saveDiskCredentials(base, dir, clock());
}

/** A configurable fake of the real auth client — only the methods the org CLI calls are scripted. */
function fakeClient(opts: {
	orgs?: OrgRow[];
	workspaces?: WorkspaceRow[];
	reMintToken?: string;
	reMintThrows?: boolean;
	onReMint?: (orgId: string) => void;
}): DeeplakeAuthClient {
	return {
		apiUrl: "https://api.deeplake.ai",
		async getMe(): Promise<MeResponse> {
			return { id: "u-1", name: "Ada" };
		},
		async listOrgs(): Promise<OrgRow[]> {
			return opts.orgs ?? [];
		},
		async listWorkspaces(): Promise<WorkspaceRow[]> {
			return opts.workspaces ?? [];
		},
		async reMint(_token: string, orgId: string): Promise<string> {
			opts.onReMint?.(orgId);
			if (opts.reMintThrows) throw new Error("mint failed");
			return opts.reMintToken ?? MINTED_TOKEN;
		},
		async requestDeviceCode(): Promise<DeviceCodeResponse> {
			throw new Error("not used");
		},
		async pollDeviceToken(): Promise<DeviceTokenResponse | "pending"> {
			throw new Error("not used");
		},
	};
}

function readDisk(dir: string): DiskCredentials {
	return JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as DiskCredentials;
}

function captured(): { out: (l: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { out: (l: string) => lines.push(l), lines };
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-org-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("AC-4 org list prints the accessible orgs, marking the active one", () => {
	it("lists orgs and marks the active org", async () => {
		seedDisk(dir, { orgId: "org-old-111" });
		const cap = captured();
		const client = fakeClient({
			orgs: [
				{ id: "org-old-111", name: "Old Org" },
				{ id: "org-acme-222", name: "Acme Inc" },
			],
		});
		const res: OrgResult = await runOrgCommand({ path: ["org", "list"] }, { client, dir, env: {}, out: cap.out });
		expect(res.exitCode).toBe(0);
		expect(res.wrote).toBe(false);
		const text = cap.lines.join("\n");
		expect(text).toContain("Old Org");
		expect(text).toContain("Acme Inc");
		expect(text).toContain("org-acme-222");
		// The active org is marked.
		expect(text).toMatch(/Old Org.*\(active\)/);
	});
});

describe("AC-4 org switch re-mints a fresh org-bound token + updates the shared file", () => {
	it("switches by NAME → re-mints + persists new orgId/orgName/token", async () => {
		seedDisk(dir);
		const cap = captured();
		const seenOrg: string[] = [];
		const client = fakeClient({
			orgs: [
				{ id: "org-old-111", name: "Old Org" },
				{ id: "org-acme-222", name: "Acme Inc" },
			],
			reMintToken: MINTED_TOKEN,
			onReMint: (o) => seenOrg.push(o),
		});
		const res = await runOrgCommand(
			{ path: ["org", "switch"], arg: "Acme Inc" },
			{ client, dir, clock: clock(), env: {}, out: cap.out },
		);
		expect(res.exitCode).toBe(0);
		expect(res.wrote).toBe(true);
		// Re-mint was scoped to the RESOLVED org id (name → id).
		expect(seenOrg).toEqual(["org-acme-222"]);
		const onDisk = readDisk(dir);
		expect(onDisk.orgId).toBe("org-acme-222");
		expect(onDisk.orgName).toBe("Acme Inc");
		expect(onDisk.token).toBe(MINTED_TOKEN);
		expect(onDisk.savedAt).toBe(FIXED);
		// The token is NEVER printed.
		expect(cap.lines.join("\n")).not.toContain(MINTED_TOKEN);
		expect(cap.lines.join("\n")).not.toContain(SEED_TOKEN);
	});

	it("switches by ID → re-mints + persists", async () => {
		seedDisk(dir);
		const cap = captured();
		const client = fakeClient({
			orgs: [
				{ id: "org-old-111", name: "Old Org" },
				{ id: "org-acme-222", name: "Acme Inc" },
			],
		});
		const res = await runOrgCommand(
			{ path: ["org", "switch"], arg: "org-acme-222" },
			{ client, dir, clock: clock(), env: {}, out: cap.out },
		);
		expect(res.exitCode).toBe(0);
		expect(res.wrote).toBe(true);
		const onDisk = readDisk(dir);
		expect(onDisk.orgId).toBe("org-acme-222");
		expect(onDisk.token).toBe(MINTED_TOKEN);
	});

	it("fails closed (non-zero, no write) when the target org is not accessible", async () => {
		seedDisk(dir);
		const cap = captured();
		const client = fakeClient({ orgs: [{ id: "org-old-111", name: "Old Org" }] });
		const res = await runOrgCommand(
			{ path: ["org", "switch"], arg: "nope" },
			{ client, dir, clock: clock(), env: {}, out: cap.out },
		);
		expect(res.exitCode).toBe(1);
		expect(res.wrote).toBe(false);
		// The seeded org/token are untouched.
		expect(readDisk(dir).orgId).toBe("org-old-111");
		expect(readDisk(dir).token).toBe(SEED_TOKEN);
	});

	it("fails closed when the re-mint throws", async () => {
		seedDisk(dir);
		const cap = captured();
		const client = fakeClient({ orgs: [{ id: "org-acme-222", name: "Acme Inc" }], reMintThrows: true });
		const res = await runOrgCommand(
			{ path: ["org", "switch"], arg: "Acme Inc" },
			{ client, dir, clock: clock(), env: {}, out: cap.out },
		);
		expect(res.exitCode).toBe(1);
		expect(res.wrote).toBe(false);
	});
});

describe("AC-5 workspaces lists the org's workspaces, marking the active one", () => {
	it("lists workspaces and marks the active one", async () => {
		seedDisk(dir, { workspaceId: "ws-backend-1" });
		const cap = captured();
		const client = fakeClient({
			workspaces: [
				{ id: "ws-backend-1", name: "Backend" },
				{ id: "ws-frontend-2", name: "Frontend" },
			],
		});
		const res = await runOrgCommand({ path: ["workspaces"] }, { client, dir, env: {}, out: cap.out });
		expect(res.exitCode).toBe(0);
		expect(res.wrote).toBe(false);
		const text = cap.lines.join("\n");
		expect(text).toContain("Backend");
		expect(text).toContain("Frontend");
		expect(text).toMatch(/Backend.*\(active\)/);
	});

	it("`workspace list` is an alias of `workspaces`", async () => {
		seedDisk(dir, { workspaceId: "ws-backend-1" });
		const cap = captured();
		const client = fakeClient({ workspaces: [{ id: "ws-backend-1", name: "Backend" }] });
		const res = await runOrgCommand({ path: ["workspace", "list"] }, { client, dir, env: {}, out: cap.out });
		expect(res.exitCode).toBe(0);
		expect(cap.lines.join("\n")).toContain("Backend");
	});
});

describe("AC-5 workspace switch updates the shared file's workspaceId (resolve name → id, no re-mint)", () => {
	it("switches by NAME → resolves to id + persists workspaceId, token unchanged", async () => {
		const before = seedDisk(dir, { workspaceId: "ws-backend-1" });
		const cap = captured();
		const client = fakeClient({
			workspaces: [
				{ id: "ws-backend-1", name: "Backend" },
				{ id: "ws-frontend-2", name: "Frontend" },
			],
		});
		const res = await runOrgCommand(
			{ path: ["workspace", "switch"], arg: "Frontend" },
			{ client, dir, clock: clock(), env: {}, out: cap.out },
		);
		expect(res.exitCode).toBe(0);
		expect(res.wrote).toBe(true);
		const onDisk = readDisk(dir);
		// NAME → id resolution landed on the workspaceId field (Hivemind shape).
		expect(onDisk.workspaceId).toBe("ws-frontend-2");
		// No re-mint — the token is unchanged (AC-5).
		expect(onDisk.token).toBe(before.token);
	});

	it("switches by ID directly", async () => {
		seedDisk(dir, { workspaceId: "ws-backend-1" });
		const cap = captured();
		const client = fakeClient({
			workspaces: [
				{ id: "ws-backend-1", name: "Backend" },
				{ id: "ws-frontend-2", name: "Frontend" },
			],
		});
		const res = await runOrgCommand(
			{ path: ["workspace", "switch"], arg: "ws-frontend-2" },
			{ client, dir, clock: clock(), env: {}, out: cap.out },
		);
		expect(res.exitCode).toBe(0);
		expect(readDisk(dir).workspaceId).toBe("ws-frontend-2");
	});

	it("rejects a name with no match when the backend is reachable (no write)", async () => {
		seedDisk(dir, { workspaceId: "ws-backend-1" });
		const cap = captured();
		const client = fakeClient({ workspaces: [{ id: "ws-backend-1", name: "Backend" }] });
		const res = await runOrgCommand(
			{ path: ["workspace", "switch"], arg: "ghost" },
			{ client, dir, clock: clock(), env: {}, out: cap.out },
		);
		expect(res.exitCode).toBe(1);
		expect(res.wrote).toBe(false);
		expect(readDisk(dir).workspaceId).toBe("ws-backend-1");
	});
});

describe("a-AC-3 (back-compat) workspace use updates the credentials file ONLY (no re-mint)", () => {
	it("writes `default` directly with no client lookup", async () => {
		const before = seedDisk(dir, { workspaceId: "backend" });
		const cap = captured();
		// No client injected: `default` writes verbatim with no network call.
		const res = await runOrgCommand(
			{ path: ["workspace", "use"], arg: "default" },
			{ dir, clock: clock(), env: {}, out: cap.out },
		);
		expect(res.exitCode).toBe(0);
		expect(res.wrote).toBe(true);
		const onDisk = readDisk(dir);
		expect(onDisk.workspaceId).toBe("default");
		expect(onDisk.token).toBe(before.token);
	});

	it("falls back to a verbatim write when the backend is unreachable (back-compat)", async () => {
		const before = seedDisk(dir, { workspaceId: "backend" });
		const cap = captured();
		// A client whose listWorkspaces throws → best-effort lookup fails → write the value verbatim.
		const client = fakeClient({});
		(client as { listWorkspaces: () => Promise<never> }).listWorkspaces = () => {
			throw new Error("network down");
		};
		const res = await runOrgCommand(
			{ path: ["workspace", "use"], arg: "frontend" },
			{ client, dir, clock: clock(), env: {}, out: cap.out },
		);
		expect(res.exitCode).toBe(0);
		expect(res.wrote).toBe(true);
		const onDisk = readDisk(dir);
		expect(onDisk.workspaceId).toBe("frontend");
		expect(onDisk.token).toBe(before.token);
	});
});

describe("a-AC-6 status prints identity and NEVER the bearer token", () => {
	it("prints org id/name/workspace/agent without the token", async () => {
		const creds = seedDisk(dir, {
			orgId: "acme",
			orgName: "Acme Inc",
			workspaceId: "backend",
			agentId: "agent-7",
		});
		const cap = captured();
		const res = await runOrgCommand({ path: ["status"] }, { dir, clock: clock(), env: {}, out: cap.out });
		expect(res.exitCode).toBe(0);
		const text = cap.lines.join("\n");
		expect(text).toContain("acme");
		expect(text).toContain("Acme Inc");
		expect(text).toContain("backend");
		expect(text).toContain("agent-7");
		// The bearer token string never appears in status output (a-AC-6).
		expect(text).not.toContain(creds.token);
	});

	it("prints a non-error 'not logged in' when no credentials exist", async () => {
		const cap = captured();
		const res = await runOrgCommand({ path: ["status"] }, { dir, clock: clock(), env: {}, out: cap.out });
		expect(res.exitCode).toBe(0);
		expect(cap.lines.join("\n").toLowerCase()).toContain("not logged in");
	});
});
