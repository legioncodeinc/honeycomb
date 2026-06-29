/**
 * Rung 2 (reinstall) + rung 3 (uninstall conflicting Hivemind) + escalation hand-off
 * tests (PRD-064c, AC-064c.1 .. AC-064c.5). Every npm-touching path runs through a fake
 * {@link createFakeRunner} - no test ever runs real npm.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInstallLock } from "../src/install-lock.js";
import { silentLogger } from "../src/logger.js";
import type { RungContext } from "../src/remediation.js";
import { buildEscalationRecord, runEscalation } from "../src/rungs/escalation.js";
import { createReinstallRung, PRIMARY_PACKAGE } from "../src/rungs/reinstall.js";
import {
	createNpmHivemindDetector,
	createUninstallHivemindRung,
	HIVEMIND_PACKAGE,
} from "../src/rungs/uninstall-hivemind.js";
import { createFakeRunner } from "./helpers/fake-runner.js";

const ctx: RungContext = { classification: { kind: "unreachable-refused", detail: "x" }, logger: silentLogger };
const BLESSED = "0.1.9";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hivedoctor-rungs-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A fresh install lock bound to the temp workspace. */
function lock() {
	return createInstallLock({ workspaceDir: dir, logger: silentLogger });
}

describe("rung 2 reinstall (AC-064c.1)", () => {
	it("reinstalls the primary and verifies the post-install version matches the blessed version", async () => {
		const runner = createFakeRunner();
		// Before: a stale version; after the install: the blessed version (stale-route symptom gone).
		const versions = ["0.1.7-stale", BLESSED];
		const readInstalledVersion = vi.fn(async () => versions.shift() ?? BLESSED);

		const rung = createReinstallRung({
			runner,
			installLock: lock(),
			blessedVersion: BLESSED,
			readInstalledVersion,
		});

		const result = await rung.run(ctx);

		expect(result.ok).toBe(true);
		expect(result.detail).toBe(`verified-${BLESSED}`);
		// It ran exactly `npm install -g @legioncodeinc/honeycomb`.
		expect(runner.calls).toEqual([{ command: "npm", args: ["install", "-g", PRIMARY_PACKAGE] }]);
		// Verified by re-reading the running version (before + after).
		expect(readInstalledVersion).toHaveBeenCalledTimes(2);
	});

	it("fails (not throws) when npm exits non-zero, and the ladder can proceed", async () => {
		const runner = createFakeRunner(() => ({ ok: false, code: 1, stdout: "", stderr: "EACCES", detail: "EACCES" }));
		const rung = createReinstallRung({
			runner,
			installLock: lock(),
			blessedVersion: BLESSED,
			readInstalledVersion: async () => "0.1.7-stale",
		});

		const result = await rung.run(ctx);
		expect(result.ok).toBe(false);
		expect(result.detail).toBe("EACCES");
	});

	it("reports unverified when the post-install version does not match the blessed version", async () => {
		const runner = createFakeRunner();
		const rung = createReinstallRung({
			runner,
			installLock: lock(),
			blessedVersion: BLESSED,
			readInstalledVersion: async () => "0.1.7-stale", // never becomes blessed
		});
		const result = await rung.run(ctx);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("unverified");
	});

	it("skips when the shared install lock is already held (no concurrent npm install)", async () => {
		const sharedLock = lock();
		// Simulate 064e's auto-update engine holding the lock.
		const held = sharedLock.acquire("auto-update");
		expect(held).not.toBeNull();

		const runner = createFakeRunner();
		const rung = createReinstallRung({
			runner,
			installLock: sharedLock,
			blessedVersion: BLESSED,
			readInstalledVersion: async () => "0.1.7-stale",
		});

		const result = await rung.run(ctx);
		expect(result.skipped).toBe(true);
		expect(result.detail).toBe("install-lock-held");
		// Crucially, npm was NOT invoked while the lock was held.
		expect(runner.calls).toHaveLength(0);
	});
});

describe("rung 2 reinstall blessed-channel threading + fail-soft (W-1)", () => {
	it("verifies against the version resolved from the live channel seam, not the static fallback", async () => {
		const runner = createFakeRunner();
		// The live channel blesses a different version than the static fallback; the rung must
		// verify against the LIVE one (proving the version is threaded through, not the "" default).
		const LIVE = "0.2.0";
		// Stale before the install, the live blessed version after (so the idempotency short-circuit
		// does not fire and the verify compares the post-install version to the LIVE channel value).
		const versions = ["0.1.7-stale", LIVE];
		const rung = createReinstallRung({
			runner,
			installLock: lock(),
			blessedVersion: "", // composition default before B-3 ships a static fallback
			resolveBlessedVersion: async () => LIVE,
			readInstalledVersion: async () => versions.shift() ?? LIVE,
		});

		const result = await rung.run(ctx);

		expect(result.ok).toBe(true);
		expect(result.detail).toBe(`verified-${LIVE}`);
		expect(runner.calls).toEqual([{ command: "npm", args: ["install", "-g", PRIMARY_PACKAGE] }]);
	});

	it("an empty/unreachable channel still lets the reinstall PROCEED (fail-soft, never blocks)", async () => {
		const runner = createFakeRunner();
		const rung = createReinstallRung({
			runner,
			installLock: lock(),
			blessedVersion: "", // no static fallback
			resolveBlessedVersion: async () => "", // channel unreachable/unparseable -> ""
			readInstalledVersion: async () => "0.1.8", // some running version; nothing to compare to
		});

		const result = await rung.run(ctx);

		// The reinstall ran and is reported a SUCCESS that simply could not be verified - not a
		// hard failure - so a missing blessed channel never blocks the repair (AC-064c.1 fail-soft).
		expect(result.ok).toBe(true);
		expect(result.detail).toBe("unverified-no-blessed");
		expect(runner.calls).toEqual([{ command: "npm", args: ["install", "-g", PRIMARY_PACKAGE] }]);
	});

	it("a throwing channel seam falls back to the static blessed version", async () => {
		const runner = createFakeRunner();
		const rung = createReinstallRung({
			runner,
			installLock: lock(),
			blessedVersion: BLESSED, // static fallback present
			resolveBlessedVersion: async () => {
				throw new Error("CDN down");
			},
			readInstalledVersion: (() => {
				// Stale before install, the static fallback after, so verify matches the fallback.
				const versions = ["0.1.7-stale", BLESSED];
				return async () => versions.shift() ?? BLESSED;
			})(),
		});

		const result = await rung.run(ctx);

		expect(result.ok).toBe(true);
		expect(result.detail).toBe(`verified-${BLESSED}`);
	});
});

describe("rung 2 reinstall idempotency (AC-064c.4)", () => {
	it("second run is a safe no-op when the running version already matches blessed", async () => {
		const runner = createFakeRunner();
		const rung = createReinstallRung({
			runner,
			installLock: lock(),
			blessedVersion: BLESSED,
			readInstalledVersion: async () => BLESSED, // already blessed
		});

		const first = await rung.run(ctx);
		const second = await rung.run(ctx);

		expect(first.skipped).toBe(true);
		expect(first.detail).toBe("already-blessed");
		expect(second.skipped).toBe(true);
		// npm was never touched on either run (idempotent short-circuit).
		expect(runner.calls).toHaveLength(0);
	});
});

describe("rung 3 uninstall conflicting Hivemind (AC-064c.2 / .5)", () => {
	it("removes the @deeplake/hivemind package and leaves ~/.deeplake/ untouched", async () => {
		const runner = createFakeRunner();
		const rung = createUninstallHivemindRung({
			runner,
			detectHivemind: async () => "0.7.3", // conflicting global present
			workspaceDir: dir,
			now: () => 1_700_000_000_000,
		});

		const result = await rung.run(ctx);

		expect(result.ok).toBe(true);
		expect(result.detail).toBe("removed-0.7.3");
		// It uninstalled the PACKAGE only.
		expect(runner.calls).toEqual([{ command: "npm", args: ["uninstall", "-g", HIVEMIND_PACKAGE] }]);
		// No npm command (and no fs write) ever names the shared ~/.deeplake/ state.
		const everyArg = runner.calls.flatMap((c) => c.args).join(" ");
		expect(everyArg).not.toContain(".deeplake");
		expect(everyArg).not.toContain("credentials");
	});

	it("writes a timestamped backup record BEFORE removal (AC-064c.5)", async () => {
		// The runner records the uninstall; assert the backup file already exists when it runs.
		let backupExistedAtUninstall = false;
		const backupPath = join(dir, "removed-packages.ndjson");
		const runner = createFakeRunner((command, args) => {
			if (args.includes("uninstall")) backupExistedAtUninstall = existsSync(backupPath);
			return { ok: true, code: 0, stdout: "", stderr: "" };
		});

		const rung = createUninstallHivemindRung({
			runner,
			detectHivemind: async () => "0.7.3",
			workspaceDir: dir,
			now: () => 1_700_000_000_000,
		});
		await rung.run(ctx);

		// The record existed at the moment the destructive uninstall ran.
		expect(backupExistedAtUninstall).toBe(true);
		const record = JSON.parse(readFileSync(backupPath, "utf8").trim());
		expect(record).toMatchObject({ package: HIVEMIND_PACKAGE, version: "0.7.3" });
		expect(typeof record.at).toBe("string");
	});
});

describe("rung 3 idempotency (AC-064c.4)", () => {
	it("no conflicting global -> safe no-op skip, no backup, no uninstall", async () => {
		const runner = createFakeRunner();
		const rung = createUninstallHivemindRung({
			runner,
			detectHivemind: async () => null, // nothing to remove
			workspaceDir: dir,
		});

		const result = await rung.run(ctx);
		expect(result.skipped).toBe(true);
		expect(result.detail).toBe("no-conflicting-hivemind");
		expect(runner.calls).toHaveLength(0);
		// No backup record was written for a no-op.
		expect(existsSync(join(dir, "removed-packages.ndjson"))).toBe(false);
	});

	it("second run after a removal detects nothing and skips (idempotent)", async () => {
		const runner = createFakeRunner();
		// First run: present; after that: absent (as a real uninstall would leave it).
		const detected = ["0.7.3"];
		const rung = createUninstallHivemindRung({
			runner,
			detectHivemind: async () => detected.shift() ?? null,
			workspaceDir: dir,
		});

		const first = await rung.run(ctx);
		const second = await rung.run(ctx);

		expect(first.ok).toBe(true);
		expect(second.skipped).toBe(true);
		expect(second.detail).toBe("no-conflicting-hivemind");
		// Only the first run issued an uninstall.
		expect(runner.calls.filter((c) => c.args.includes("uninstall"))).toHaveLength(1);
	});
});

describe("npm-based Hivemind detector", () => {
	it("parses the version from `npm ls -g` output on a clean exit", async () => {
		const runner = createFakeRunner(() => ({
			ok: true,
			code: 0,
			stdout: "/usr/lib\n`-- @deeplake/hivemind@0.7.3\n",
			stderr: "",
		}));
		const detect = createNpmHivemindDetector(runner);
		expect(await detect()).toBe("0.7.3");
	});

	it("returns null when `npm ls` exits non-zero (package absent)", async () => {
		const runner = createFakeRunner(() => ({ ok: false, code: 1, stdout: "", stderr: "(empty)", detail: "exit-1" }));
		const detect = createNpmHivemindDetector(runner);
		expect(await detect()).toBeNull();
	});
});

describe("escalation hand-off (AC-064c.3)", () => {
	it("a suspected credential fault escalates and records the deferred action WITHOUT purging", async () => {
		const delivered: unknown[] = [];
		const hook = vi.fn(async (record) => {
			delivered.push(record);
		});

		const record = buildEscalationRecord({
			diagnosis: "storage healthy but every request 401s - suspected credential fault",
			steps: [
				{ rung: 1, action: "restart-daemon", outcome: "failed", detail: "still-401", at: "2026-06-27T00:00:00.000Z" },
			],
			recommendedAction: "clear-credentials",
			now: () => 1_700_000_000_000,
		});

		const result = await runEscalation(record, hook, silentLogger);

		expect(result.ok).toBe(true);
		expect(hook).toHaveBeenCalledTimes(1);
		// The record names the deferred action it WOULD have taken, but nothing purged credentials.
		expect(record.recommendedAction).toBe("clear-credentials");
		expect(record.wouldHaveTaken).toContain("would clear");
		expect(record.wouldHaveTaken).toContain("credentials.json");
		expect(record.wouldHaveTaken).toContain("DEFERRED");
	});

	it("a non-deferred recommendation carries no wouldHaveTaken note", async () => {
		const record = buildEscalationRecord({
			diagnosis: "stale install, reinstall recommended",
			steps: [],
			recommendedAction: "reinstall-primary",
		});
		expect(record.wouldHaveTaken).toBeUndefined();
	});

	it("a throwing escalation hook becomes a failed result, never a thrown error", async () => {
		const record = buildEscalationRecord({ diagnosis: "x", steps: [], recommendedAction: "investigate" });
		const result = await runEscalation(
			record,
			() => {
				throw new Error("sink down");
			},
			silentLogger,
		);
		expect(result.ok).toBe(false);
		expect(result.detail).toBe("sink down");
	});
});
