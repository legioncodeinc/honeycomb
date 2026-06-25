/**
 * PRD-050c — referral-attributed login (the dual attribution headers on the device-code request).
 *
 * Verification posture (mirrors `deeplake-issuer.test.ts`): a FAKE `fetch` routing the deeplake auth
 * endpoints to canned responses + a RECORDER browser opener + a no-wait sleeper + a temp credentials
 * dir + a fixed clock. EVERY request's URL + headers are recorded so a test can assert exactly which
 * request carried which header. NO real network, NO real browser, NO real `~/.deeplake`.
 *
 * Operator decision under test: we DUAL-SEND both `X-Honeycomb-Referrer` (new) AND
 * `X-Hivemind-Referrer` (backend-recognized today), each carrying the SAME effective ref.
 *
 * c-AC-1 device-code request carries BOTH headers = `mario` by default (no `--ref` passed).
 * c-AC-2 explicit `--ref` overrides the default; a blank/whitespace `--ref` OMITS both headers.
 * c-AC-5 on approval the EXISTING persist path still mints + writes the shared 0600 credential.
 * c-AC-6 the referral headers ride ONLY on `/auth/device/code` — NOT `/me`, `/organizations`,
 *        `/users/me/tokens`, or any other request.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type AuthFetch,
	type AuthFetchRequestInit,
	type AuthFetchResponse,
	type Clock,
	type DiskCredentials,
	type Sleeper,
	HIVEMIND_REFERRER_HEADER,
	HONEYCOMB_REFERRER_HEADER,
	credentialsPath,
	loginWithDeviceFlow,
	referrerHeaders,
	resolveEffectiveRef,
} from "../../../../src/daemon/runtime/auth/index.js";
import { freshOnboardingState, saveOnboarding } from "../../../../src/daemon/runtime/onboarding/index.js";

const FIXED = "2026-06-25T12:00:00.000Z";
const LONG_LIVED_TOKEN = "dl-longlived-tok-AAA111";
const AUTH0_TOKEN = "dl-auth0-short-BBB222";

function clock(): Clock {
	return { now: () => FIXED };
}
const noWait: Sleeper = (): Promise<void> => Promise.resolve();

/** One recorded request: its path + the headers it carried (so a test asserts per-request headers). */
interface Recorded {
	path: string;
	headers: Record<string, string>;
}

function jsonResponse(status: number, body: unknown): AuthFetchResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
	};
}

/** A fake `fetch` routing the auth endpoints, recording each request's path + headers. */
function recordingFetch(records: Recorded[]): AuthFetch {
	return (url: string, init?: AuthFetchRequestInit): Promise<AuthFetchResponse> => {
		const path = url.replace(/^https?:\/\/[^/]+/, "");
		records.push({ path, headers: { ...(init?.headers ?? {}) } });
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
			return Promise.resolve(jsonResponse(200, { access_token: AUTH0_TOKEN, token_type: "Bearer" }));
		}
		if (path === "/me") return Promise.resolve(jsonResponse(200, { id: "u-1", name: "Ada Lovelace", email: "ada@deeplake.ai" }));
		if (path === "/organizations") return Promise.resolve(jsonResponse(200, [{ id: "org-acme", name: "Acme Inc" }]));
		if (path === "/users/me/tokens") return Promise.resolve(jsonResponse(200, { token: { token: LONG_LIVED_TOKEN } }));
		return Promise.resolve(jsonResponse(404, "not found"));
	};
}

/** The single recorded device-code request (there is exactly one per flow). */
function deviceCodeRecord(records: Recorded[]): Recorded {
	const hit = records.filter((r) => r.path === "/auth/device/code");
	expect(hit.length).toBe(1);
	return hit[0];
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-ref-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("referrerHeaders — the dual-send builder (trim-and-omit parity)", () => {
	it("returns BOTH headers set to the trimmed ref when non-empty", () => {
		expect(referrerHeaders("mario")).toEqual({
			[HONEYCOMB_REFERRER_HEADER]: "mario",
			[HIVEMIND_REFERRER_HEADER]: "mario",
		});
		// Whitespace is trimmed off the value.
		expect(referrerHeaders("  bob  ")).toEqual({
			[HONEYCOMB_REFERRER_HEADER]: "bob",
			[HIVEMIND_REFERRER_HEADER]: "bob",
		});
	});

	it("OMITS both headers entirely for an undefined / empty / whitespace ref", () => {
		expect(referrerHeaders()).toEqual({});
		expect(referrerHeaders("")).toEqual({});
		expect(referrerHeaders("   ")).toEqual({});
	});
});

describe("resolveEffectiveRef — explicit > onboarding.ref > DEFAULT_REF", () => {
	it("defaults to `mario` when nothing is passed and no onboarding file exists (c-AC-1)", () => {
		// Fresh temp HOME → no onboarding.json → falls through to the build default `mario`.
		expect(resolveEffectiveRef(undefined, dir)).toBe("mario");
	});

	it("uses onboarding.ref when set and no explicit override is passed", () => {
		saveOnboarding({ ...freshOnboardingState(), ref: "carol" }, dir);
		expect(resolveEffectiveRef(undefined, dir)).toBe("carol");
	});

	it("an explicit ref overrides both onboarding and the default (c-AC-2)", () => {
		saveOnboarding({ ...freshOnboardingState(), ref: "carol" }, dir);
		expect(resolveEffectiveRef("dave", dir)).toBe("dave");
	});

	it("an explicit blank/whitespace ref resolves to empty → headers omitted (c-AC-2)", () => {
		saveOnboarding({ ...freshOnboardingState(), ref: "carol" }, dir);
		expect(resolveEffectiveRef("   ", dir)).toBe("");
		expect(referrerHeaders(resolveEffectiveRef("   ", dir))).toEqual({});
	});
});

describe("c-AC-1 the device-code request carries BOTH referral headers = `mario` by default", () => {
	it("sends X-Honeycomb-Referrer AND X-Hivemind-Referrer = mario when no ref is passed", async () => {
		const records: Recorded[] = [];
		const disk = await loginWithDeviceFlow({
			dir,
			clock: clock(),
			env: {},
			fetch: recordingFetch(records),
			sleep: noWait,
			openBrowser: () => true,
			reporter: { prompt: () => {} },
			// No `ref` → effective ref resolves to the build default `mario` (no onboarding file in temp HOME).
		});
		expect(disk.orgId).toBe("org-acme"); // the flow completed end to end

		const devCode = deviceCodeRecord(records);
		expect(devCode.headers[HONEYCOMB_REFERRER_HEADER]).toBe("mario");
		expect(devCode.headers[HIVEMIND_REFERRER_HEADER]).toBe("mario");
	});
});

describe("c-AC-2 explicit --ref overrides; a blank ref omits both headers", () => {
	it("an explicit ref is what both headers carry", async () => {
		const records: Recorded[] = [];
		await loginWithDeviceFlow({
			dir,
			clock: clock(),
			env: {},
			fetch: recordingFetch(records),
			sleep: noWait,
			openBrowser: () => true,
			reporter: { prompt: () => {} },
			ref: "erin",
		});
		const devCode = deviceCodeRecord(records);
		expect(devCode.headers[HONEYCOMB_REFERRER_HEADER]).toBe("erin");
		expect(devCode.headers[HIVEMIND_REFERRER_HEADER]).toBe("erin");
	});

	it("a blank/whitespace --ref omits BOTH headers entirely from the device-code request", async () => {
		const records: Recorded[] = [];
		await loginWithDeviceFlow({
			dir,
			clock: clock(),
			env: {},
			fetch: recordingFetch(records),
			sleep: noWait,
			openBrowser: () => true,
			reporter: { prompt: () => {} },
			ref: "   ",
		});
		const devCode = deviceCodeRecord(records);
		expect(devCode.headers[HONEYCOMB_REFERRER_HEADER]).toBeUndefined();
		expect(devCode.headers[HIVEMIND_REFERRER_HEADER]).toBeUndefined();
	});
});

describe("c-AC-5 on approval the EXISTING persist path still mints + writes the 0600 shared credential", () => {
	it("the long-lived minted token is persisted to the shared ~/.deeplake/credentials.json", async () => {
		const records: Recorded[] = [];
		const disk = await loginWithDeviceFlow({
			dir,
			clock: clock(),
			env: {},
			fetch: recordingFetch(records),
			sleep: noWait,
			openBrowser: () => true,
			reporter: { prompt: () => {} },
		});
		// The persist path is unchanged: the long-lived minted token landed on disk, server-stamped.
		expect(disk.token).toBe(LONG_LIVED_TOKEN);
		expect(disk.savedAt).toBe(FIXED);
		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as DiskCredentials;
		expect(onDisk.token).toBe(LONG_LIVED_TOKEN);
		expect(onDisk.orgId).toBe("org-acme");
	});
});

describe("c-AC-6 the referral headers ride ONLY on the device-code request", () => {
	it("no other request (/me, /organizations, /users/me/tokens, /auth/device/token) carries either header", async () => {
		const records: Recorded[] = [];
		await loginWithDeviceFlow({
			dir,
			clock: clock(),
			env: {},
			fetch: recordingFetch(records),
			sleep: noWait,
			openBrowser: () => true,
			reporter: { prompt: () => {} },
			ref: "mario",
		});

		// Every NON-device-code request must be free of both attribution headers.
		const others = records.filter((r) => r.path !== "/auth/device/code");
		expect(others.length).toBeGreaterThan(0); // the flow really did hit /me, /organizations, mint, poll
		for (const rec of others) {
			expect(rec.headers[HONEYCOMB_REFERRER_HEADER]).toBeUndefined();
			expect(rec.headers[HIVEMIND_REFERRER_HEADER]).toBeUndefined();
		}
		// And the data-plane endpoints specifically are covered.
		for (const p of ["/me", "/organizations", "/users/me/tokens", "/auth/device/token"]) {
			const hit = records.find((r) => r.path === p);
			expect(hit, `expected the flow to hit ${p}`).toBeDefined();
			expect(hit?.headers[HONEYCOMB_REFERRER_HEADER]).toBeUndefined();
			expect(hit?.headers[HIVEMIND_REFERRER_HEADER]).toBeUndefined();
		}
	});
});
