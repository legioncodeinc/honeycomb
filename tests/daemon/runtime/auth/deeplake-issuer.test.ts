/**
 * PRD-023 Wave 2 — the REAL api.deeplake.ai auth client + device-flow / headless login (AC-named).
 *
 * Verification posture: a FAKE `fetch` that routes the deeplake auth endpoints
 * (`/auth/device/code`, `/auth/device/token`, `/users/me/tokens`, `/me`, `/organizations`,
 * `/workspaces`) to canned responses + a RECORDER browser opener + a no-wait sleeper + a temp
 * credentials dir + a fixed clock. NO real api.deeplake.ai, NO real browser, NO real `~/.deeplake`,
 * NO real wall clock. The written file is asserted to parse to the EXACT Hivemind disk shape.
 *
 * AC-1 device flow: code → pending → minted → shared file in Hivemind shape (0600); pending-then-
 *      success; expiry → clean error (no token, no crash).
 * AC-2 headless: a pre-issued token validates via `/me` → file saved; an invalid token (401 `/me`)
 *      → throw, NO file, NO token in the message.
 * D-4: the token NEVER appears on stdout/the reporter/any error; a non-https `verification_uri_complete`
 *      is REJECTED (the opener is never handed it).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type AuthFetch,
	type AuthFetchResponse,
	type BrowserOpener,
	type Clock,
	type DiskCredentials,
	type Sleeper,
	AuthHttpError,
	FILE_MODE,
	createDeeplakeAuthClient,
	credentialsPath,
	loginWithDeviceFlow,
	loginWithToken,
	validateVerificationUrl,
} from "../../../../src/daemon/runtime/auth/index.js";

const IS_POSIX = process.platform !== "win32";
const FIXED = "2026-06-20T12:00:00.000Z";
const LONG_LIVED_TOKEN = "dl-longlived-tok-AAA111";
const AUTH0_TOKEN = "dl-auth0-short-BBB222";

function clock(): Clock {
	return { now: () => FIXED };
}
const noWait: Sleeper = (): Promise<void> => Promise.resolve();

/** A JSON response shim implementing the minimal `AuthFetchResponse`. */
function jsonResponse(status: number, body: unknown): AuthFetchResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
	};
}

/**
 * A scriptable fake `fetch` routing the deeplake auth endpoints. `pollScript` is the ordered
 * sequence the `/auth/device/token` poll yields (`"pending"` → 400 pending, an object → the token,
 * an `AuthHttpError`-shaped 400 with `error` → a non-pending 400). Every request URL + body is
 * recorded so a test can assert the token never reaches a URL.
 */
function fakeFetch(opts: {
	pollScript?: (DeviceTokenStep)[];
	meStatus?: number;
	urls: string[];
	bodies: string[];
}): AuthFetch {
	let pollIndex = 0;
	const pollScript = opts.pollScript ?? [];
	return (url: string, init): Promise<AuthFetchResponse> => {
		opts.urls.push(url);
		if (init?.body !== undefined) opts.bodies.push(init.body);
		const path = url.replace(/^https?:\/\/[^/]+/, "");
		if (path === "/auth/device/code") {
			return Promise.resolve(
				jsonResponse(200, {
					device_code: "dev-code-xyz",
					user_code: "WXYZ-1234",
					verification_uri: "https://app.deeplake.ai/device",
					verification_uri_complete: "https://app.deeplake.ai/device?code=WXYZ-1234",
					expires_in: 900,
					interval: 5,
				}),
			);
		}
		if (path === "/auth/device/token") {
			const step = pollIndex < pollScript.length ? pollScript[pollIndex] : pollScript[pollScript.length - 1];
			pollIndex += 1;
			if (step === "pending") return Promise.resolve(jsonResponse(400, { error: "authorization_pending" }));
			if (step === "expired") return Promise.resolve(jsonResponse(400, { error: "expired_token" }));
			return Promise.resolve(jsonResponse(200, { access_token: AUTH0_TOKEN, token_type: "Bearer" }));
		}
		if (path === "/me") {
			if (opts.meStatus !== undefined && opts.meStatus !== 200) {
				return Promise.resolve(jsonResponse(opts.meStatus, "unauthorized"));
			}
			return Promise.resolve(jsonResponse(200, { id: "u-1", name: "Ada Lovelace", email: "ada@deeplake.ai" }));
		}
		if (path === "/organizations") {
			return Promise.resolve(jsonResponse(200, [{ id: "org-acme", name: "Acme Inc" }]));
		}
		if (path === "/users/me/tokens") {
			return Promise.resolve(jsonResponse(200, { token: { token: LONG_LIVED_TOKEN } }));
		}
		if (path === "/workspaces") {
			return Promise.resolve(jsonResponse(200, { data: [{ id: "ws-1", name: "primary" }] }));
		}
		return Promise.resolve(jsonResponse(404, "not found"));
	};
}

type DeviceTokenStep = "pending" | "minted" | "expired";

/** A recorder browser opener: captures every URL it was handed and whether it "opened". */
function recorderOpener(opened = true): { opener: BrowserOpener; urls: string[] } {
	const urls: string[] = [];
	return {
		urls,
		opener: (url: string): boolean => {
			urls.push(url);
			return opened;
		},
	};
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-dl-issuer-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("AC-1 device flow → minted long-lived token → shared file in Hivemind shape (0600)", () => {
	it("polls through 'pending' then success, mints, validates /me, and writes the exact Hivemind shape", async () => {
		const urls: string[] = [];
		const bodies: string[] = [];
		const fetch = fakeFetch({ pollScript: ["pending", "pending", "minted"], urls, bodies });
		const rec = recorderOpener();
		const lines: string[] = [];

		const disk = await loginWithDeviceFlow({
			dir,
			clock: clock(),
			env: {},
			fetch,
			sleep: noWait,
			openBrowser: rec.opener,
			reporter: { prompt: (l) => lines.push(l) },
		});

		// The persisted record is the LONG-LIVED minted token, not the short Auth0 token.
		expect(disk.token).toBe(LONG_LIVED_TOKEN);
		expect(disk.orgId).toBe("org-acme");
		expect(disk.orgName).toBe("Acme Inc");
		expect(disk.userName).toBe("Ada Lovelace");
		expect(disk.apiUrl).toBe("https://api.deeplake.ai");
		expect(disk.workspaceId).toBe("default");
		expect(disk.savedAt).toBe(FIXED); // server-stamped

		// The file on disk parses to the EXACT Hivemind shape (cross-tool interchange).
		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as DiskCredentials;
		expect(Object.keys(onDisk).sort()).toEqual(
			["apiUrl", "orgId", "orgName", "savedAt", "token", "userName", "workspaceId"].sort(),
		);
		expect(onDisk.token).toBe(LONG_LIVED_TOKEN);

		// The browser was opened with the VALIDATED https completion URL.
		expect(rec.urls).toEqual(["https://app.deeplake.ai/device?code=WXYZ-1234"]);

		// D-4: neither token appears on the reporter, AND no token rides in a URL or device-token body.
		const text = lines.join("\n");
		expect(text).toContain("WXYZ-1234");
		expect(text).not.toContain(LONG_LIVED_TOKEN);
		expect(text).not.toContain(AUTH0_TOKEN);
		expect(urls.join("\n")).not.toContain(LONG_LIVED_TOKEN);
		expect(urls.join("\n")).not.toContain(AUTH0_TOKEN);
	});

	it.skipIf(!IS_POSIX)("writes the credentials file at 0600", async () => {
		const urls: string[] = [];
		const bodies: string[] = [];
		await loginWithDeviceFlow({
			dir,
			clock: clock(),
			env: {},
			fetch: fakeFetch({ pollScript: ["minted"], urls, bodies }),
			sleep: noWait,
			openBrowser: recorderOpener().opener,
			reporter: { prompt: () => {} },
		});
		expect(statSync(credentialsPath(dir)).mode & 0o777).toBe(FILE_MODE);
	});

	it("expiry → clean error (no token, no crash, no file written)", async () => {
		const urls: string[] = [];
		const bodies: string[] = [];
		const fetch = fakeFetch({ pollScript: ["expired"], urls, bodies });
		await expect(
			loginWithDeviceFlow({
				dir,
				clock: clock(),
				env: {},
				fetch,
				sleep: noWait,
				openBrowser: recorderOpener().opener,
				reporter: { prompt: () => {} },
			}),
		).rejects.toThrow(/expired/i);
		expect(existsSync(credentialsPath(dir))).toBe(false);
	});

	it("a never-approving grant surfaces (poll cap) rather than looping forever — no file", async () => {
		const urls: string[] = [];
		const bodies: string[] = [];
		const fetch = fakeFetch({ pollScript: ["pending"], urls, bodies });
		await expect(
			loginWithDeviceFlow({
				dir,
				clock: clock(),
				env: {},
				fetch,
				sleep: noWait,
				openBrowser: recorderOpener().opener,
				reporter: { prompt: () => {} },
				maxPolls: 3,
			}),
		).rejects.toThrow(/timed out/i);
		expect(existsSync(credentialsPath(dir))).toBe(false);
	});
});

describe("D-4 the device flow REJECTS a non-https verification_uri_complete (never opens it)", () => {
	it("does not hand a non-https completion URL to the opener", async () => {
		const urls: string[] = [];
		const bodies: string[] = [];
		// Override the device-code response to carry a javascript: scheme completion URL.
		const fetch: AuthFetch = (url, init) => {
			urls.push(url);
			if (init?.body !== undefined) bodies.push(init.body);
			const path = url.replace(/^https?:\/\/[^/]+/, "");
			if (path === "/auth/device/code") {
				return Promise.resolve(
					jsonResponse(200, {
						device_code: "dev-code-xyz",
						user_code: "WXYZ-1234",
						verification_uri: "https://app.deeplake.ai/device",
						verification_uri_complete: "javascript:alert(1)//app.deeplake.ai",
						expires_in: 900,
						interval: 5,
					}),
				);
			}
			if (path === "/auth/device/token") return Promise.resolve(jsonResponse(200, { access_token: AUTH0_TOKEN }));
			if (path === "/me") return Promise.resolve(jsonResponse(200, { id: "u-1", name: "Ada", email: "a@b.io" }));
			if (path === "/organizations") return Promise.resolve(jsonResponse(200, [{ id: "org-acme", name: "Acme" }]));
			if (path === "/users/me/tokens") return Promise.resolve(jsonResponse(200, { token: { token: LONG_LIVED_TOKEN } }));
			return Promise.resolve(jsonResponse(404, "x"));
		};
		const rec = recorderOpener();
		const disk = await loginWithDeviceFlow({
			dir,
			clock: clock(),
			env: {},
			fetch,
			sleep: noWait,
			openBrowser: rec.opener,
			reporter: { prompt: () => {} },
		});
		// Login still completes (the user can copy the user code), but the unsafe URL was NEVER opened.
		expect(disk.orgId).toBe("org-acme");
		expect(rec.urls).toEqual([]);
	});

	it("validateVerificationUrl gates the scheme (https only)", () => {
		expect(validateVerificationUrl("https://app.deeplake.ai/device?code=X")).toBe("https://app.deeplake.ai/device?code=X");
		expect(validateVerificationUrl("http://app.deeplake.ai/device")).toBeNull();
		expect(validateVerificationUrl("javascript:alert(1)")).toBeNull();
		expect(validateVerificationUrl("file:///etc/passwd")).toBeNull();
		expect(validateVerificationUrl("not a url")).toBeNull();
	});
});

describe("AC-2 headless login: a pre-issued token validates via /me → shared file saved", () => {
	it("validates the token via /me, resolves the org, and writes the Hivemind shape (no browser)", async () => {
		const urls: string[] = [];
		const bodies: string[] = [];
		const disk = await loginWithToken(LONG_LIVED_TOKEN, {
			dir,
			clock: clock(),
			env: {},
			fetch: fakeFetch({ urls, bodies }),
		});
		expect(disk.token).toBe(LONG_LIVED_TOKEN);
		expect(disk.userName).toBe("Ada Lovelace");
		expect(disk.orgId).toBe("org-acme");
		// No device-code / device-token endpoint was hit (the browser path was skipped).
		expect(urls.some((u) => u.includes("/auth/device/"))).toBe(false);
		// D-4: the token rode ONLY in the Authorization header, never a request URL.
		expect(urls.join("\n")).not.toContain(LONG_LIVED_TOKEN);
	});

	it("an invalid token (401 /me) → throws, NO file, NO token in the message", async () => {
		const urls: string[] = [];
		const bodies: string[] = [];
		let caught: unknown;
		try {
			await loginWithToken(LONG_LIVED_TOKEN, {
				dir,
				clock: clock(),
				env: {},
				fetch: fakeFetch({ meStatus: 401, urls, bodies }),
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(AuthHttpError);
		expect((caught as AuthHttpError).status).toBe(401);
		expect((caught as Error).message).not.toContain(LONG_LIVED_TOKEN);
		expect(existsSync(credentialsPath(dir))).toBe(false);
	});

	it("an empty token is rejected before any network call", async () => {
		const urls: string[] = [];
		const bodies: string[] = [];
		await expect(
			loginWithToken("", { dir, clock: clock(), env: {}, fetch: fakeFetch({ urls, bodies }) }),
		).rejects.toThrow(/no token/i);
		expect(urls).toEqual([]);
	});
});

describe("the reusable auth client (Wave 3 consumes getMe / listOrgs / listWorkspaces / reMint)", () => {
	it("getMe / listOrgs / listWorkspaces parse the Hivemind shapes; reMint returns the minted token", async () => {
		const urls: string[] = [];
		const bodies: string[] = [];
		const client = createDeeplakeAuthClient({
			apiUrl: "https://api.deeplake.ai",
			fetch: fakeFetch({ urls, bodies }),
			sleep: noWait,
		});
		expect((await client.getMe(LONG_LIVED_TOKEN)).name).toBe("Ada Lovelace");
		expect(await client.listOrgs(LONG_LIVED_TOKEN)).toEqual([{ id: "org-acme", name: "Acme Inc" }]);
		// `/workspaces` tolerates the `{ data: [...] }` envelope (Hivemind parity).
		expect(await client.listWorkspaces(LONG_LIVED_TOKEN, "org-acme")).toEqual([{ id: "ws-1", name: "primary" }]);
		expect(await client.reMint(LONG_LIVED_TOKEN, "org-acme")).toBe(LONG_LIVED_TOKEN);
		// D-4: the token is in NO request URL.
		expect(urls.join("\n")).not.toContain(LONG_LIVED_TOKEN);
	});

	it("retries a 429 then succeeds (the hardened-fetch posture)", async () => {
		let calls = 0;
		const fetch: AuthFetch = () => {
			calls += 1;
			if (calls === 1) return Promise.resolve(jsonResponse(429, "rate limited"));
			return Promise.resolve(jsonResponse(200, { id: "u-1", name: "Ada", email: "a@b.io" }));
		};
		const client = createDeeplakeAuthClient({ apiUrl: "https://api.deeplake.ai", fetch, sleep: noWait });
		expect((await client.getMe("tok")).name).toBe("Ada");
		expect(calls).toBe(2);
	});

	it("a non-retryable 4xx throws a redacted AuthHttpError carrying the status, never the token", async () => {
		const fetch: AuthFetch = () => Promise.resolve(jsonResponse(403, "forbidden body"));
		const client = createDeeplakeAuthClient({ apiUrl: "https://api.deeplake.ai", fetch, sleep: noWait });
		let caught: unknown;
		try {
			await client.getMe("super-secret-token");
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(AuthHttpError);
		expect((caught as AuthHttpError).status).toBe(403);
		expect((caught as Error).message).not.toContain("super-secret-token");
	});
});
