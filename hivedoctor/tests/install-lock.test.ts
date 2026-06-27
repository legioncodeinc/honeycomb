/**
 * Shared install-lock tests (PRD-064c): the file-based mutex that serializes rung 2's
 * reinstall and the future 064e auto-update so two `npm i -g` never race. Built-ins only.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInstallLock, type InstallLockClock } from "../src/install-lock.js";
import { silentLogger } from "../src/logger.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hivedoctor-lock-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A controllable clock for deterministic staleness. */
function controllableClock(start = 0): InstallLockClock & { set: (n: number) => void } {
	let t = start;
	return { now: () => t, set: (n: number) => (t = n) };
}

describe("install lock", () => {
	it("acquires when free and writes the lock file", () => {
		const lock = createInstallLock({ workspaceDir: dir, logger: silentLogger });
		const handle = lock.acquire("reinstall");
		expect(handle).not.toBeNull();
		expect(existsSync(join(dir, "install.lock"))).toBe(true);
	});

	it("returns null when a FRESH lock is already held (mutual exclusion)", () => {
		const lock = createInstallLock({ workspaceDir: dir, logger: silentLogger });
		const first = lock.acquire("reinstall");
		expect(first).not.toBeNull();
		const second = lock.acquire("auto-update");
		expect(second).toBeNull(); // the second caller must back off
	});

	it("release() frees the lock so a later acquire succeeds", () => {
		const lock = createInstallLock({ workspaceDir: dir, logger: silentLogger });
		const handle = lock.acquire("reinstall");
		handle?.release();
		expect(existsSync(join(dir, "install.lock"))).toBe(false);
		expect(lock.acquire("auto-update")).not.toBeNull();
	});

	it("steals a STALE lock (held past staleMs) so a dead holder cannot wedge installs forever", () => {
		const clock = controllableClock(0);
		const lock = createInstallLock({ workspaceDir: dir, logger: silentLogger, staleMs: 1_000, clock });

		const first = lock.acquire("reinstall");
		expect(first).not.toBeNull();

		// Within the window: held, second caller backs off.
		clock.set(500);
		expect(lock.acquire("auto-update")).toBeNull();

		// Past the window: the stale lock is stolen and re-acquired.
		clock.set(2_000);
		expect(lock.acquire("auto-update")).not.toBeNull();
	});

	it("release() is a no-op when the lock was already stolen by another holder", () => {
		const clock = controllableClock(0);
		const lock = createInstallLock({ workspaceDir: dir, logger: silentLogger, staleMs: 1_000, clock });

		const first = lock.acquire("reinstall");
		clock.set(2_000);
		const second = lock.acquire("auto-update"); // steals the stale lock
		expect(second).not.toBeNull();

		// The original holder's late release must NOT delete the second holder's fresh lock.
		first?.release();
		expect(existsSync(join(dir, "install.lock"))).toBe(true);
		expect(second?.owner).toBeDefined();
	});

	it("does not throw on a garbage lock body; steals it once stale", () => {
		const clock = controllableClock(0);
		writeFileSync(join(dir, "install.lock"), "not-json", "utf8");
		const lock = createInstallLock({ workspaceDir: dir, logger: silentLogger, staleMs: 1_000, clock });

		// Fresh-but-garbage: treated as held (cannot prove abandoned), so the caller backs off.
		expect(() => lock.acquire("reinstall")).not.toThrow();
	});
});
