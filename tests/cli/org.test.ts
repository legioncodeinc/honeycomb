/**
 * PRD-011a — `honeycomb org/workspace/status` CLI (each AC-named).
 *
 * Verification posture: a FAKE TokenIssuer + a temp credentials dir + a fake clock.
 * No real auth server, no real `~/.honeycomb`. The CLI imports NO daemon/storage
 * path (the invariant test enforces it separately; we also spot-check here).
 *
 * a-AC-3 `org switch acme` re-mints+saves a fresh org-bound token; `workspace use
 *        backend` updates the credentials file only (no re-mint).
 * a-AC-6 `status` prints org id/name/workspace/agent and NEVER the bearer token.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type Clock,
	type Credentials,
	type MintedToken,
	createFakeTokenIssuer,
	credentialsPath,
	encodeStubToken,
	saveCredentials,
} from "../../src/daemon/runtime/auth/index.js";
import { type OrgResult, runOrgCommand } from "../../src/cli/org.js";

const FIXED = "2026-06-17T12:00:00.000Z";
function clock(): Clock {
	return { now: () => FIXED };
}

/** A minted token whose claims decode back via verifyTokenClaims. */
function minted(org: string, over: Record<string, unknown> = {}): MintedToken {
	const claims = { org, workspace: "default", agentId: "agent-1", ...over };
	return { token: encodeStubToken(claims), claims };
}

function seedCreds(dir: string, over: Partial<Credentials> = {}): Credentials {
	const base: Credentials = {
		token: encodeStubToken({ org: "old-org" }),
		orgId: "old-org",
		orgName: "Old Org",
		workspace: "backend",
		agentId: "agent-1",
		savedAt: "2020-01-01T00:00:00.000Z",
		...over,
	};
	return saveCredentials(base, dir, clock());
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

describe("a-AC-3 org switch re-mints + saves a fresh org-bound token", () => {
	it("mints a fresh token for the new org and persists it", async () => {
		seedCreds(dir);
		const issuer = createFakeTokenIssuer({ reMint: { acme: minted("acme") } });
		const cap = captured();
		const res: OrgResult = await runOrgCommand(
			{ path: ["org", "switch"], arg: "acme" },
			{ issuer, dir, clock: clock(), env: {}, out: cap.out },
		);
		expect(res.exitCode).toBe(0);
		expect(res.wrote).toBe(true);
		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as Credentials;
		expect(onDisk.orgId).toBe("acme");
		expect(onDisk.token).toBe(minted("acme").token);
		// savedAt is server-stamped (b-AC-4 carries into switch).
		expect(onDisk.savedAt).toBe(FIXED);
		// The token is NEVER printed.
		expect(cap.lines.join("\n")).not.toContain(onDisk.token);
	});

	it("fails closed (non-zero, no write) when the issuer cannot mint the org", async () => {
		seedCreds(dir);
		const issuer = createFakeTokenIssuer({ reMint: {} }); // acme unscripted → rejects
		const cap = captured();
		const res = await runOrgCommand(
			{ path: ["org", "switch"], arg: "acme" },
			{ issuer, dir, clock: clock(), env: {}, out: cap.out },
		);
		expect(res.exitCode).toBe(1);
		expect(res.wrote).toBe(false);
	});
});

describe("a-AC-3 workspace use updates the credentials file ONLY (no re-mint)", () => {
	it("changes the workspace and keeps the same token", async () => {
		const before = seedCreds(dir, { workspace: "backend", token: encodeStubToken({ org: "old-org" }) });
		const issuer = createFakeTokenIssuer(); // must NOT be used
		const cap = captured();
		const res = await runOrgCommand(
			{ path: ["workspace", "use"], arg: "frontend" },
			{ issuer, dir, clock: clock(), env: {}, out: cap.out },
		);
		expect(res.exitCode).toBe(0);
		expect(res.wrote).toBe(true);
		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as Credentials;
		expect(onDisk.workspace).toBe("frontend");
		// The token is UNCHANGED — no re-mint occurred (FR-5).
		expect(onDisk.token).toBe(before.token);
	});
});

describe("a-AC-6 status prints identity and NEVER the bearer token", () => {
	it("prints org id/name/workspace/agent without the token", async () => {
		const creds = seedCreds(dir, { orgId: "acme", orgName: "Acme Inc", workspace: "backend", agentId: "agent-7" });
		const issuer = createFakeTokenIssuer();
		const cap = captured();
		const res = await runOrgCommand({ path: ["status"] }, { issuer, dir, clock: clock(), env: {}, out: cap.out });
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
		const issuer = createFakeTokenIssuer();
		const cap = captured();
		const res = await runOrgCommand({ path: ["status"] }, { issuer, dir, clock: clock(), env: {}, out: cap.out });
		expect(res.exitCode).toBe(0);
		expect(cap.lines.join("\n").toLowerCase()).toContain("not logged in");
	});
});
