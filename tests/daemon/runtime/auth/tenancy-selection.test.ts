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
 * PRD-073c — the two-phase link: no tenancy guess is ever persisted (AC-named).
 *
 * A multi-org account with no pins/selector PAUSES (throws {@link TenancySelectionRequiredError}) with
 * NO file written; an explicit selector selection persists + re-mints for the CHOSEN org + stamps the
 * marker; a single-org+single-workspace account auto-selects; env pins count as explicit; a pre-073
 * credential is grandfathered as confirmed. Driven with a scriptable fake fetch — no real network.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type AuthFetch,
	type AuthFetchResponse,
	type Clock,
	type DiskCredentials,
	type Sleeper,
	credentialsPath,
	loginWithDeviceFlow,
	resolveTenancyConfirmation,
	saveDiskCredentials,
	TenancySelectionRequiredError,
} from "../../../../src/daemon/runtime/auth/index.js";

const FIXED = "2026-07-04T12:00:00.000Z";
const clock: Clock = { now: () => FIXED };
const noWait: Sleeper = (): Promise<void> => Promise.resolve();

function json(status: number, body: unknown): AuthFetchResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
	};
}

/** A scriptable fake fetch: `orgs` + per-org `workspaces`. `/workspaces` is scoped by the org header. */
function fakeFetch(opts: {
	orgs: { id: string; name: string }[];
	workspaces: Record<string, { id: string; name: string }[]>;
}): AuthFetch {
	return (url: string, init): Promise<AuthFetchResponse> => {
		const path = url.replace(/^https?:\/\/[^/]+/, "");
		if (path === "/auth/device/code") {
			return Promise.resolve(
				json(200, {
					device_code: "dev",
					user_code: "WXYZ-1234",
					verification_uri: "https://app.deeplake.ai/device",
					verification_uri_complete: "https://app.deeplake.ai/device?code=WXYZ-1234",
					expires_in: 900,
					interval: 5,
				}),
			);
		}
		if (path === "/auth/device/token") return Promise.resolve(json(200, { access_token: "auth0-short" }));
		if (path === "/me") return Promise.resolve(json(200, { id: "u-1", name: "Ada", email: "ada@deeplake.ai" }));
		if (path === "/organizations") return Promise.resolve(json(200, opts.orgs));
		if (path === "/users/me/tokens") return Promise.resolve(json(200, { token: { token: "long-lived-tok" } }));
		if (path === "/workspaces") {
			const org = init?.headers?.["X-Activeloop-Org-Id"] ?? "";
			return Promise.resolve(json(200, { data: opts.workspaces[org] ?? [] }));
		}
		return Promise.resolve(json(404, "x"));
	};
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-tenancy-sel-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("073c-AC-1.1: a multi-org account with no pins/selector PAUSES with NO file written", () => {
	it("throws TenancySelectionRequiredError carrying the org list; no credential is written", async () => {
		const fetch = fakeFetch({
			orgs: [
				{ id: "org-a", name: "Acme" },
				{ id: "org-b", name: "Beta" },
			],
			workspaces: {},
		});
		let caught: unknown;
		try {
			await loginWithDeviceFlow({
				dir,
				clock,
				env: {},
				fetch,
				sleep: noWait,
				openBrowser: () => true,
				reporter: { prompt: () => {} },
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(TenancySelectionRequiredError);
		expect((caught as TenancySelectionRequiredError).orgs.map((o) => o.id)).toEqual(["org-a", "org-b"]);
		expect(existsSync(credentialsPath(dir))).toBe(false);
	});
});

describe("073c-AC-1.2: an explicit selection persists + re-mints for the CHOSEN org + stamps the marker", () => {
	it("the selector's choice is persisted (chosen org/workspace + tenancyConfirmedAt)", async () => {
		const fetch = fakeFetch({
			orgs: [
				{ id: "org-a", name: "Acme" },
				{ id: "org-b", name: "Beta" },
			],
			workspaces: { "org-b": [{ id: "ws-prod", name: "Prod" }] },
		});
		const disk = await loginWithDeviceFlow({
			dir,
			clock,
			env: {},
			fetch,
			sleep: noWait,
			openBrowser: () => true,
			reporter: { prompt: () => {} },
			selectTenancy: async () => ({ orgId: "org-b", workspaceId: "ws-prod" }),
		});
		expect(disk.orgId).toBe("org-b");
		expect(disk.orgName).toBe("Beta");
		expect(disk.workspaceId).toBe("ws-prod");
		expect(disk.tenancyConfirmedAt).toBe(FIXED);
		expect(disk.token).toBe("long-lived-tok");
		// It is ON DISK with the marker.
		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as DiskCredentials;
		expect(onDisk.orgId).toBe("org-b");
		expect(onDisk.tenancyConfirmedAt).toBe(FIXED);
	});
});

describe("073c-AC-2.1: single-org + single-workspace auto-selects (no selector) + stamps the marker", () => {
	it("auto-selects the one pair and confirms tenancy", async () => {
		const fetch = fakeFetch({
			orgs: [{ id: "org-solo", name: "Solo" }],
			workspaces: { "org-solo": [{ id: "ws-1", name: "Primary" }] },
		});
		const disk = await loginWithDeviceFlow({
			dir,
			clock,
			env: {},
			fetch,
			sleep: noWait,
			openBrowser: () => true,
			reporter: { prompt: () => {} },
		});
		expect(disk.orgId).toBe("org-solo");
		expect(disk.workspaceId).toBe("ws-1");
		expect(disk.tenancyConfirmedAt).toBe(FIXED);
	});
});

describe("073c-AC-2.2: env pins count as an explicit selection (CI/scripted parity)", () => {
	it("HONEYCOMB_ORG_ID + HONEYCOMB_WORKSPACE_ID select the pinned pair on a multi-org account", async () => {
		const fetch = fakeFetch({
			orgs: [
				{ id: "org-a", name: "Acme" },
				{ id: "org-b", name: "Beta" },
			],
			workspaces: {},
		});
		const disk = await loginWithDeviceFlow({
			dir,
			clock,
			env: { HONEYCOMB_ORG_ID: "org-b", HONEYCOMB_WORKSPACE_ID: "ws-pinned" },
			fetch,
			sleep: noWait,
			openBrowser: () => true,
			reporter: { prompt: () => {} },
		});
		expect(disk.orgId).toBe("org-b");
		expect(disk.workspaceId).toBe("ws-pinned");
		expect(disk.tenancyConfirmedAt).toBe(FIXED);
	});
});

describe("073c-AC-3.2 / AC-5: grandfathering — a pre-073 credential reads confirmed", () => {
	it("a credential with a non-empty orgId and NO marker is grandfathered (confirmed, no marker)", () => {
		saveDiskCredentials(
			{
				token: "tok",
				orgId: "org-old",
				orgName: "Old",
				workspaceId: "default",
				apiUrl: "https://api.deeplake.ai",
				savedAt: "",
			},
			dir,
			clock,
		);
		const confirmation = resolveTenancyConfirmation({ credentialsDir: dir, env: {} });
		expect(confirmation.confirmed).toBe(true);
		expect(confirmation.grandfathered).toBe(true);
		expect(confirmation.confirmedAt).toBeUndefined();
	});

	it("an explicitly-selected credential reads confirmed WITH the marker (not grandfathered)", () => {
		saveDiskCredentials(
			{
				token: "tok",
				orgId: "org-x",
				orgName: "X",
				workspaceId: "ws-1",
				apiUrl: "https://api.deeplake.ai",
				tenancyConfirmedAt: FIXED,
				savedAt: "",
			},
			dir,
			clock,
		);
		const confirmation = resolveTenancyConfirmation({ credentialsDir: dir, env: {} });
		expect(confirmation.confirmed).toBe(true);
		expect(confirmation.grandfathered).toBe(false);
		expect(confirmation.confirmedAt).toBe(FIXED);
	});

	it("NO credential (a pending/fresh state) reads UNCONFIRMED", () => {
		const confirmation = resolveTenancyConfirmation({ credentialsDir: dir, env: {} });
		expect(confirmation.confirmed).toBe(false);
	});
});
