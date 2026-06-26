/**
 * PRD-023 Wave 2 — `honeycomb login` / `logout` CLI (each AC-named).
 *
 * Verification posture: the CLI's login flows are injected via `flows` (a fake `deviceFlow` /
 * `tokenLogin`) OR via a fake `fetch` + recorder `openBrowser` + no-wait `sleep` so the REAL
 * deeplake-issuer flows run with no network and no browser. A temp credentials dir + a fixed clock +
 * an injected env keep the real `~/.deeplake`, wall clock, and env untouched. The CLI imports NO
 * daemon/storage path (invariant.test.ts enforces that separately).
 *
 * AC-1 `login` (device flow): runs the flow, writes the shared file in Hivemind shape, prints the
 *      identity WITHOUT the token.
 * AC-2 `login --token <key>` / `HONEYCOMB_TOKEN=<key> login`: skip the browser, validate via /me,
 *      save the file; an invalid token → non-zero exit, NO file, NO token in output.
 * AC-6 `logout`: removes the shared + legacy file; exit 0 when absent; never throws.
 * D-4: a grep of captured stdout asserts the token string NEVER appears.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuthResult, parseAuthArgs, runAuthCommand } from "../../src/cli/auth.js";
import {
	type AuthFetch,
	type AuthFetchResponse,
	type BrowserOpener,
	type Clock,
	credentialsPath,
	type DiskCredentials,
	FILE_MODE,
	legacyCredentialsPath,
	type Sleeper,
	saveDiskCredentials,
	verifyTokenClaims,
} from "../../src/daemon/runtime/auth/index.js";

const IS_POSIX = process.platform !== "win32";
const FIXED = "2026-06-20T12:00:00.000Z";
const LONG_LIVED_TOKEN = "dl-cli-longlived-CCC333";
const AUTH0_TOKEN = "dl-cli-auth0-DDD444";

function clock(): Clock {
	return { now: () => FIXED };
}
const noWait: Sleeper = (): Promise<void> => Promise.resolve();

function captured(): { out: (l: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { out: (l: string) => lines.push(l), lines };
}

function jsonResponse(status: number, body: unknown): AuthFetchResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
	};
}

/** A fake `fetch` routing the deeplake auth endpoints. `meStatus` lets a test force an invalid token. */
function fakeFetch(opts: { meStatus?: number } = {}): AuthFetch {
	return (url: string): Promise<AuthFetchResponse> => {
		const path = url.replace(/^https?:\/\/[^/]+/, "");
		if (path === "/auth/device/code") {
			return Promise.resolve(
				jsonResponse(200, {
					device_code: "dev-code",
					user_code: "WXYZ-1234",
					verification_uri: "https://app.deeplake.ai/device",
					verification_uri_complete: "https://app.deeplake.ai/device?code=WXYZ-1234",
					expires_in: 900,
					interval: 5,
				}),
			);
		}
		if (path === "/auth/device/token") return Promise.resolve(jsonResponse(200, { access_token: AUTH0_TOKEN }));
		if (path === "/me") {
			if (opts.meStatus !== undefined && opts.meStatus !== 200)
				return Promise.resolve(jsonResponse(opts.meStatus, "unauth"));
			return Promise.resolve(jsonResponse(200, { id: "u-1", name: "Ada Lovelace", email: "ada@deeplake.ai" }));
		}
		if (path === "/organizations") return Promise.resolve(jsonResponse(200, [{ id: "org-acme", name: "Acme Inc" }]));
		if (path === "/users/me/tokens") return Promise.resolve(jsonResponse(200, { token: { token: LONG_LIVED_TOKEN } }));
		if (path === "/workspaces") return Promise.resolve(jsonResponse(200, { data: [] }));
		return Promise.resolve(jsonResponse(404, "x"));
	};
}

const openerNoop: BrowserOpener = () => true;

let dir: string;
let legacyDir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-auth-cli-"));
	legacyDir = mkdtempSync(join(tmpdir(), "hc-auth-legacy-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(legacyDir, { recursive: true, force: true });
});

describe("AC-1 login → device flow → shared file (Hivemind shape, 0600); token never printed", () => {
	it("runs the device flow, writes the Hivemind shape, and prints identity WITHOUT the token", async () => {
		const cap = captured();
		const res: AuthResult = await runAuthCommand(
			{ command: "login" },
			{ dir, clock: clock(), env: {}, out: cap.out, fetch: fakeFetch(), sleep: noWait, openBrowser: openerNoop },
		);
		expect(res.exitCode).toBe(0);
		expect(res.wrote).toBe(true);

		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as DiskCredentials;
		expect(onDisk.orgId).toBe("org-acme");
		expect(onDisk.token).toBe(LONG_LIVED_TOKEN);
		expect(onDisk.userName).toBe("Ada Lovelace");
		expect(onDisk.savedAt).toBe(FIXED);

		const text = cap.lines.join("\n");
		expect(text).toContain("WXYZ-1234"); // user code surfaced
		expect(text).toContain("Ada Lovelace"); // identity printed
		expect(text).not.toContain(LONG_LIVED_TOKEN); // D-4: token never printed
		expect(text).not.toContain(AUTH0_TOKEN);
	});

	it.skipIf(!IS_POSIX)("writes the credentials file at 0600", async () => {
		await runAuthCommand(
			{ command: "login" },
			{ dir, clock: clock(), env: {}, out: () => {}, fetch: fakeFetch(), sleep: noWait, openBrowser: openerNoop },
		);
		expect(statSync(credentialsPath(dir)).mode & 0o777).toBe(FILE_MODE);
	});

	it("exits non-zero (no file) when the device flow fails — and prints no token", async () => {
		const cap = captured();
		const res = await runAuthCommand(
			{ command: "login" },
			{
				dir,
				clock: clock(),
				env: {},
				out: cap.out,
				flows: {
					deviceFlow: () => Promise.reject(new Error("issuer offline")),
					tokenLogin: () => Promise.reject(new Error("n/a")),
				},
			},
		);
		expect(res.exitCode).toBe(1);
		expect(res.wrote).toBe(false);
		expect(cap.lines.join("\n").toLowerCase()).toContain("login failed");
		expect(existsSync(credentialsPath(dir))).toBe(false);
	});
});

describe("AC-2 headless login: HONEYCOMB_TOKEN / --token → validate /me → save (no browser)", () => {
	it("HONEYCOMB_TOKEN skips the browser, validates, and writes the shared file", async () => {
		const cap = captured();
		const res = await runAuthCommand(
			{ command: "login" },
			{ dir, clock: clock(), env: { HONEYCOMB_TOKEN: LONG_LIVED_TOKEN }, out: cap.out, fetch: fakeFetch() },
		);
		expect(res.exitCode).toBe(0);
		expect(res.wrote).toBe(true);
		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as DiskCredentials;
		expect(onDisk.token).toBe(LONG_LIVED_TOKEN);
		expect(onDisk.userName).toBe("Ada Lovelace");
		// The user code is NEVER shown on the headless path (no device code requested).
		expect(cap.lines.join("\n")).not.toContain("WXYZ-1234");
		expect(cap.lines.join("\n")).not.toContain(LONG_LIVED_TOKEN);
	});

	it("--token <key> (the explicit arg) takes the headless path", async () => {
		const cap = captured();
		const inv = parseAuthArgs(["login", "--token", LONG_LIVED_TOKEN]);
		expect(inv).toEqual({ command: "login", token: LONG_LIVED_TOKEN });
		const res = await runAuthCommand(inv, { dir, clock: clock(), env: {}, out: cap.out, fetch: fakeFetch() });
		expect(res.exitCode).toBe(0);
		expect(JSON.parse(readFileSync(credentialsPath(dir), "utf8")).token).toBe(LONG_LIVED_TOKEN);
		expect(cap.lines.join("\n")).not.toContain(LONG_LIVED_TOKEN);
	});

	it("an invalid token (401 /me) → non-zero exit, NO file, NO token in output", async () => {
		const cap = captured();
		const res = await runAuthCommand(
			{ command: "login", token: LONG_LIVED_TOKEN },
			{ dir, clock: clock(), env: {}, out: cap.out, fetch: fakeFetch({ meStatus: 401 }) },
		);
		expect(res.exitCode).toBe(1);
		expect(res.wrote).toBe(false);
		expect(existsSync(credentialsPath(dir))).toBe(false);
		expect(cap.lines.join("\n")).not.toContain(LONG_LIVED_TOKEN);
		expect(cap.lines.join("\n").toLowerCase()).toContain("login failed");
	});
});

describe("AC-6 logout: removes the shared + legacy file; exit 0 when absent; never throws", () => {
	function seedShared(): void {
		saveDiskCredentials(
			{
				token: "tok-shared",
				orgId: "org-acme",
				orgName: "Acme Inc",
				userName: "ada",
				workspaceId: "default",
				apiUrl: "https://api.deeplake.ai",
				savedAt: "",
			},
			dir,
			clock(),
		);
	}

	it("removes BOTH the shared and the legacy credentials file", async () => {
		seedShared();
		// Seed a legacy ~/.honeycomb file too (old Honeycomb shape).
		writeFileSync(
			legacyCredentialsPath(legacyDir),
			JSON.stringify({
				token: "tok-legacy",
				orgId: "org-acme",
				orgName: "Acme",
				workspace: "backend",
				agentId: "agent-1",
				savedAt: "2020-01-01T00:00:00.000Z",
			}),
		);
		expect(existsSync(credentialsPath(dir))).toBe(true);
		expect(existsSync(legacyCredentialsPath(legacyDir))).toBe(true);

		const cap = captured();
		const res = await runAuthCommand({ command: "logout" }, { dir, legacyDir, clock: clock(), env: {}, out: cap.out });
		expect(res.exitCode).toBe(0);
		expect(res.wrote).toBe(true);
		expect(existsSync(credentialsPath(dir))).toBe(false);
		expect(existsSync(legacyCredentialsPath(legacyDir))).toBe(false);
		expect(cap.lines.join("\n").toLowerCase()).toContain("removed");
	});

	it("exits 0 (SUCCESS) when neither file exists — never errors on a missing file", async () => {
		const cap = captured();
		const res = await runAuthCommand({ command: "logout" }, { dir, legacyDir, clock: clock(), env: {}, out: cap.out });
		expect(res.exitCode).toBe(0);
		expect(res.wrote).toBe(false);
		expect(cap.lines.join("\n")).toContain("Not logged in.");
	});
});

describe("self-hosted login (--endpoint): writes the credential directly WITHOUT dialing api.deeplake.ai", () => {
	// Proves the path never touches the auth backend: any fetch is a hard failure.
	const throwingFetch: AuthFetch = () => {
		throw new Error("self-hosted login must not call api.deeplake.ai");
	};

	it("parseAuthArgs captures --endpoint / --org / --workspace (and --token=)", () => {
		const inv = parseAuthArgs([
			"login",
			"--endpoint",
			"postgres://db/dl",
			"--org",
			"team",
			"--workspace",
			"ws",
			"--token=tok-1",
		]);
		expect(inv).toEqual({
			command: "login",
			endpoint: "postgres://db/dl",
			org: "team",
			workspace: "ws",
			token: "tok-1",
		});
	});

	it("mints a LOCAL stub token and writes apiUrl=endpoint, org=local, workspace=default with only --endpoint", async () => {
		const cap = captured();
		const res = await runAuthCommand(
			{ command: "login", endpoint: "https://deeplake.internal:8443" },
			{ dir, clock: clock(), env: {}, out: cap.out, fetch: throwingFetch },
		);
		expect(res.exitCode).toBe(0);
		expect(res.wrote).toBe(true);

		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as DiskCredentials;
		expect(onDisk.apiUrl).toBe("https://deeplake.internal:8443");
		expect(onDisk.orgId).toBe("local");
		expect(onDisk.workspaceId).toBe("default");
		expect(onDisk.savedAt).toBe(FIXED);
		expect(typeof onDisk.token).toBe("string");
		expect(onDisk.token.length).toBeGreaterThan(0);
		// The minted token is REAL: it round-trips the verifier to the same org.
		expect(verifyTokenClaims(onDisk.token)?.org).toBe("local");
	});

	it("supports a postgres:// endpoint with an explicit --token / --org / --workspace (verbatim token)", async () => {
		const cap = captured();
		const res = await runAuthCommand(
			{
				command: "login",
				endpoint: "postgres://u@db:5432/deeplake",
				token: "byo-token-xyz",
				org: "team-blue",
				workspace: "backend",
			},
			{ dir, clock: clock(), env: {}, out: cap.out, fetch: throwingFetch },
		);
		expect(res.exitCode).toBe(0);
		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as DiskCredentials;
		expect(onDisk.apiUrl).toBe("postgres://u@db:5432/deeplake");
		expect(onDisk.token).toBe("byo-token-xyz");
		expect(onDisk.orgId).toBe("team-blue");
		expect(onDisk.workspaceId).toBe("backend");
	});

	it("writes the file at 0600 and NEVER prints the token (D-4)", async () => {
		const cap = captured();
		await runAuthCommand(
			{ command: "login", endpoint: "https://deeplake.internal", token: "secret-token-zzz" },
			{ dir, clock: clock(), env: {}, out: cap.out, fetch: throwingFetch },
		);
		if (IS_POSIX) {
			expect(statSync(credentialsPath(dir)).mode & 0o777).toBe(FILE_MODE);
		}
		const text = cap.lines.join("\n");
		expect(text).not.toContain("secret-token-zzz");
		expect(text).toContain("https://deeplake.internal");
	});
});
