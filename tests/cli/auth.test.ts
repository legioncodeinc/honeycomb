/**
 * PRD-011b — `honeycomb login` / `logout` CLI (each AC-named).
 *
 * Verification posture: a FAKE TokenIssuer + a temp credentials dir + a fake clock +
 * a no-wait sleeper. No real auth server, no real `~/.honeycomb`, no real wall clock.
 * The CLI imports NO daemon/storage path (invariant.test.ts enforces it separately).
 *
 * b-AC-1 `login` runs the device flow, gets a long-lived org-bound token, and writes
 *        credentials.json 0600 (dir 0700) — WITHOUT ever printing the bearer token.
 * b-AC-3 a missing/malformed credentials.json means "not logged in" → `login` is the
 *        prompt-to-log-in path; `logout` reports it cleanly and succeeds.
 * b-AC-6 `logout` with no file → prints "Not logged in." + SUCCESS (not error); with
 *        a file → removes it.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type Clock,
	type Credentials,
	type MintedToken,
	type Sleeper,
	FILE_MODE,
	createFakeTokenIssuer,
	credentialsPath,
	encodeStubToken,
	saveCredentials,
} from "../../src/daemon/runtime/auth/index.js";
import { type AuthResult, runAuthCommand } from "../../src/cli/auth.js";

const IS_POSIX = process.platform !== "win32";
const FIXED = "2026-06-17T12:00:00.000Z";

function clock(): Clock {
	return { now: () => FIXED };
}

const noWait: Sleeper = (): Promise<void> => Promise.resolve();

function minted(org: string, over: Record<string, unknown> = {}): MintedToken {
	const claims = { org, workspace: "default", agentId: "agent-1", ...over };
	return { token: encodeStubToken(claims), claims };
}

function seedCreds(dir: string, over: Partial<Credentials> = {}): Credentials {
	return saveCredentials(
		{
			token: encodeStubToken({ org: "acme" }),
			orgId: "acme",
			orgName: "Acme Inc",
			workspace: "backend",
			agentId: "agent-1",
			savedAt: "2020-01-01T00:00:00.000Z",
			...over,
		},
		dir,
		clock(),
	);
}

function captured(): { out: (l: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { out: (l: string) => lines.push(l), lines };
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-auth-cli-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("b-AC-1 login → device flow → org-bound token written 0600, token never printed", () => {
	it("polls to a token, persists 0600, and confirms identity WITHOUT the token", async () => {
		const token = minted("acme", { workspace: "backend", agentId: "agent-7" });
		const issuer = createFakeTokenIssuer({
			grant: {
				deviceCode: "dev-1",
				userCode: "WXYZ-1234",
				verificationUri: "https://example.invalid/device",
				interval: 5,
			},
			pollResults: ["pending", token],
		});
		const cap = captured();
		const res: AuthResult = await runAuthCommand(
			{ command: "login" },
			{ issuer, dir, clock: clock(), env: {}, out: cap.out, sleep: noWait },
		);

		expect(res.exitCode).toBe(0);
		expect(res.wrote).toBe(true);
		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as Credentials;
		expect(onDisk.orgId).toBe("acme");
		expect(onDisk.token).toBe(token.token);
		expect(onDisk.savedAt).toBe(FIXED); // server-stamped (b-AC-4)

		const text = cap.lines.join("\n");
		// The verification URI + user code are shown; the bearer token is NEVER printed.
		expect(text).toContain("https://example.invalid/device");
		expect(text).toContain("WXYZ-1234");
		expect(text).toContain("acme");
		expect(text).not.toContain(token.token);
	});

	it.skipIf(!IS_POSIX)("writes the credentials file at 0600", async () => {
		const issuer = createFakeTokenIssuer({ pollResults: [minted("acme")] });
		await runAuthCommand(
			{ command: "login" },
			{ issuer, dir, clock: clock(), env: {}, out: () => {}, sleep: noWait },
		);
		expect(statSync(credentialsPath(dir)).mode & 0o777).toBe(FILE_MODE);
	});

	it("exits non-zero (no write) when requestDeviceCode itself fails", async () => {
		const issuer = {
			requestDeviceCode: () => Promise.reject(new Error("issuer offline")),
			pollToken: () => Promise.resolve("pending" as const),
			reMint: () => Promise.reject(new Error("n/a")),
		};
		const cap = captured();
		const res = await runAuthCommand(
			{ command: "login" },
			{ issuer, dir, clock: clock(), env: {}, out: cap.out, sleep: noWait },
		);
		expect(res.exitCode).toBe(1);
		expect(res.wrote).toBe(false);
		expect(cap.lines.join("\n").toLowerCase()).toContain("login failed");
		expect(existsSync(credentialsPath(dir))).toBe(false);
	});
});

describe("b-AC-3 not-logged-in handling: login is the prompt path; logout reports cleanly", () => {
	it("logout with a malformed file reports not-logged-in and does not error", async () => {
		writeFileSync(credentialsPath(dir), "{ not json");
		const issuer = createFakeTokenIssuer();
		const cap = captured();
		const res = await runAuthCommand(
			{ command: "logout" },
			{ issuer, dir, clock: clock(), env: {}, out: cap.out },
		);
		// A malformed file is "not logged in" (loadCredentials → null) → SUCCESS.
		expect(res.exitCode).toBe(0);
		expect(cap.lines.join("\n").toLowerCase()).toContain("not logged in");
	});
});

describe("b-AC-6 logout with no file → 'Not logged in.' + SUCCESS; with a file → removes it", () => {
	it("prints 'Not logged in.' and exits SUCCESS when no credentials file exists", async () => {
		const issuer = createFakeTokenIssuer();
		const cap = captured();
		const res = await runAuthCommand(
			{ command: "logout" },
			{ issuer, dir, clock: clock(), env: {}, out: cap.out },
		);
		expect(res.exitCode).toBe(0); // SUCCESS, not an error (b-AC-6)
		expect(res.wrote).toBe(false);
		expect(cap.lines.join("\n")).toContain("Not logged in.");
	});

	it("removes the credentials file when one exists", async () => {
		seedCreds(dir);
		expect(existsSync(credentialsPath(dir))).toBe(true);
		const issuer = createFakeTokenIssuer();
		const cap = captured();
		const res = await runAuthCommand(
			{ command: "logout" },
			{ issuer, dir, clock: clock(), env: {}, out: cap.out },
		);
		expect(res.exitCode).toBe(0);
		expect(res.wrote).toBe(true);
		expect(existsSync(credentialsPath(dir))).toBe(false);
	});
});
