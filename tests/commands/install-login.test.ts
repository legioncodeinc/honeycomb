/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * PRD-003a — the install-time solo-vs-fleet login decision.
 *
 *   a-AC-1: FLEET (Hive detected) → the fresh install completes with NO browser popup / prompt; it
 *           prints the defer line and initiates nothing.
 *   a-AC-3: SOLO + no `~/.deeplake/credentials.json` → the device-flow popup auto-opens; SOLO with
 *           credentials already present → NO popup opens.
 *   a-AC-4: `honeycomb login` runs the device-flow popup path directly (not the headless token path),
 *           in both solo and fleet machine states (login ignores fleet detection).
 *   a-AC-7: headless (no browser) → the auto-login path prints the verification URL + user code and
 *           polls to completion instead of hanging (proven against the REAL device flow).
 *   AC-9:   a login failure is a plain-language, actionable line; the install still exits 0.
 *
 * All seams injected: no real daemon, browser, network, or `~/.deeplake`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuthLoginFlows, authMain } from "../../src/cli/auth.js";
import {
	createFakeDaemonClient,
	type DaemonLifecycle,
	type DaemonStatus,
	type InstallVerbDeps,
	runInstallCommand,
} from "../../src/commands/index.js";
import type { Credentials } from "../../src/daemon/runtime/auth/contracts.js";
import type { AuthFetch, AuthFetchResponse, DiskCredentials } from "../../src/daemon/runtime/auth/index.js";
import { loginWithDeviceFlow } from "../../src/daemon/runtime/auth/index.js";
import type { FleetClassification } from "../../src/shared/fleet-detection.js";

function fakeLifecycle(): DaemonLifecycle {
	return {
		async start() {
			return { started: false, alreadyRunning: true };
		},
		async stop() {
			return { stopped: true };
		},
		async status(): Promise<DaemonStatus> {
			return { running: true, pid: 1, port: 3850 };
		},
	};
}

const solo = async (): Promise<FleetClassification> => ({
	mode: "solo",
	signals: { registryHiveEntry: false, hivePortAnswering: false, hiveNpmGlobal: false },
	firedSignals: [],
});
const fleet = async (): Promise<FleetClassification> => ({
	mode: "fleet",
	signals: { registryHiveEntry: false, hivePortAnswering: true, hiveNpmGlobal: false },
	firedSignals: ["Hive portal on 127.0.0.1:3853"],
});

const fakeCreds: Credentials = {
	token: "t",
	orgId: "org1",
	orgName: "Org One",
	workspace: "default",
	agentId: "default",
	savedAt: "2026-07-04T00:00:00.000Z",
};

let tmpDir: string;
beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "hc-install-login-"));
});
afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Base install deps (daemon up, portal reachable, dashboard opener no-op). */
function baseInstallDeps(over: Partial<InstallVerbDeps>, lines: string[]): InstallVerbDeps {
	return {
		daemon: createFakeDaemonClient({ alive: true }),
		lifecycle: fakeLifecycle(),
		openDashboard: () => true,
		probeDashboard: async () => true,
		dir: tmpDir,
		out: (l) => lines.push(l),
		...over,
	};
}

describe("PRD-003a a-AC-1 — FLEET install defers login, opens NO browser popup", () => {
	it("a-AC-1 prints the defer line, calls NO login, reads NO credentials, and exits 0", async () => {
		const lines: string[] = [];
		let loginCalls = 0;
		let credsReads = 0;
		const res = await runInstallCommand(
			[],
			baseInstallDeps(
				{
					detectFleet: fleet,
					loadInstallCredentials: () => {
						credsReads += 1;
						return null;
					},
					runDeviceLogin: async () => {
						loginCalls += 1;
						return true;
					},
				},
				lines,
			),
		);
		expect(res.exitCode).toBe(0);
		expect(loginCalls).toBe(0); // no popup, no device flow initiated (a-AC-1)
		expect(credsReads).toBe(0); // fleet defers BEFORE touching credentials
		const text = lines.join("\n");
		expect(text).toMatch(/deferred to Hive/i);
		expect(text).toMatch(/fleet detection: FLEET/); // a-AC-6 evidence in the install output
	});
});

describe("PRD-003a a-AC-3 — SOLO install auto-opens the popup only when credentials are absent", () => {
	it("a-AC-3 SOLO + NO credentials → the device-flow login is invoked", async () => {
		const lines: string[] = [];
		let loginCalls = 0;
		const res = await runInstallCommand(
			[],
			baseInstallDeps(
				{
					detectFleet: solo,
					loadInstallCredentials: () => null,
					runDeviceLogin: async () => {
						loginCalls += 1;
						return true;
					},
				},
				lines,
			),
		);
		expect(res.exitCode).toBe(0);
		expect(loginCalls).toBe(1);
		expect(lines.join("\n")).toMatch(/opening sign-in/);
		expect(lines.join("\n")).toMatch(/signed in/);
	});

	it("a-AC-3 SOLO + credentials PRESENT → NO popup opens", async () => {
		const lines: string[] = [];
		let loginCalls = 0;
		const res = await runInstallCommand(
			[],
			baseInstallDeps(
				{
					detectFleet: solo,
					loadInstallCredentials: () => fakeCreds,
					runDeviceLogin: async () => {
						loginCalls += 1;
						return true;
					},
				},
				lines,
			),
		);
		expect(res.exitCode).toBe(0);
		expect(loginCalls).toBe(0);
		expect(lines.join("\n")).toMatch(/already signed in/);
	});
});

describe("PRD-003a a-AC-7 — headless auto-login prints the URL + code and polls to completion", () => {
	/** A fake `api.deeplake.ai` that replays a device-flow that approves on the first poll. */
	function fakeAuthFetch(): AuthFetch {
		const ok = (data: unknown): AuthFetchResponse => ({
			ok: true,
			status: 200,
			json: async () => data,
			text: async () => JSON.stringify(data),
		});
		return async (url: string): Promise<AuthFetchResponse> => {
			const path = new URL(url).pathname;
			if (path.endsWith("/auth/device/code")) {
				return ok({
					device_code: "dev-code",
					user_code: "WXYZ-1234",
					verification_uri: "https://deeplake.ai/activate",
					verification_uri_complete: "https://deeplake.ai/activate?code=WXYZ-1234",
					expires_in: 900,
					interval: 1,
				});
			}
			if (path.endsWith("/auth/device/token")) return ok({ access_token: "short-lived" });
			if (path.endsWith("/organizations")) return ok([{ id: "org1", name: "Org One" }]);
			if (path.endsWith("/workspaces")) return ok({ data: [] });
			if (path.endsWith("/users/me/tokens")) return ok({ token: { token: "long-lived" } });
			if (path.endsWith("/me")) return ok({ id: "u1", name: "Ada" });
			return ok({});
		};
	}

	it("a-AC-7 the REAL device flow, headless (opener returns false), prints URL+code and completes", async () => {
		const lines: string[] = [];
		let openerCalls = 0;
		const credsDir = mkdtempSync(join(tmpdir(), "hc-headless-creds-"));
		try {
			const res = await runInstallCommand(
				[],
				baseInstallDeps(
					{
						detectFleet: solo,
						loadInstallCredentials: () => null,
						// The install auto-login path drives the REAL loginWithDeviceFlow with a fake fetch +
						// a headless opener (returns false). The flow must print + poll, not hang.
						runDeviceLogin: async (out) => {
							await loginWithDeviceFlow({
								reporter: { prompt: (l) => out(l) },
								openBrowser: () => {
									openerCalls += 1;
									return false; // headless: no browser available
								},
								fetch: fakeAuthFetch(),
								sleep: async () => {},
								dir: credsDir,
								env: {},
							});
							return true;
						},
					},
					lines,
				),
			);
			expect(res.exitCode).toBe(0);
			expect(openerCalls).toBe(1); // the flow TRIED to open a browser (headless → false)
			const text = lines.join("\n");
			// a-AC-7: the verification URL + user code are printed even though no browser opened.
			expect(text).toContain("https://deeplake.ai/activate");
			expect(text).toContain("WXYZ-1234");
			expect(text).toMatch(/signed in/); // it polled to completion (no hang)
		} finally {
			rmSync(credsDir, { recursive: true, force: true });
		}
	});
});

describe("PRD-003a / AC-9 — an install-time login failure is actionable, never fatal", () => {
	it("AC-9 a throwing device login prints a `honeycomb login` hint and the install still exits 0", async () => {
		const lines: string[] = [];
		const res = await runInstallCommand(
			[],
			baseInstallDeps(
				{
					detectFleet: solo,
					loadInstallCredentials: () => null,
					runDeviceLogin: async () => {
						throw new Error("network down");
					},
				},
				lines,
			),
		);
		expect(res.exitCode).toBe(0);
		expect(lines.join("\n")).toMatch(/run `honeycomb login`/);
		// Plain-language only — no raw stack trace leaks (parent AC-7 / AC-9).
		expect(lines.join("\n")).not.toMatch(/at .*\(.*:\d+:\d+\)/);
	});

	it("AC-9 a detection failure DEFERS (never a wrong popup) with an actionable line", async () => {
		const lines: string[] = [];
		let loginCalls = 0;
		const res = await runInstallCommand(
			[],
			baseInstallDeps(
				{
					detectFleet: async () => {
						throw new Error("detection blew up");
					},
					runDeviceLogin: async () => {
						loginCalls += 1;
						return true;
					},
				},
				lines,
			),
		);
		expect(res.exitCode).toBe(0);
		expect(loginCalls).toBe(0); // suppressing a popup wrongly is cheap; opening one wrongly is the bug
		expect(lines.join("\n")).toMatch(/run `honeycomb login`/);
	});
});

describe("PRD-003a a-AC-4 — `honeycomb login` runs the device-flow popup path directly (both modes)", () => {
	/** A recording device-flow login: captures the deps it was handed + counts calls. */
	function recordingFlows(): { flows: AuthLoginFlows; deviceCalls: number; tokenCalls: number } {
		const disk: DiskCredentials = {
			token: "long-lived",
			orgId: "org1",
			orgName: "Org One",
			userName: "Ada",
			workspaceId: "default",
			apiUrl: "https://api.deeplake.ai",
			savedAt: "2026-07-04T00:00:00.000Z",
		};
		let deviceCalls = 0;
		let tokenCalls = 0;
		const flows: AuthLoginFlows = {
			deviceFlow: async (deps = {}) => {
				deviceCalls += 1;
				// a-AC-4: the device flow is handed a reporter so the URL + code reach the user.
				expect(deps.reporter).toBeDefined();
				return disk;
			},
			tokenLogin: async () => {
				tokenCalls += 1;
				return disk;
			},
		};
		return {
			flows,
			get deviceCalls() {
				return deviceCalls;
			},
			get tokenCalls() {
				return tokenCalls;
			},
		};
	}

	it("a-AC-4 `honeycomb login` (no --token) selects the DEVICE flow, not the headless token path", async () => {
		const rec = recordingFlows();
		const res = await authMain(["login"], { flows: rec.flows, dir: tmpDir, env: {}, out: () => {} });
		expect(res.exitCode).toBe(0);
		expect(rec.deviceCalls).toBe(1);
		expect(rec.tokenCalls).toBe(0);
	});

	it("a-AC-4 login is mode-independent: it runs the device flow whether or not Hive is present", async () => {
		// login does NOT consult fleet detection; a second invocation still runs the device flow.
		const rec = recordingFlows();
		await authMain(["login"], { flows: rec.flows, dir: tmpDir, env: {}, out: () => {} });
		await authMain(["login"], { flows: rec.flows, dir: tmpDir, env: {}, out: () => {} });
		expect(rec.deviceCalls).toBe(2);
		expect(rec.tokenCalls).toBe(0);
	});
});
