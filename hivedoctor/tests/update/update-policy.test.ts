/**
 * The auto-update gate decision (PRD-064e AC-064e.1 / .2 / .4). Pure decision logic --
 * no seams. This is where the blessed gate, the opt-out, and the pin are proven in
 * isolation; the engine test then proves the transaction that hangs off a go decision.
 */

import { describe, expect, it } from "vitest";

import type { BlessedFetchResult } from "../../src/update/blessed-channel.js";
import { decideUpdate, type UpdateOptOut } from "../../src/update/update-policy.js";

const blessed = (version: string, minVersion?: string): BlessedFetchResult => ({
	ok: true,
	manifest: minVersion !== undefined ? { version, minVersion } : { version },
});
const blessedFailed: BlessedFetchResult = { ok: false, reason: "unreachable" };
const ON: UpdateOptOut = { autoUpdateDisabled: false };

describe("decideUpdate go path (AC-064e.1)", () => {
	it("updates to the blessed version when @latest === blessed and blessed is newer", () => {
		const d = decideUpdate({
			installedVersion: "0.1.7",
			latestVersion: "0.1.9",
			blessed: blessed("0.1.9"),
			optOut: ON,
		});
		expect(d).toEqual({ update: true, toVersion: "0.1.9" });
	});

	it("targets the exact blessed string even when latest equals blessed with build metadata", () => {
		const d = decideUpdate({
			installedVersion: "0.1.7",
			latestVersion: "0.1.9+abc",
			blessed: blessed("0.1.9"),
			optOut: ON,
		});
		expect(d).toEqual({ update: true, toVersion: "0.1.9" });
	});
});

describe("decideUpdate gate holds (AC-064e.2)", () => {
	it("does NOT update when @latest is newer but NOT blessed", () => {
		// latest leapt to 0.2.0 but the blessed channel still points at 0.1.9.
		const d = decideUpdate({
			installedVersion: "0.1.7",
			latestVersion: "0.2.0",
			blessed: blessed("0.1.9"),
			optOut: ON,
		});
		expect(d).toEqual({ update: false, reason: "latest_not_blessed" });
	});

	it("fails closed when the blessed channel is unreachable/unparseable", () => {
		const d = decideUpdate({
			installedVersion: "0.1.7",
			latestVersion: "0.1.9",
			blessed: blessedFailed,
			optOut: ON,
		});
		expect(d).toEqual({ update: false, reason: "blessed_unavailable" });
	});

	it("does not update when @latest is unknown this tick", () => {
		const d = decideUpdate({
			installedVersion: "0.1.7",
			latestVersion: null,
			blessed: blessed("0.1.9"),
			optOut: ON,
		});
		expect(d).toEqual({ update: false, reason: "latest_unknown" });
	});

	it("does not update when the blessed version is already installed", () => {
		const d = decideUpdate({
			installedVersion: "0.1.9",
			latestVersion: "0.1.9",
			blessed: blessed("0.1.9"),
			optOut: ON,
		});
		expect(d).toEqual({ update: false, reason: "already_current" });
	});

	it("does not update when installed is below the blessed minVersion floor", () => {
		const d = decideUpdate({
			installedVersion: "0.1.2",
			latestVersion: "0.1.9",
			blessed: blessed("0.1.9", "0.1.5"),
			optOut: ON,
		});
		expect(d).toEqual({ update: false, reason: "below_min_version" });
	});
});

describe("decideUpdate opt-out + pin (AC-064e.4)", () => {
	it("does not update when auto-update is disabled", () => {
		const d = decideUpdate({
			installedVersion: "0.1.7",
			latestVersion: "0.1.9",
			blessed: blessed("0.1.9"),
			optOut: { autoUpdateDisabled: true },
		});
		expect(d).toEqual({ update: false, reason: "opted_out" });
	});

	it("does not update when a version is pinned (forward updates disabled)", () => {
		const d = decideUpdate({
			installedVersion: "0.1.7",
			latestVersion: "0.1.9",
			blessed: blessed("0.1.9"),
			optOut: { autoUpdateDisabled: false, pinnedVersion: "0.1.7" },
		});
		expect(d).toEqual({ update: false, reason: "pinned" });
	});

	it("opt-out takes precedence over every version signal", () => {
		// Even with a perfect go signal, disabled wins.
		const d = decideUpdate({
			installedVersion: "0.1.0",
			latestVersion: "9.9.9",
			blessed: blessed("9.9.9"),
			optOut: { autoUpdateDisabled: true },
		});
		expect(d.update).toBe(false);
	});
});
