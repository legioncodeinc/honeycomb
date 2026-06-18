/**
 * PRD-020a a-AC-4 — `status` runs healDriftedOrgToken (re-mints a matching org_id) + renders
 * connectivity + login + the D1–D5 health (consuming 020d's HealthCheck).
 *
 * The a-AC-4 load-bearing assertion: when the stored token's `org_id` claim drifts from the
 * active org, the drift heal re-mints a CORRECTED token whose `org_id` matches the active org.
 * This suite drives 020a's `status` through the `OrgDriftHealer` seam AND verifies the real 011b
 * `healOrgDrift` re-mints to the active org through a fake `TokenIssuer`.
 */

import { describe, expect, it } from "vitest";

import {
	type CommandDeps,
	healthSourceFromCheck,
	type OrgDriftHealer,
	runStatusCommand,
	type StatusDeps,
} from "../../src/commands/index.js";
import { createFakeDaemonClient } from "../../src/commands/index.js";
import { healOrgDrift } from "../../src/daemon/runtime/auth/device-flow.js";
import { saveCredentials } from "../../src/daemon/runtime/auth/credentials-store.js";
import { encodeStubToken, type MintedToken, type TokenIssuer } from "../../src/daemon/runtime/auth/contracts.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Encode the Wave-1 stub token shape (`hcmt.v1.<b64>`) carrying an `org` claim. */
function tok(org: string): string {
	return encodeStubToken({ org, workspace: "default", agentId: "a1" });
}

/** A fake TokenIssuer that re-mints a token bound to the requested org. */
function fakeIssuer(): TokenIssuer {
	return {
		async requestDeviceCode() {
			return { deviceCode: "d", userCode: "U", verificationUri: "https://x", interval: 0 };
		},
		async pollToken(): Promise<MintedToken | "pending"> {
			return { token: tok("unused"), claims: { org: "unused" } };
		},
		async reMint(org: string): Promise<MintedToken> {
			// The corrected token carries the ACTIVE org in BOTH its token claim and structured claims.
			return { token: tok(org), claims: { org, workspace: "default", agentId: "a1" } };
		},
	};
}

describe("PRD-020a a-AC-4 — status heals a drifted org token and surfaces D1–D5 health", () => {
	it("a-AC-4 healDriftedOrgToken re-mints a token whose org_id claim matches the active org", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hc-status-"));
		try {
			// Seed a credential whose token is bound to the OLD org (drift).
			saveCredentials(
				{ token: tok("old-org"), orgId: "old-org", orgName: "old-org", workspace: "default", agentId: "a1", savedAt: "" },
				dir,
			);
			const result = await healOrgDrift({ issuer: fakeIssuer(), activeOrg: "active-org", dir, warner: { warn: () => {} } });
			expect(result.kind).toBe("healed");
			if (result.kind === "healed") {
				expect(result.from).toBe("old-org");
				expect(result.to).toBe("active-org");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a-AC-4 status runs the drift heal (best-effort) and renders connectivity + login + health", async () => {
		const lines: string[] = [];
		const healer: OrgDriftHealer = { async heal() { return { kind: "healed", to: "active-org" }; } };
		const health = healthSourceFromCheck({
			async evaluate() {
				return {
					dimensions: [
						{ id: "D1", label: "honeycomb CLI installed", ok: true, wirable: false },
						{ id: "D2", label: "daemon reachable (3850)", ok: false, detail: "refused", wirable: false },
					],
				};
			},
		});
		const base: CommandDeps = { daemon: createFakeDaemonClient({ alive: true }), out: (l) => lines.push(l) };
		const deps: StatusDeps = { ...base, drift: healer, health, loggedIn: true };
		const res = await runStatusCommand(deps);
		expect(res.exitCode).toBe(0);
		const out = lines.join("\n");
		expect(out).toMatch(/re-minted an org-aligned token \(org active-org\)/);
		expect(out).toMatch(/daemon:\s+up/);
		expect(out).toMatch(/login:\s+logged in/);
		expect(out).toMatch(/D1 ok/);
		expect(out).toMatch(/D2 FAIL/);
	});

	it("a-AC-4 a drift heal never crashes status (best-effort) — a healer that reports heal-failed is tolerated", async () => {
		const lines: string[] = [];
		const healer: OrgDriftHealer = { async heal() { return { kind: "heal-failed" }; } };
		const deps: StatusDeps = { daemon: createFakeDaemonClient({ alive: false }), drift: healer, loggedIn: false, out: (l) => lines.push(l) };
		const res = await runStatusCommand(deps);
		expect(res.exitCode).toBe(0);
		expect(lines.join("\n")).toMatch(/daemon:\s+down/);
	});
});
