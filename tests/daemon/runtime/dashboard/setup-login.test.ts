/**
 * PRD-050c — the "First time setup" on-page login route (`POST /setup/login`).
 *
 * Verification posture: `mountSetupLogin` is driven DIRECTLY (the attach mechanics) against a daemon
 * with a CAPTURING logger. The device flow is injected (a fake `runDeviceFlow`) so no real network /
 * browser fires — the fake calls `onGrant` with a canned grant, then resolves like a real persist
 * would. A SECOND end-to-end variant drives the REAL `loginWithDeviceFlow` with an injected fetch +
 * recorder opener + temp HOME, proving the route + the real device flow compose.
 *
 * c-AC-3 the route begins the flow and the response renders `user_code` + verification URIs.
 * c-AC-4 the device/bearer token is NEVER in the response body NOR any log line emitted during the flow.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type AuthFetch,
	type AuthFetchResponse,
	type DeviceFlowLoginDeps,
} from "../../../../src/daemon/runtime/auth/index.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import { SETUP_LOGIN_PATH, mountSetupLogin } from "../../../../src/daemon/runtime/dashboard/setup-login.js";

const BEARER_TOKEN = "dl-longlived-tok-SECRET-XYZ";
const DEVICE_CODE = "dev-code-SECRET-poll-handle";

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

/** A daemon with a NON-silent ring-buffer logger so a test reads back every log record. */
function makeDaemon() {
	const logger = createRequestLogger({ silent: true });
	const daemon = createDaemon({ config: cfg(), logger });
	return { daemon, logger };
}

/** Concatenate the logger's request records into one scannable string (for token-leak assertions). */
function logText(logger: ReturnType<typeof createRequestLogger>): string {
	return logger.recent().map((r) => JSON.stringify(r)).join("\n");
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-setup-login-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("c-AC-3 POST /setup/login begins the flow and renders user_code + verification URIs", () => {
	it("returns the grant's user_code + verification URIs (NO token) from the injected device flow", async () => {
		const { daemon } = makeDaemon();
		// A fake device flow: fire `onGrant` with a canned grant, then resolve like a real persist.
		const runDeviceFlow = (deps: DeviceFlowLoginDeps): Promise<unknown> => {
			deps.onGrant?.({
				device_code: DEVICE_CODE,
				user_code: "WXYZ-1234",
				verification_uri: "https://app.deeplake.ai/device",
				verification_uri_complete: "https://app.deeplake.ai/device?code=WXYZ-1234",
				expires_in: 900,
				interval: 5,
			});
			return Promise.resolve({ token: BEARER_TOKEN });
		};
		mountSetupLogin(daemon, { runDeviceFlow, dir });

		const res = await daemon.app.request(SETUP_LOGIN_PATH, { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.user_code).toBe("WXYZ-1234");
		expect(body.verification_uri).toBe("https://app.deeplake.ai/device");
		expect(body.verification_uri_complete).toBe("https://app.deeplake.ai/device?code=WXYZ-1234");
	});

	it("threads an explicit `ref` from the body into the device-flow deps", async () => {
		const { daemon } = makeDaemon();
		let seenRef: string | undefined = "UNSET";
		const runDeviceFlow = (deps: DeviceFlowLoginDeps): Promise<unknown> => {
			seenRef = deps.ref;
			deps.onGrant?.({
				device_code: DEVICE_CODE,
				user_code: "AAAA-0000",
				verification_uri: "https://app.deeplake.ai/device",
				verification_uri_complete: "https://app.deeplake.ai/device?code=AAAA-0000",
				expires_in: 900,
				interval: 5,
			});
			return Promise.resolve({});
		};
		mountSetupLogin(daemon, { runDeviceFlow, dir });

		await daemon.app.request(SETUP_LOGIN_PATH, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ref: "frank" }),
		});
		expect(seenRef).toBe("frank");
	});

	it("a device-code failure (no grant) surfaces a redacted 502 with no token", async () => {
		const { daemon } = makeDaemon();
		// The flow rejects BEFORE firing onGrant (the device-code request failed).
		const runDeviceFlow = (): Promise<unknown> => Promise.reject(new Error("device-code 503"));
		mountSetupLogin(daemon, { runDeviceFlow, dir });

		const res = await daemon.app.request(SETUP_LOGIN_PATH, { method: "POST" });
		expect(res.status).toBe(502);
		const text = await res.text();
		expect(text).not.toContain(BEARER_TOKEN);
	});
});

describe("c-AC-4 the device/bearer token is NEVER in the response body nor any log line", () => {
	it("no token / device_code appears in the response body or the logger buffer (injected flow)", async () => {
		const { daemon, logger } = makeDaemon();
		const runDeviceFlow = (deps: DeviceFlowLoginDeps): Promise<unknown> => {
			deps.onGrant?.({
				device_code: DEVICE_CODE,
				user_code: "WXYZ-1234",
				verification_uri: "https://app.deeplake.ai/device",
				verification_uri_complete: "https://app.deeplake.ai/device?code=WXYZ-1234",
				expires_in: 900,
				interval: 5,
			});
			return Promise.resolve({ token: BEARER_TOKEN });
		};
		mountSetupLogin(daemon, { runDeviceFlow, dir });

		const res = await daemon.app.request(SETUP_LOGIN_PATH, { method: "POST" });
		const text = await res.text();

		// The response body carries ONLY user_code + URIs — never the bearer token or the device_code handle.
		expect(text).toContain("WXYZ-1234");
		expect(text).not.toContain(BEARER_TOKEN);
		expect(text).not.toContain(DEVICE_CODE);

		// The request logger's records carry no token/device_code either (the daemon logs method/path/status only).
		const logs = logText(logger);
		expect(logs).not.toContain(BEARER_TOKEN);
		expect(logs).not.toContain(DEVICE_CODE);
	});

	it("end-to-end with the REAL device flow (injected fetch) leaks no token to the body or logs", async () => {
		const { daemon, logger } = makeDaemon();
		// The REAL loginWithDeviceFlow with a fake fetch + a recorder opener + temp HOME — no real I/O.
		const fetch: AuthFetch = (url): Promise<AuthFetchResponse> => {
			const path = url.replace(/^https?:\/\/[^/]+/, "");
			const ok = (body: unknown): AuthFetchResponse => ({
				ok: true,
				status: 200,
				json: () => Promise.resolve(body),
				text: () => Promise.resolve(JSON.stringify(body)),
			});
			if (path === "/auth/device/code") {
				return Promise.resolve(
					ok({
						device_code: DEVICE_CODE,
						user_code: "WXYZ-1234",
						verification_uri: "https://app.deeplake.ai/device",
						verification_uri_complete: "https://app.deeplake.ai/device?code=WXYZ-1234",
						expires_in: 900,
						interval: 5,
					}),
				);
			}
			if (path === "/auth/device/token") return Promise.resolve(ok({ access_token: "auth0-short", token_type: "Bearer" }));
			if (path === "/me") return Promise.resolve(ok({ id: "u-1", name: "Ada", email: "ada@deeplake.ai" }));
			if (path === "/organizations") return Promise.resolve(ok([{ id: "org-acme", name: "Acme" }]));
			if (path === "/users/me/tokens") return Promise.resolve(ok({ token: { token: BEARER_TOKEN } }));
			return Promise.resolve(ok("x"));
		};

		// Wrap the real flow so the route's seam injects our fetch/sleep/opener/dir deterministically.
		const { loginWithDeviceFlow } = await import("../../../../src/daemon/runtime/auth/index.js");
		const runDeviceFlow = (deps: DeviceFlowLoginDeps): Promise<unknown> =>
			loginWithDeviceFlow({
				...deps,
				dir,
				env: {},
				fetch,
				sleep: () => Promise.resolve(),
				openBrowser: () => true,
				maxPolls: 2,
			});
		mountSetupLogin(daemon, { runDeviceFlow, dir });

		const res = await daemon.app.request(SETUP_LOGIN_PATH, { method: "POST" });
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("WXYZ-1234");
		expect(text).not.toContain(BEARER_TOKEN);
		expect(text).not.toContain(DEVICE_CODE);
		expect(logText(logger)).not.toContain(BEARER_TOKEN);
	});
});
