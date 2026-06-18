/**
 * PRD-011b — device-flow login + drift heal + token authenticator (each AC-named).
 *
 * Verification posture (EXECUTION_LEDGER-prd-011): a FAKE TokenIssuer
 * (`createFakeTokenIssuer`) + a TEMP credentials dir + a fake clock + a no-wait
 * sleeper. No real auth server, no real `~/.honeycomb`, no real wall clock. Each
 * `describe` is named after the AC it proves so the ledger maps one-to-one.
 *
 * b-AC-1 device flow approved → CLI polls (handling "pending" on the issuer's
 *        interval), gets a long-lived org-bound token, writes credentials.json 0600
 *        (dir 0700).
 * b-AC-2 token org-claim ≠ active org on session start → re-mint + realign
 *        name/workspace; warn + continue on heal failure (never crash).
 * b-AC-4 savedAt is the current timestamp regardless of any passed value.
 * b-AC-5 HONEYCOMB_TOKEN set → env token used, file not read for the token (via the
 *        auth path: the token authenticator + loadCredentials).
 * + the token authenticator resolves an Identity from verified claims (or null).
 * + the token NEVER appears on any diagnostic/warning path.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type Clock,
	type Credentials,
	type MintedToken,
	type Sleeper,
	FILE_MODE,
	DIR_MODE,
	createFakeTokenIssuer,
	createTokenAuthenticator,
	credentialsPath,
	deviceFlowLogin,
	encodeStubToken,
	healOrgDrift,
	loadCredentials,
	saveCredentials,
} from "../../../../src/daemon/runtime/auth/index.js";

const IS_POSIX = process.platform !== "win32";
const FIXED = "2026-06-17T12:00:00.000Z";

function clock(): Clock {
	return { now: () => FIXED };
}

/** A no-wait sleeper so the poll loop runs instantly (no real timers). */
const noWait: Sleeper = (): Promise<void> => Promise.resolve();

/** A minted token whose claims decode back via verifyTokenClaims. */
function minted(org: string, over: Record<string, unknown> = {}): MintedToken {
	const claims = { org, workspace: "default", agentId: "agent-1", ...over };
	return { token: encodeStubToken(claims), claims };
}

function captured(): { sink: (l: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { sink: (l: string) => lines.push(l), lines };
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-devflow-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("b-AC-1 device flow approved → poll, get org-bound token, write 0600 credentials", () => {
	it("polls through 'pending' on the issuer interval, then persists the minted token", async () => {
		const token = minted("acme");
		const issuer = createFakeTokenIssuer({
			grant: {
				deviceCode: "dev-1",
				userCode: "WXYZ-1234",
				verificationUri: "https://example.invalid/device",
				interval: 5,
			},
			pollResults: ["pending", "pending", token],
		});
		const cap = captured();
		const creds = await deviceFlowLogin({
			issuer,
			dir,
			clock: clock(),
			reporter: { prompt: cap.sink },
			sleep: noWait,
		});

		// The long-lived org-bound token landed in the persisted credentials.
		expect(creds.token).toBe(token.token);
		expect(creds.orgId).toBe("acme");
		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as Credentials;
		expect(onDisk.token).toBe(token.token);
		expect(onDisk.orgId).toBe("acme");

		// The verification URI + user code were surfaced; the bearer token NEVER was.
		const text = cap.lines.join("\n");
		expect(text).toContain("https://example.invalid/device");
		expect(text).toContain("WXYZ-1234");
		expect(text).not.toContain(token.token);
	});

	it.skipIf(!IS_POSIX)("writes the file at 0600 and a freshly-created dir at 0700", async () => {
		const fresh = join(dir, "nested", "deep");
		const issuer = createFakeTokenIssuer({ pollResults: [minted("acme")] });
		await deviceFlowLogin({ issuer, dir: fresh, clock: clock(), reporter: { prompt: () => {} }, sleep: noWait });
		expect(statSync(credentialsPath(fresh)).mode & 0o777).toBe(FILE_MODE);
		expect(statSync(fresh).mode & 0o777).toBe(DIR_MODE);
	});

	it.skipIf(IS_POSIX)("persists on win32 (perm bits best-effort, no perm assertion)", async () => {
		const issuer = createFakeTokenIssuer({ pollResults: [minted("acme")] });
		await deviceFlowLogin({ issuer, dir, clock: clock(), reporter: { prompt: () => {} }, sleep: noWait });
		expect(loadCredentials(dir)?.orgId).toBe("acme");
	});
});

describe("b-AC-2 token org-claim ≠ active org on session start → re-mint + realign, warn+continue on failure", () => {
	it("re-mints and realigns when the stored token's org disagrees with the active org", async () => {
		// Stored token is bound to old-org; the active session org is acme.
		saveCredentials(
			{
				token: encodeStubToken({ org: "old-org", workspace: "backend", agentId: "agent-1" }),
				orgId: "old-org",
				orgName: "Old Org",
				workspace: "backend",
				agentId: "agent-1",
				savedAt: "2020-01-01T00:00:00.000Z",
			},
			dir,
			clock(),
		);
		const issuer = createFakeTokenIssuer({ reMint: { acme: minted("acme", { workspace: "frontend" }) } });
		const cap = captured();
		const res = await healOrgDrift({ issuer, activeOrg: "acme", dir, clock: clock(), warner: { warn: cap.sink } });

		expect(res).toEqual({ kind: "healed", from: "old-org", to: "acme" });
		const onDisk = loadCredentials(dir);
		expect(onDisk?.orgId).toBe("acme");
		expect(onDisk?.workspace).toBe("frontend"); // realigned from the re-minted claim
		expect(cap.lines).toEqual([]); // a clean heal warns nothing
	});

	it("warns and CONTINUES (no throw) when the re-mint fails, keeping the stale credential", async () => {
		const staleToken = encodeStubToken({ org: "old-org", workspace: "backend", agentId: "agent-1" });
		saveCredentials(
			{
				token: staleToken,
				orgId: "old-org",
				orgName: "Old Org",
				workspace: "backend",
				agentId: "agent-1",
				savedAt: "2020-01-01T00:00:00.000Z",
			},
			dir,
			clock(),
		);
		// acme is unscripted → reMint rejects (the issuer fails closed on an unknown org).
		const issuer = createFakeTokenIssuer({ reMint: {} });
		const cap = captured();
		const res = await healOrgDrift({ issuer, activeOrg: "acme", dir, clock: clock(), warner: { warn: cap.sink } });

		expect(res.kind).toBe("heal-failed");
		// The session continues: the stale credential is untouched on disk.
		expect(loadCredentials(dir)?.orgId).toBe("old-org");
		// A warning was emitted naming the conflicting orgs — but NEVER the token.
		const text = cap.lines.join("\n");
		expect(text).toContain("old-org");
		expect(text).toContain("acme");
		expect(text).not.toContain(staleToken);
	});

	it("is a no-op when the stored token's org already matches the active org", async () => {
		saveCredentials(
			{
				token: encodeStubToken({ org: "acme" }),
				orgId: "acme",
				orgName: "Acme",
				workspace: "backend",
				agentId: "agent-1",
				savedAt: "2020-01-01T00:00:00.000Z",
			},
			dir,
			clock(),
		);
		const issuer = createFakeTokenIssuer({ reMint: {} }); // must NOT be used
		const res = await healOrgDrift({ issuer, activeOrg: "acme", dir, clock: clock() });
		expect(res).toEqual({ kind: "aligned", org: "acme" });
	});

	it("returns no-credentials (and never throws) when no file exists", async () => {
		const issuer = createFakeTokenIssuer();
		const res = await healOrgDrift({ issuer, activeOrg: "acme", dir, clock: clock() });
		expect(res).toEqual({ kind: "no-credentials" });
	});
});

describe("b-AC-4 successful login → savedAt is the current timestamp regardless of any passed value", () => {
	it("stamps savedAt from the injected clock, not the minted/prior value", async () => {
		// Seed a prior credential carrying a bogus savedAt the login must not echo.
		writeFileSync(
			credentialsPath(dir),
			JSON.stringify({
				token: encodeStubToken({ org: "old" }),
				orgId: "old",
				orgName: "Old",
				workspace: "backend",
				agentId: "agent-1",
				savedAt: "1999-01-01T00:00:00.000Z",
			}),
		);
		const issuer = createFakeTokenIssuer({ pollResults: [minted("acme")] });
		const creds = await deviceFlowLogin({
			issuer,
			dir,
			clock: clock(),
			reporter: { prompt: () => {} },
			sleep: noWait,
		});
		expect(creds.savedAt).toBe(FIXED);
		expect(loadCredentials(dir)?.savedAt).toBe(FIXED);
	});
});

describe("b-AC-5 HONEYCOMB_TOKEN set → env token used, file not read for the token (auth path)", () => {
	it("the token authenticator validates the ENV token, and loadCredentials returns the env token", async () => {
		// The file's token is bound to acme; the env token is a DIFFERENT acme token.
		saveCredentials(
			{
				token: encodeStubToken({ org: "acme", agentId: "from-file" }),
				orgId: "acme",
				orgName: "Acme",
				workspace: "backend",
				agentId: "from-file",
				savedAt: "2020-01-01T00:00:00.000Z",
			},
			dir,
			clock(),
		);
		const envToken = encodeStubToken({ org: "acme", workspace: "frontend", agentId: "from-env", role: "member" });

		// loadCredentials with the env var returns the ENV token, not the file's token.
		const loaded = loadCredentials(dir, { HONEYCOMB_TOKEN: envToken });
		expect(loaded?.token).toBe(envToken);

		// The token authenticator resolves the env token to an Identity from ITS claims.
		const authn = createTokenAuthenticator();
		const identity = await authn.authenticate({ bearer: envToken });
		expect(identity?.org).toBe("acme");
		expect(identity?.agentId).toBe("from-env");
		expect(identity?.role).toBe("member");
		expect(identity?.workspace).toBe("frontend");
	});
});

describe("the token authenticator resolves an Identity from verified claims, else null", () => {
	it("returns null for a missing bearer (this half cannot authenticate)", async () => {
		const authn = createTokenAuthenticator();
		expect(await authn.authenticate({})).toBeNull();
	});

	it("returns null for an unverifiable bearer token (fail-closed → 401)", async () => {
		const authn = createTokenAuthenticator();
		expect(await authn.authenticate({ bearer: "not-a-valid-token" })).toBeNull();
	});

	it("maps a project claim onto the Identity and defaults an absent role to the least-privileged agent", async () => {
		const authn = createTokenAuthenticator();
		const token = encodeStubToken({ org: "acme", project: "alpha" }); // no role claim
		const identity = await authn.authenticate({ bearer: token });
		expect(identity?.org).toBe("acme");
		expect(identity?.project).toBe("alpha");
		expect(identity?.role).toBe("agent");
	});

	it("uses an injected verifier (the seam the real HTTP issuer adapter swaps in)", async () => {
		const authn = createTokenAuthenticator((t) => (t === "ok" ? { org: "acme", role: "admin" } : null));
		expect((await authn.authenticate({ bearer: "ok" }))?.role).toBe("admin");
		expect(await authn.authenticate({ bearer: "no" })).toBeNull();
	});
});
