/**
 * PRD-050e — `honeycomb_first_link` emits from the device-flow login (e-AC-1), AFTER the credential is
 * persisted, fire-and-forget (e-AC-4). The REAL `loginWithDeviceFlow` runs with an injected auth `fetch`
 * (canned device-flow responses) + an injected TELEMETRY `fetch` recorder + temp HOME — no real I/O. The
 * carried `ref` is the effective ref (so the header and the telemetry agree on the code).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type AuthFetch,
	type AuthFetchResponse,
	loginWithDeviceFlow,
} from "../../../../src/daemon/runtime/auth/index.js";
import { type TelemetryFetchRequestInit } from "../../../../src/daemon/runtime/telemetry/index.js";
import { loadOnboarding } from "../../../../src/daemon/runtime/onboarding/index.js";

const KEY = "phc_test_write_only_key";

/** Canned auth backend: device-code → token → me → orgs → mint. */
const authFetch: AuthFetch = (url): Promise<AuthFetchResponse> => {
	const path = url.replace(/^https?:\/\/[^/]+/, "");
	const ok = (body: unknown): AuthFetchResponse => ({
		ok: true,
		status: 200,
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(JSON.stringify(body)),
	});
	if (path === "/auth/device/code")
		return Promise.resolve(
			ok({
				device_code: "dev-code",
				user_code: "WXYZ-1234",
				verification_uri: "https://app.deeplake.ai/device",
				verification_uri_complete: "https://app.deeplake.ai/device?code=WXYZ-1234",
				expires_in: 900,
				interval: 5,
			}),
		);
	if (path === "/auth/device/token") return Promise.resolve(ok({ access_token: "auth0-short", token_type: "Bearer" }));
	if (path === "/me") return Promise.resolve(ok({ id: "u-1", name: "Ada", email: "ada@deeplake.ai" }));
	if (path === "/organizations") return Promise.resolve(ok([{ id: "org-acme", name: "Acme" }]));
	if (path === "/users/me/tokens") return Promise.resolve(ok({ token: { token: "dl-longlived" } }));
	return Promise.resolve(ok("x"));
};

function recordingTelemetryFetch(opts: { throws?: boolean } = {}) {
	const calls: { url: string; init: TelemetryFetchRequestInit }[] = [];
	return {
		calls,
		fetch: (url: string, init: TelemetryFetchRequestInit) => {
			calls.push({ url, init });
			if (opts.throws === true) return Promise.reject(new Error("telemetry down"));
			return Promise.resolve({ ok: true, status: 200 });
		},
	};
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-firstlink-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("e-AC-1 the device-flow login emits honeycomb_first_link with the effective ref", () => {
	it("emits first_link after persist, carrying the explicit ref", async () => {
		const tele = recordingTelemetryFetch();
		await loginWithDeviceFlow({
			dir,
			env: {},
			fetch: authFetch,
			sleep: () => Promise.resolve(),
			openBrowser: () => true,
			maxPolls: 2,
			ref: "carol",
			telemetry: { fetch: tele.fetch, posthogKey: KEY },
		});
		expect(tele.calls).toHaveLength(1);
		const body = JSON.parse(tele.calls[0]!.init.body) as Record<string, unknown>;
		expect(body.event).toBe("honeycomb_first_link");
		expect((body.properties as Record<string, unknown>).ref).toBe("carol");
		// The distinct_id is the anonymized installId (e-AC-6), never the email.
		const id = body.distinct_id as string;
		expect(id).toBe(loadOnboarding(dir).installId);
		expect(id).not.toContain("@");
	});

	it("e-AC-4 a throwing telemetry fetch does NOT fail the login (credential still persisted)", async () => {
		const tele = recordingTelemetryFetch({ throws: true });
		const creds = await loginWithDeviceFlow({
			dir,
			env: {},
			fetch: authFetch,
			sleep: () => Promise.resolve(),
			openBrowser: () => true,
			maxPolls: 2,
			ref: "mario",
			telemetry: { fetch: tele.fetch, posthogKey: KEY },
		});
		// The login succeeded — the credential is persisted — despite telemetry throwing.
		expect(creds.token).toBe("dl-longlived");
		expect(creds.orgId).toBe("org-acme");
	});
});
