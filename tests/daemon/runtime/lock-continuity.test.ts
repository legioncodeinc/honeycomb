/**
 * PRD-072a US-072a.2 + index AC-4 — the single-instance guard's upgrade-boot continuity.
 *
 * The guard checks the NEW lock, then the LEGACY lock, refusing on either live pid; a stale lock at
 * either path is reclaimed; while the window is open it dual-stamps the legacy pid file; and release
 * clears BOTH paths. Driven directly against two temp dirs (new + legacy) so no real `~` is touched.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	acquireSingleInstanceLock,
	DaemonAlreadyRunningError,
	LOCK_FILE_NAME,
	PID_FILE_NAME,
	releaseSingleInstanceLock,
} from "../../../src/daemon/runtime/assemble.js";

/** A pid that is certainly not alive (max 32-bit signed; never a running process). */
const DEAD_PID = 2 ** 31 - 1;

let newDir: string;
let legacyDir: string;

beforeEach(() => {
	newDir = mkdtempSync(join(tmpdir(), "hc-lock-new-"));
	legacyDir = mkdtempSync(join(tmpdir(), "hc-lock-legacy-"));
});
afterEach(() => {
	rmSync(newDir, { recursive: true, force: true });
	rmSync(legacyDir, { recursive: true, force: true });
});

describe("PRD-072a AC-072a.2.1 — a live NEW lock refuses a second start", () => {
	it("AC-072a.2.1 a second acquire against a held new lock throws DaemonAlreadyRunningError", () => {
		acquireSingleInstanceLock(newDir, { legacyDir });
		expect(() => acquireSingleInstanceLock(newDir, { legacyDir })).toThrow(DaemonAlreadyRunningError);
	});
});

describe("PRD-072a AC-072a.2.2 / index AC-4 — a live LEGACY lock refuses the upgraded start", () => {
	it("AC-072a.2.2 a live pid in the legacy lock (no new lock) throws naming the legacy pid", () => {
		// Simulate the previous-version daemon still running under the legacy lock.
		writeFileSync(join(legacyDir, LOCK_FILE_NAME), String(process.pid), "utf8");
		try {
			acquireSingleInstanceLock(newDir, { legacyDir });
			throw new Error("expected acquire to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(DaemonAlreadyRunningError);
			expect((err as DaemonAlreadyRunningError).existingPid).toBe(process.pid);
		}
		// The new lock was NOT acquired while the legacy daemon holds the port.
		expect(existsSync(join(newDir, LOCK_FILE_NAME))).toBe(false);
	});
});

describe("PRD-072a AC-072a.2.3 — stale locks are reclaimed and the legacy pid is dual-stamped", () => {
	it("AC-072a.2.3 stale locks at both paths are reclaimed; the new lock is acquired; legacy pid stamped", () => {
		writeFileSync(join(newDir, LOCK_FILE_NAME), String(DEAD_PID), "utf8");
		writeFileSync(join(legacyDir, LOCK_FILE_NAME), String(DEAD_PID), "utf8");

		const { lockPath, pidPath } = acquireSingleInstanceLock(newDir, { legacyDir });
		expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
		expect(readFileSync(pidPath, "utf8")).toBe(String(process.pid));
		// Dual-stamp: the legacy pid FILE carries the live pid so an old doctor / `cat` still resolves it.
		expect(readFileSync(join(legacyDir, PID_FILE_NAME), "utf8")).toBe(String(process.pid));
	});
});

describe("PRD-072a AC-072a.2.3 / index AC-1 — the dual-stamp is WINDOW-ONLY (QA Warning 2 resolution)", () => {
	it("AC-072a.2.3 an UPGRADE install (legacy dir exists) dual-stamps the legacy pid", () => {
		// The legacy dir existing (even empty) marks a mid-window upgrade install.
		const { pidPath } = acquireSingleInstanceLock(newDir, { legacyDir });
		expect(readFileSync(pidPath, "utf8")).toBe(String(process.pid));
		expect(readFileSync(join(legacyDir, PID_FILE_NAME), "utf8")).toBe(String(process.pid));
	});

	it("AC-1 a FRESH install (no legacy dir) NEVER creates ~/.honeycomb for the dual-stamp", () => {
		const absentLegacy = join(legacyDir, "never-created", ".honeycomb");
		expect(existsSync(absentLegacy)).toBe(false);

		const { lockPath } = acquireSingleInstanceLock(newDir, { legacyDir: absentLegacy });
		expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
		// Nothing honeycomb-owned appears under the (absent) legacy dir: not the dir, not the pid.
		expect(existsSync(absentLegacy)).toBe(false);

		// Release stays safe with the absent legacy dir (clears the new path; legacy is a no-op).
		releaseSingleInstanceLock(newDir, { legacyDir: absentLegacy });
		expect(existsSync(join(newDir, LOCK_FILE_NAME))).toBe(false);
	});
});

describe("PRD-072a AC-072a.2.4 — release clears pid + lock at BOTH paths", () => {
	it("AC-072a.2.4 release removes the lock and pid files under the new AND legacy dirs", () => {
		acquireSingleInstanceLock(newDir, { legacyDir });
		expect(existsSync(join(newDir, LOCK_FILE_NAME))).toBe(true);
		expect(existsSync(join(legacyDir, PID_FILE_NAME))).toBe(true);

		releaseSingleInstanceLock(newDir, { legacyDir });
		expect(existsSync(join(newDir, LOCK_FILE_NAME))).toBe(false);
		expect(existsSync(join(newDir, PID_FILE_NAME))).toBe(false);
		expect(existsSync(join(legacyDir, LOCK_FILE_NAME))).toBe(false);
		expect(existsSync(join(legacyDir, PID_FILE_NAME))).toBe(false);
	});
});
