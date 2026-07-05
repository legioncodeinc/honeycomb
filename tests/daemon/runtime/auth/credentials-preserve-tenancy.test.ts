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
 * W2-FIX-1 — credential-integrity: a NON-tenancy credential rewrite must PRESERVE the additive on-disk
 * tenancy markers instead of silently dropping them (the observed marker-less write). The rule:
 *   - SAME-ORG rewrite (a re-login / an org-drift heal that did not change org) → keep
 *     `tenancyConfirmedAt` / `tenancyPending` / `userName` VERBATIM.
 *   - ORG-CHANGING rewrite (e.g. `healOrgDrift` realigns to a different org) → DROP a stale
 *     `tenancyConfirmedAt` and set `tenancyPending: true` (the honest "unconfirmed under the new org").
 *   - EXPLICIT tenancy paths keep full control via `saveDiskCredentials` (it writes the record it is
 *     given verbatim), so the dashboard/CLI switcher `...disk` spreads keep preserving.
 *
 * Verification posture: a TEMP credentials dir + a fake clock + a FAKE TokenIssuer. No real
 * `~/.deeplake`, no real wall clock, no auth server. The tenancy markers are read off the RAW on-disk
 * JSON (the in-memory `Credentials` shape does not carry them).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type Clock,
	type Credentials,
	createFakeTokenIssuer,
	credentialsPath,
	encodeStubToken,
	healOrgDrift,
	type MintedToken,
	saveCredentials,
	saveDiskCredentials,
} from "../../../../src/daemon/runtime/auth/index.js";

const FIXED = "2026-07-05T00:00:00.000Z";

function clock(): Clock {
	return { now: () => FIXED };
}

/** A stub org-bound token that decodes back to the given org (via verifyTokenClaims). */
function tokenForOrg(org: string, extra: Record<string, unknown> = {}): string {
	return encodeStubToken({ org, ...extra });
}

/** A complete in-memory credentials record bound to an org (the shape `saveCredentials` takes). */
function credsFor(org: string, over: Partial<Credentials> = {}): Credentials {
	return {
		token: tokenForOrg(org),
		orgId: org,
		orgName: `${org} Inc`,
		workspace: "backend",
		agentId: "agent-1",
		savedAt: "2020-01-01T00:00:00.000Z",
		...over,
	};
}

/** A minted token whose claims decode back via verifyTokenClaims (for the re-mint seam). */
function minted(org: string, over: Record<string, unknown> = {}): MintedToken {
	const claims = { org, workspace: "default", agentId: "agent-1", ...over };
	return { token: encodeStubToken(claims), claims };
}

/** Read the RAW on-disk JSON so the additive tenancy markers (dropped by the in-memory shape) show. */
function readRaw(target: string): Record<string, unknown> {
	return JSON.parse(readFileSync(credentialsPath(target), "utf8")) as Record<string, unknown>;
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-preserve-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("W2-AC-1 a SAME-ORG saveCredentials preserves the tenancy markers verbatim", () => {
	it("keeps tenancyConfirmedAt + userName across a plain same-org rewrite", () => {
		// Seed a prior on-disk record for org=acme carrying a CONFIRMED tenancy + a userName.
		saveDiskCredentials(
			{
				token: tokenForOrg("acme"),
				orgId: "acme",
				orgName: "acme Inc",
				userName: "alice",
				workspaceId: "backend",
				apiUrl: "https://api.deeplake.ai",
				tenancyConfirmedAt: "2026-06-01T00:00:00.000Z",
				savedAt: "",
			},
			dir,
			clock(),
		);
		// A plain rewrite (same org) — must NOT drop the markers (the marker-less-write bug).
		saveCredentials(credsFor("acme"), dir, clock());
		const raw = readRaw(dir);
		expect(raw.tenancyConfirmedAt).toBe("2026-06-01T00:00:00.000Z");
		expect(raw.userName).toBe("alice");
		expect(raw.orgId).toBe("acme");
	});

	it("keeps a pending marker verbatim (no confirm invented) across a same-org rewrite", () => {
		saveDiskCredentials(
			{ token: tokenForOrg("acme"), orgId: "acme", workspaceId: "backend", tenancyPending: true, savedAt: "" },
			dir,
			clock(),
		);
		saveCredentials(credsFor("acme"), dir, clock());
		const raw = readRaw(dir);
		expect(raw.tenancyPending).toBe(true);
		expect(raw.tenancyConfirmedAt).toBeUndefined();
	});

	it("preserves a self-hosted apiUrl when the caller passes none", () => {
		saveDiskCredentials(
			{
				token: tokenForOrg("acme"),
				orgId: "acme",
				workspaceId: "backend",
				apiUrl: "https://self.hosted.example",
				savedAt: "",
			},
			dir,
			clock(),
		);
		saveCredentials(credsFor("acme"), dir, clock());
		expect(readRaw(dir).apiUrl).toBe("https://self.hosted.example");
	});
});

describe("W2-AC-2 an ORG-CHANGING saveCredentials drops the stale confirm and marks pending", () => {
	it("drops tenancyConfirmedAt and sets tenancyPending when the org changes", () => {
		// Prior: CONFIRMED under old-org.
		saveDiskCredentials(
			{
				token: tokenForOrg("old"),
				orgId: "old",
				orgName: "Old",
				userName: "alice",
				workspaceId: "backend",
				tenancyConfirmedAt: "2026-06-01T00:00:00.000Z",
				savedAt: "",
			},
			dir,
			clock(),
		);
		// Rewrite bound to a DIFFERENT org (a realign): the old-org confirm must not ride onto the new org.
		saveCredentials(credsFor("new"), dir, clock());
		const raw = readRaw(dir);
		expect(raw.orgId).toBe("new");
		expect(raw.tenancyConfirmedAt).toBeUndefined(); // stale confirm dropped
		expect(raw.tenancyPending).toBe(true); // honest unconfirmed posture
		expect(raw.userName).toBe("alice"); // org-independent identity still preserved
	});
});

describe("W2-AC-3 healOrgDrift org-realign keeps the markers honest (drop confirm, mark pending)", () => {
	it("drops the old-org confirm and marks the new org pending after a re-mint", async () => {
		// Prior file: confirmed under old-org.
		saveDiskCredentials(
			{
				token: tokenForOrg("old"),
				orgId: "old",
				orgName: "Old",
				userName: "alice",
				workspaceId: "backend",
				tenancyConfirmedAt: "2026-06-01T00:00:00.000Z",
				savedAt: "",
			},
			dir,
			clock(),
		);
		const issuer = createFakeTokenIssuer({ reMint: { new: minted("new", { workspace: "frontend" }) } });
		const res = await healOrgDrift({ issuer, activeOrg: "new", dir, clock: clock() });
		expect(res.kind).toBe("healed");
		const raw = readRaw(dir);
		expect(raw.orgId).toBe("new");
		expect(raw.tenancyConfirmedAt).toBeUndefined();
		expect(raw.tenancyPending).toBe(true);
	});
});

describe("W2-AC-4 the switcher paths keep preserving tenancy fields (saveDiskCredentials writes verbatim)", () => {
	it("saveDiskCredentials writes tenancyConfirmedAt exactly as given (explicit tenancy control)", () => {
		saveDiskCredentials(
			{
				token: tokenForOrg("acme"),
				orgId: "acme",
				workspaceId: "backend",
				tenancyConfirmedAt: "2026-06-01T00:00:00.000Z",
				savedAt: "",
			},
			dir,
			clock(),
		);
		expect(readRaw(dir).tenancyConfirmedAt).toBe("2026-06-01T00:00:00.000Z");
	});

	it("a `...disk` spread rewrite (the workspace-switch mechanic) keeps a confirmed tenancy", () => {
		// Seed a confirmed tenancy, then simulate `workspace switch`: spread the prior disk record and
		// change ONLY the workspace — the confirm marker must survive (scope-switch-api's `...disk` posture).
		const seeded = saveDiskCredentials(
			{
				token: tokenForOrg("acme"),
				orgId: "acme",
				workspaceId: "backend",
				tenancyConfirmedAt: "2026-06-01T00:00:00.000Z",
				savedAt: "",
			},
			dir,
			clock(),
		);
		saveDiskCredentials({ ...seeded, workspaceId: "frontend", savedAt: "" }, dir, clock());
		const raw = readRaw(dir);
		expect(raw.workspaceId).toBe("frontend");
		expect(raw.tenancyConfirmedAt).toBe("2026-06-01T00:00:00.000Z");
	});
});
