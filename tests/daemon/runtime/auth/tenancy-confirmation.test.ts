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
 * PRD-073c / BUG 2 — `resolveTenancyConfirmation` is the ONE predicate the capture gate + the hive
 * portal gate consume. It must distinguish THREE credential shapes:
 *   1. explicit `tenancyConfirmedAt`  → confirmed (selection).
 *   2. pre-073 credential (no marker, no pending flag) → confirmed (grandfathered).
 *   3. BUG-2 base credential (`tenancyPending: true`, no marker) → UNCONFIRMED (capture stays gated).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Clock, saveDiskCredentials } from "../../../../src/daemon/runtime/auth/credentials-store.js";
import { resolveTenancyConfirmation } from "../../../../src/daemon/runtime/auth/tenancy-confirmation.js";

const FIXED = "2026-07-05T03:50:00.000Z";
const clock: Clock = { now: () => FIXED };

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-tenancy-conf-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("resolveTenancyConfirmation", () => {
	it("an explicit tenancyConfirmedAt marker is confirmed (selection, not grandfathered)", () => {
		saveDiskCredentials(
			{ token: "tok", orgId: "org-x", workspaceId: "ws-1", tenancyConfirmedAt: FIXED, savedAt: "" },
			dir,
			clock,
		);
		expect(resolveTenancyConfirmation({ credentialsDir: dir, env: {} })).toEqual({
			confirmed: true,
			confirmedAt: FIXED,
			grandfathered: false,
		});
	});

	it("a pre-073 credential (no marker, no pending flag) is grandfathered-confirmed (existing installs unchanged)", () => {
		saveDiskCredentials({ token: "tok", orgId: "org-g", workspaceId: "default", savedAt: "" }, dir, clock);
		expect(resolveTenancyConfirmation({ credentialsDir: dir, env: {} })).toEqual({
			confirmed: true,
			grandfathered: true,
		});
	});

	it("BUG 2: a base credential with tenancyPending:true and NO marker is UNCONFIRMED (capture gated)", () => {
		saveDiskCredentials(
			{ token: "tok", orgId: "org-a", workspaceId: "default", tenancyPending: true, savedAt: "" },
			dir,
			clock,
		);
		expect(resolveTenancyConfirmation({ credentialsDir: dir, env: {} })).toEqual({
			confirmed: false,
			grandfathered: false,
		});
	});

	it("no credential at all is unconfirmed", () => {
		expect(resolveTenancyConfirmation({ credentialsDir: dir, env: {} })).toEqual({
			confirmed: false,
			grandfathered: false,
		});
	});
});
