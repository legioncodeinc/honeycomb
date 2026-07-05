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
 * BUG 2 — the on-page `/setup/login` background flow must MINT + PERSIST base credentials from an
 * approved device token WITHOUT requiring an interactive tenancy step, so `/setup/state.authenticated`
 * (the field hive's onboarding polls) flips the instant the user approves.
 *
 * Field failure: on a real multi-tenancy account the two-phase link parked a pending window and
 * persisted NOTHING, so `loadCredentials(...) === null` kept `/setup/state.authenticated` false
 * forever and hive's "One last step: link Deeplake" page never advanced.
 *
 * These tests drive the REAL `makePendingLinkRunner` (the runner `/setup/login` runs) with an injected
 * fetch — no real network, no browser, no TTY, and CRUCIALLY no `selectTenancy` selector anywhere,
 * proving authentication completes with NO interactive tenancy step. Tenancy stays UNCONFIRMED (the
 * capture gate closed) until the separate `/setup/tenancy/select` step stamps `tenancyConfirmedAt`.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type AuthFetch,
	type AuthFetchResponse,
	type Clock,
	credentialsPath,
	type DiskCredentials,
	isTenancyConfirmed,
} from "../../../../src/daemon/runtime/auth/index.js";
import type { RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import {
	createPendingLinkStore,
	makePendingLinkRunner,
	mountSetupTenancyApi,
} from "../../../../src/daemon/runtime/dashboard/setup-tenancy.js";
import { mountSetupStateApi, resolveSetupState } from "../../../../src/daemon/runtime/dashboard/setup-state.js";

const FIXED = "2026-07-05T03:50:00.000Z";
const clock: Clock = { now: () => FIXED };
const DEVICE_CODE = "dev-code-SECRET-poll-handle";
const SHORT_LIVED = "auth0-short-SECRET";
const LONG_LIVED = "dl-longlived-tok-SECRET-XYZ";

/** An `ok` JSON response in the injected-`fetch` shape. */
function ok(body: unknown): AuthFetchResponse {
	return {
		ok: true,
		status: 200,
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(JSON.stringify(body)),
	};
}

/**
 * A fake auth backend driving the whole device flow. `orgs` decides the tenancy shape: two orgs is the
 * multi-tenancy account that used to hang; one org is the single-tenancy auto-select. `workspaces` is
 * what `/workspaces` returns (single-org auto-select lists it soft).
 */
function backendFetch(orgs: ReadonlyArray<{ id: string; name: string }>, workspaces: unknown = []): AuthFetch {
	return (url): Promise<AuthFetchResponse> => {
		const path = url.replace(/^https?:\/\/[^/]+/, "");
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
		if (path === "/auth/device/token") return Promise.resolve(ok({ access_token: SHORT_LIVED, token_type: "Bearer" }));
		if (path === "/organizations") return Promise.resolve(ok(orgs));
		if (path === "/workspaces") return Promise.resolve(ok(workspaces));
		if (path === "/users/me/tokens") return Promise.resolve(ok({ token: { token: LONG_LIVED } }));
		if (path === "/me") return Promise.resolve(ok({ id: "u-1", name: "Ada", email: "ada@deeplake.ai" }));
		return Promise.resolve(ok("x"));
	};
}

/** Run the real `/setup/login` background runner with an injected fetch (no network/browser/TTY). */
function runBackgroundLogin(
	fetch: AuthFetch,
	store: ReturnType<typeof createPendingLinkStore>,
	dir: string,
): Promise<unknown> {
	// No `selectTenancy` is threaded ANYWHERE — this is the whole point: auth must complete with no
	// interactive tenancy step. The device flow's seams are injected so nothing real is touched.
	const runner = makePendingLinkRunner({ store, credentialsDir: dir, env: {}, clock });
	return runner({
		dir,
		env: {},
		fetch,
		sleep: () => Promise.resolve(),
		openBrowser: () => true,
		maxPolls: 2,
		reporter: { prompt: () => {} },
	});
}

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-setup-login-base-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("BUG 2 — /setup/login persists base credentials so /setup/state flips authenticated (multi-tenancy)", () => {
	it("b2-AC-1 a multi-tenancy device approval persists base credentials with NO interactive tenancy step", async () => {
		const store = createPendingLinkStore();
		const result = await runBackgroundLogin(backendFetch([{ id: "org-a", name: "Acme" }, { id: "org-b", name: "Beta" }]), store, dir);

		// The runner parked a pending window (the explicit pick is still owed) AND persisted base creds.
		expect(result).toEqual({ pending: true });
		expect(store.get()).not.toBeNull();

		// THE FIX: authentication is complete — a credential persisted, so /setup/state.authenticated is true.
		const state = resolveSetupState({ homeDir: dir, credentialsDir: dir, legacyCredentialsDir: dir, onboardingDir: dir, env: {} });
		expect(state.authenticated).toBe(true);

		// The persisted credential is AUTH-ONLY: bound provisionally to the first org, marked pending, no marker.
		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as DiskCredentials;
		expect(onDisk.orgId).toBe("org-a");
		expect(onDisk.token).toBe(LONG_LIVED);
		expect(onDisk.tenancyPending).toBe(true);
		expect(onDisk.tenancyConfirmedAt).toBeUndefined();

		// Tenancy stays UNCONFIRMED: the capture gate is closed, so NO data reaches the provisional org.
		expect(isTenancyConfirmed({ credentialsDir: dir, env: {} })).toBe(false);
	});

	it("b2-AC-2 GET /setup/state reports authenticated:true after the approval (the field hive polls)", async () => {
		const store = createPendingLinkStore();
		await runBackgroundLogin(backendFetch([{ id: "org-a", name: "Acme" }, { id: "org-b", name: "Beta" }]), store, dir);

		const daemon = createDaemon({ config: cfg(), logger: createRequestLogger({ silent: true }) });
		mountSetupStateApi(daemon, {
			homeDir: dir,
			credentialsDir: dir,
			legacyCredentialsDir: dir,
			onboardingDir: dir,
			env: {},
		});
		const res = await daemon.app.request("/setup/state");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.authenticated).toBe(true);
	});

	it("b2-AC-3 the persisted base token is never echoed to /setup/tenancy while the pick is pending", async () => {
		const store = createPendingLinkStore();
		await runBackgroundLogin(backendFetch([{ id: "org-a", name: "Acme" }, { id: "org-b", name: "Beta" }]), store, dir);

		const daemon = createDaemon({ config: cfg(), logger: createRequestLogger({ silent: true }) });
		mountSetupTenancyApi(daemon, { store, credentialsDir: dir, env: {}, clock });
		const res = await daemon.app.request("/setup/tenancy");
		const text = await res.text();
		// The picker still shows (pending, not selected) and no token leaks (D-4).
		const body = JSON.parse(text) as Record<string, unknown>;
		expect(body).toMatchObject({ pending: true, selected: false, authenticated: true });
		expect(text).not.toContain(LONG_LIVED);
		expect(text).not.toContain(SHORT_LIVED);
	});
});

describe("BUG 2 — the single-tenancy auto-select path still persists a CONFIRMED credential (regression)", () => {
	it("b2-AC-4 a single-org account auto-selects, persists with the confirmed marker, and clears pending", async () => {
		const store = createPendingLinkStore();
		const result = await runBackgroundLogin(backendFetch([{ id: "org-solo", name: "Solo" }], []), store, dir);

		// Single tenancy auto-selects and persists immediately — no pending window is left behind.
		expect(result).toEqual({ persisted: { orgId: "org-solo", workspaceId: "default" } });
		expect(store.get()).toBeNull();

		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as DiskCredentials;
		expect(onDisk.orgId).toBe("org-solo");
		expect(onDisk.tenancyConfirmedAt).toBe(FIXED);
		expect(onDisk.tenancyPending).toBeUndefined();

		// A confirmed credential: authenticated AND the capture gate open (single-tenancy is unambiguous).
		const state = resolveSetupState({ homeDir: dir, credentialsDir: dir, legacyCredentialsDir: dir, onboardingDir: dir, env: {} });
		expect(state.authenticated).toBe(true);
		expect(isTenancyConfirmed({ credentialsDir: dir, env: {} })).toBe(true);
	});
});
