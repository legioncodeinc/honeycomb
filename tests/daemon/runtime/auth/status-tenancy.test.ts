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
 * PRD-073c — `/api/auth/status` additively reports the confirmed-tenancy state (parent AC-7). The
 * dashboard header reads `tenancyConfirmed` (+ the optional `tenancyConfirmedAt` marker) to show
 * "org X / workspace Y (confirmed)". The body still carries NO token by construction (D-4).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Clock, resolveAuthStatus, saveDiskCredentials } from "../../../../src/daemon/runtime/auth/index.js";

const FIXED = "2026-07-04T12:00:00.000Z";
const clock: Clock = { now: () => FIXED };

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-status-tenancy-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("073c: /api/auth/status reports the confirmation state", () => {
	it("an EXPLICITLY-selected credential reports tenancyConfirmed:true + the marker timestamp", () => {
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
		const status = resolveAuthStatus({ credentialsDir: dir, env: {} });
		expect(status.connected).toBe(true);
		expect(status.tenancyConfirmed).toBe(true);
		expect(status.tenancyConfirmedAt).toBe(FIXED);
	});

	it("a grandfathered credential (no marker) reports tenancyConfirmed:true with NO marker", () => {
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
		const status = resolveAuthStatus({ credentialsDir: dir, env: {} });
		expect(status.tenancyConfirmed).toBe(true);
		expect(status.tenancyConfirmedAt).toBeUndefined();
	});

	it("a disconnected daemon reports tenancyConfirmed:false and carries no token field", () => {
		const status = resolveAuthStatus({ credentialsDir: dir, env: {} });
		expect(status.connected).toBe(false);
		expect(status.tenancyConfirmed).toBe(false);
		expect(JSON.stringify(status)).not.toContain("token");
	});
});
