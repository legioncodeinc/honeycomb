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
 * PRD-073c — the `/setup/tenancy*` route family (the CANONICAL contract hive PRD-011 consumes).
 *
 * These tests pin the EXACT response shapes the hive onboarding is built against (do not drift a
 * field): GET /setup/tenancy, GET /setup/tenancy/orgs, GET /setup/tenancy/workspaces?org=, POST
 * /setup/tenancy/select, POST /setup/tenancy/workspaces. Driven in-process via `daemon.app.request`
 * against a fake auth client + a pre-populated pending-link store; no real network. The token is never
 * in any body (D-4).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type Clock,
	type DiskCredentials,
	credentialsPath,
	type DeeplakeAuthClient,
	isTenancyConfirmed,
	type OrgRow,
	type WorkspaceRow,
	saveDiskCredentials,
} from "../../../../src/daemon/runtime/auth/index.js";
import type { RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import {
	createPendingLinkStore,
	mountSetupTenancyApi,
	type PendingLinkStore,
	slugifyWorkspaceId,
} from "../../../../src/daemon/runtime/dashboard/setup-tenancy.js";

const FIXED = "2026-07-04T12:00:00.000Z";
const clock: Clock = { now: () => FIXED };

/** A fake DeeplakeAuthClient: scripted orgs/workspaces + a recording reMint/createWorkspace. */
function fakeClient(script: { orgs: OrgRow[]; workspaces: Record<string, WorkspaceRow[]> }): DeeplakeAuthClient {
	return {
		apiUrl: "https://api.deeplake.ai",
		getMe: async () => ({ id: "u-1", name: "Ada" }),
		listOrgs: async () => script.orgs,
		listWorkspaces: async (_t: string, org?: string) => script.workspaces[org ?? ""] ?? [],
		createWorkspace: async (_t: string, _org: string, id: string, name: string) => ({ id, name }),
		reMint: async () => "long-lived-tok",
		requestDeviceCode: async () => {
			throw new Error("n/a");
		},
		pollDeviceToken: async () => "pending" as const,
	};
}

function cfg(mode: RuntimeConfig["mode"] = "local"): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode, widened: false };
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-setup-tenancy-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function build(opts: {
	mode?: RuntimeConfig["mode"];
	store?: PendingLinkStore;
	script?: { orgs: OrgRow[]; workspaces: Record<string, WorkspaceRow[]> };
}): { daemon: Daemon; store: PendingLinkStore } {
	const store = opts.store ?? createPendingLinkStore();
	const daemon = createDaemon({ config: cfg(opts.mode ?? "local"), logger: createRequestLogger({ silent: true }) });
	const script = opts.script ?? { orgs: [], workspaces: {} };
	mountSetupTenancyApi(daemon, {
		store,
		credentialsDir: dir,
		env: {},
		clock,
		authClientFactory: () => fakeClient(script),
	});
	return { daemon, store };
}

describe("GET /setup/tenancy — the pending/selected read", () => {
	it("reports pending during an unconsumed link window (org/workspace null, selected false)", async () => {
		const store = createPendingLinkStore();
		store.set({
			authToken: "auth0",
			apiUrl: "https://api.deeplake.ai",
			orgs: [{ id: "org-a", name: "Acme" }],
			createdAt: Date.now(),
		});
		const { daemon } = build({ store });
		const body = (await (await daemon.app.request("/setup/tenancy")).json()) as Record<string, unknown>;
		expect(body).toEqual({ pending: true, selected: false, authenticated: true, org: null, workspace: null });
	});

	it("reports the persisted tenancy with selected:true (confirmedBy:selection) for an EXPLICITLY-selected credential", async () => {
		saveDiskCredentials(
			{
				token: "tok",
				orgId: "org-x",
				orgName: "Ex",
				workspaceId: "ws-1",
				apiUrl: "https://api.deeplake.ai",
				tenancyConfirmedAt: FIXED,
				savedAt: "",
			},
			dir,
			clock,
		);
		const { daemon } = build({});
		const body = (await (await daemon.app.request("/setup/tenancy")).json()) as Record<string, unknown>;
		expect(body).toEqual({
			pending: false,
			selected: true,
			confirmedBy: "selection",
			authenticated: true,
			org: { id: "org-x", name: "Ex" },
			workspace: { id: "ws-1", name: "ws-1" },
		});
	});

	it("parent AC-5: a GRANDFATHERED credential (no marker) reads selected:true with its tenancy, and the capture gate AGREES", async () => {
		// `selected` mirrors the ONE effective-confirmation predicate the capture gate consumes: a
		// pre-073 credential with a non-empty orgId is confirmed (grandfathered). The hive portal gate
		// therefore never traps an upgraded install into re-onboarding, and capture never gates it on
		// tenancy — the two surfaces cannot disagree because they read the same seam.
		saveDiskCredentials(
			{
				token: "tok",
				orgId: "org-g",
				orgName: "Gf",
				workspaceId: "default",
				apiUrl: "https://api.deeplake.ai",
				savedAt: "",
			},
			dir,
			clock,
		);
		const { daemon } = build({});
		const body = (await (await daemon.app.request("/setup/tenancy")).json()) as Record<string, unknown>;
		expect(body).toEqual({
			pending: false,
			selected: true,
			confirmedBy: "grandfathered",
			authenticated: true,
			org: { id: "org-g", name: "Gf" },
			workspace: { id: "default", name: "default" },
		});
		// The capture gate's seam agrees on the SAME credential (no tenancy_unconfirmed gating).
		expect(isTenancyConfirmed({ credentialsDir: dir, env: {} })).toBe(true);
	});

	it("nothing linked → pending:false, authenticated:false, null tenancy", async () => {
		const { daemon } = build({});
		const body = (await (await daemon.app.request("/setup/tenancy")).json()) as Record<string, unknown>;
		expect(body).toEqual({ pending: false, selected: false, authenticated: false, org: null, workspace: null });
	});
});

describe("GET /setup/tenancy/orgs + /workspaces — the enumeration reads", () => {
	it("orgs come from the pending window", async () => {
		const store = createPendingLinkStore();
		store.set({
			authToken: "auth0",
			apiUrl: "https://api.deeplake.ai",
			orgs: [
				{ id: "org-a", name: "Acme" },
				{ id: "org-b", name: "Beta" },
			],
			createdAt: Date.now(),
		});
		const { daemon } = build({ store });
		const body = (await (await daemon.app.request("/setup/tenancy/orgs")).json()) as Record<string, unknown>;
		expect(body).toEqual({
			orgs: [
				{ id: "org-a", name: "Acme" },
				{ id: "org-b", name: "Beta" },
			],
		});
	});

	it("workspaces?org= returns the org's workspaces + canCreate:true (Deeplake supports creation)", async () => {
		const store = createPendingLinkStore();
		store.set({
			authToken: "auth0",
			apiUrl: "https://api.deeplake.ai",
			orgs: [{ id: "org-a", name: "Acme" }],
			createdAt: Date.now(),
		});
		const { daemon } = build({
			store,
			script: { orgs: [{ id: "org-a", name: "Acme" }], workspaces: { "org-a": [{ id: "ws-1", name: "Prod" }] } },
		});
		const body = (await (await daemon.app.request("/setup/tenancy/workspaces?org=org-a")).json()) as Record<
			string,
			unknown
		>;
		expect(body).toEqual({ org: "org-a", workspaces: [{ id: "ws-1", name: "Prod" }], canCreate: true });
	});
});

describe("POST /setup/tenancy/select — phase 2 (persist the choice + marker)", () => {
	it("073c-AC-1.2: a valid selection persists the chosen pair + marker and acks { selected, org, workspace, reminted }", async () => {
		const store = createPendingLinkStore();
		store.set({
			authToken: "auth0",
			apiUrl: "https://api.deeplake.ai",
			orgs: [{ id: "org-a", name: "Acme" }],
			createdAt: Date.now(),
		});
		const { daemon } = build({
			store,
			script: { orgs: [{ id: "org-a", name: "Acme" }], workspaces: { "org-a": [{ id: "ws-1", name: "Prod" }] } },
		});
		const res = await daemon.app.request("/setup/tenancy/select", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ orgId: "org-a", workspaceId: "ws-1" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual({
			selected: true,
			org: { id: "org-a", name: "Acme" },
			workspace: { id: "ws-1", name: "ws-1" },
			reminted: true,
		});
		// The credential was written with the chosen pair + marker; the pending window is consumed.
		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as DiskCredentials;
		expect(onDisk.orgId).toBe("org-a");
		expect(onDisk.workspaceId).toBe("ws-1");
		expect(onDisk.tenancyConfirmedAt).toBe(FIXED);
		expect(store.get()).toBeNull();
		// D-4: no token in the ack.
		expect(JSON.stringify(body)).not.toContain("long-lived-tok");
	});

	it("073c-AC-1.3: a selection NOT in the enumerated list is rejected 400 with nothing persisted", async () => {
		const store = createPendingLinkStore();
		store.set({
			authToken: "auth0",
			apiUrl: "https://api.deeplake.ai",
			orgs: [{ id: "org-a", name: "Acme" }],
			createdAt: Date.now(),
		});
		const { daemon } = build({ store, script: { orgs: [{ id: "org-a", name: "Acme" }], workspaces: {} } });
		const res = await daemon.app.request("/setup/tenancy/select", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ orgId: "org-EVIL", workspaceId: "ws-1" }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).selected).toBe(false);
		expect(existsSync(credentialsPath(dir))).toBe(false);
	});

	it("073c-AC-1.4: select with NO pending window (lost on restart) fails safely, nothing written", async () => {
		const { daemon } = build({});
		const res = await daemon.app.request("/setup/tenancy/select", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ orgId: "org-a", workspaceId: "ws-1" }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).selected).toBe(false);
		expect(existsSync(credentialsPath(dir))).toBe(false);
	});

	it("073c-AC-1.4 (TTL expiry): a past-TTL pending window reads as no-pending, the slot nulls, and select refuses", async () => {
		// Drive the injectable clock past the TTL: the store discards the short-lived token (the slot
		// nulls on the next get) and every route behaves exactly as the no-pending contract — the read
		// reports not-linked and select 400s with nothing written. The user re-runs the link.
		let nowMs = 0;
		const store = createPendingLinkStore({ ttlMs: 1_000, now: () => nowMs });
		store.set({
			authToken: "auth0-short-SECRET",
			apiUrl: "https://api.deeplake.ai",
			orgs: [{ id: "org-a", name: "Acme" }],
			createdAt: nowMs,
		});
		const { daemon } = build({ store, script: { orgs: [{ id: "org-a", name: "Acme" }], workspaces: {} } });

		// Inside the TTL the window is live.
		nowMs = 1_000;
		expect(store.get()).not.toBeNull();
		// Past the TTL the slot nulls (the short-lived token is discarded).
		nowMs = 1_001;
		expect(store.get()).toBeNull();

		// GET /setup/tenancy behaves as no-pending (no credential → not linked).
		const read = (await (await daemon.app.request("/setup/tenancy")).json()) as Record<string, unknown>;
		expect(read).toEqual({ pending: false, selected: false, authenticated: false, org: null, workspace: null });

		// POST /setup/tenancy/select refuses per the no-pending contract; nothing is written.
		const sel = await daemon.app.request("/setup/tenancy/select", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ orgId: "org-a", workspaceId: "ws-1" }),
		});
		expect(sel.status).toBe(400);
		expect((await sel.json()).selected).toBe(false);
		expect(existsSync(credentialsPath(dir))).toBe(false);
	});
});

describe("FIX 1 re-selection from the PERSISTED credential AFTER the pending window is consumed", () => {
	const OLD = "2026-07-01T00:00:00.000Z";

	it("a second select (no pending window) to a DIFFERENT workspace succeeds and rewrites the credential to the new pair", async () => {
		// Simulate the post-confirmation state: a credential is already on disk (bound to org-a / ws-1,
		// explicitly confirmed) and there is NO pending window (it was single-use and consumed). The user
		// re-selects ws-2. This must work WITHOUT a fresh device-flow sign-in (the re-selection keystone).
		saveDiskCredentials(
			{
				token: "tok-initial",
				orgId: "org-a",
				orgName: "Acme",
				workspaceId: "ws-1",
				apiUrl: "https://api.deeplake.ai",
				tenancyConfirmedAt: OLD,
				savedAt: "",
			},
			dir,
			{ now: () => OLD },
		);
		const { daemon, store } = build({
			script: {
				orgs: [{ id: "org-a", name: "Acme" }],
				workspaces: {
					"org-a": [
						{ id: "ws-1", name: "Prod" },
						{ id: "ws-2", name: "Staging" },
					],
				},
			},
		});
		// Pre-condition: no pending window (the fast path is gone).
		expect(store.get()).toBeNull();

		const res = await daemon.app.request("/setup/tenancy/select", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ orgId: "org-a", workspaceId: "ws-2" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual({
			selected: true,
			org: { id: "org-a", name: "Acme" },
			workspace: { id: "ws-2", name: "ws-2" },
			reminted: true,
		});
		// The credential file was rewritten to the NEW pair with a FRESH confirmed-tenancy marker.
		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as DiskCredentials;
		expect(onDisk.orgId).toBe("org-a");
		expect(onDisk.workspaceId).toBe("ws-2");
		expect(onDisk.tenancyConfirmedAt).toBe(FIXED); // re-minted with the current clock, not OLD.
		// The re-mint overwrote the token; tenancy is still confirmed (no re-onboarding).
		expect(isTenancyConfirmed({ credentialsDir: dir, env: {} })).toBe(true);
		// D-4: no token in the ack.
		expect(JSON.stringify(body)).not.toContain("long-lived-tok");
	});

	it("a second select to a workspace NOT in the org's enumerated list is rejected (nothing rewritten)", async () => {
		saveDiskCredentials(
			{
				token: "tok-initial",
				orgId: "org-a",
				orgName: "Acme",
				workspaceId: "ws-1",
				apiUrl: "https://api.deeplake.ai",
				tenancyConfirmedAt: OLD,
				savedAt: "",
			},
			dir,
			{ now: () => OLD },
		);
		const { daemon } = build({
			script: { orgs: [{ id: "org-a", name: "Acme" }], workspaces: { "org-a": [{ id: "ws-1", name: "Prod" }] } },
		});
		const res = await daemon.app.request("/setup/tenancy/select", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ orgId: "org-a", workspaceId: "ws-EVIL" }),
		});
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.selected).toBe(false);
		// The on-disk credential is untouched (still ws-1 / the OLD marker).
		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as DiskCredentials;
		expect(onDisk.workspaceId).toBe("ws-1");
		expect(onDisk.tenancyConfirmedAt).toBe(OLD);
	});

	it("GET /setup/tenancy/orgs enumerates from the persisted token when there is NO pending window", async () => {
		saveDiskCredentials(
			{ token: "tok-initial", orgId: "org-a", orgName: "Acme", workspaceId: "ws-1", savedAt: "" },
			dir,
			{ now: () => OLD },
		);
		const { daemon } = build({
			script: {
				orgs: [
					{ id: "org-a", name: "Acme" },
					{ id: "org-b", name: "Beta" },
				],
				workspaces: {},
			},
		});
		const body = (await (await daemon.app.request("/setup/tenancy/orgs")).json()) as Record<string, unknown>;
		expect(body).toEqual({
			orgs: [
				{ id: "org-a", name: "Acme" },
				{ id: "org-b", name: "Beta" },
			],
		});
	});

	it("GET /setup/tenancy/workspaces?org= enumerates from the persisted token when there is NO pending window", async () => {
		saveDiskCredentials(
			{ token: "tok-initial", orgId: "org-a", orgName: "Acme", workspaceId: "ws-1", savedAt: "" },
			dir,
			{ now: () => OLD },
		);
		const { daemon } = build({
			script: {
				orgs: [{ id: "org-a", name: "Acme" }],
				workspaces: { "org-a": [{ id: "ws-1", name: "Prod" }, { id: "ws-2", name: "Staging" }] },
			},
		});
		const body = (await (await daemon.app.request("/setup/tenancy/workspaces?org=org-a")).json()) as Record<
			string,
			unknown
		>;
		expect(body).toEqual({
			org: "org-a",
			workspaces: [
				{ id: "ws-1", name: "Prod" },
				{ id: "ws-2", name: "Staging" },
			],
			canCreate: true,
		});
	});
});

describe("POST /setup/tenancy/workspaces — workspace creation (Deeplake supports it)", () => {
	it("creates a workspace, returning { created:true, workspace } with a slugged id", async () => {
		const store = createPendingLinkStore();
		store.set({
			authToken: "auth0",
			apiUrl: "https://api.deeplake.ai",
			orgs: [{ id: "org-a", name: "Acme" }],
			createdAt: Date.now(),
		});
		const { daemon } = build({ store, script: { orgs: [{ id: "org-a", name: "Acme" }], workspaces: {} } });
		const res = await daemon.app.request("/setup/tenancy/workspaces", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ org: "org-a", name: "My New Workspace" }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			created: true,
			workspace: { id: "my-new-workspace", name: "My New Workspace" },
		});
	});

	it("073c-AC-1.3 (create-path guard, security Low-1): an org NOT in the enumerated pending list is rejected 400 with no create call", async () => {
		const store = createPendingLinkStore();
		store.set({
			authToken: "auth0",
			apiUrl: "https://api.deeplake.ai",
			orgs: [{ id: "org-a", name: "Acme" }],
			createdAt: Date.now(),
		});
		const { daemon } = build({ store, script: { orgs: [{ id: "org-a", name: "Acme" }], workspaces: {} } });
		const res = await daemon.app.request("/setup/tenancy/workspaces", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ org: "org-EVIL", name: "Sneaky Workspace" }),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ created: false, error: "org is not in the enumerated list" });
	});

	it("rejects a name with no valid slug", async () => {
		const store = createPendingLinkStore();
		store.set({
			authToken: "auth0",
			apiUrl: "https://api.deeplake.ai",
			orgs: [{ id: "org-a", name: "Acme" }],
			createdAt: Date.now(),
		});
		const { daemon } = build({ store });
		const res = await daemon.app.request("/setup/tenancy/workspaces", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ org: "org-a", name: "***" }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).created).toBe(false);
	});
});

describe("local-mode gate + slug helper", () => {
	it("every route 404s outside local mode", async () => {
		const { daemon } = build({ mode: "team" });
		expect((await daemon.app.request("/setup/tenancy")).status).toBe(404);
		expect((await daemon.app.request("/setup/tenancy/orgs")).status).toBe(404);
		expect((await daemon.app.request("/setup/tenancy/workspaces?org=x")).status).toBe(404);
		const sel = await daemon.app.request("/setup/tenancy/select", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ orgId: "a", workspaceId: "b" }),
		});
		expect(sel.status).toBe(404);
	});

	it("slugifyWorkspaceId produces Deeplake-valid ids (or null)", () => {
		expect(slugifyWorkspaceId("My New Workspace")).toBe("my-new-workspace");
		expect(slugifyWorkspaceId("Prod_1")).toBe("prod-1");
		expect(slugifyWorkspaceId("***")).toBeNull();
		expect(slugifyWorkspaceId("  Alpha Beta  ")).toBe("alpha-beta");
	});
});
