/**
 * PRD-072 index test plan — the packaged-upgrade sequence, in-repo (QA Warning 4).
 *
 * The index calls for an integration smoke mirroring `scripts/local-queue-packaged-upgrade-smoke.mjs`
 * (install the OLD build from a tarball, start it, upgrade in place, confirm no double-start, stop,
 * reboot the new build, verify the state layout). A full packaged smoke needs an installable OLD
 * build that predates this PRD, which the repo cannot produce in this cycle (the previous release
 * is not vendored). This suite therefore drives the SAME end-to-end sequence in-process against a
 * temp HOME, using the exact primitives the upgraded daemon boot calls in the exact order
 * (`acquireSingleInstanceLock` with the legacy dir, `runHoneycombStateMigration`,
 * `releaseSingleInstanceLock`):
 *
 *   1. an "old install" is seeded: populated `~/.honeycomb/` families + a LIVE legacy daemon lock;
 *   2. the upgraded boot REFUSES while the old daemon runs (no double-start / double-bind);
 *   3. the old daemon stops (legacy lock released);
 *   4. the upgraded boot acquires the new lock, migrates, and the state lands under
 *      `~/.apiary/honeycomb/` — migrated legacy files are GONE, unmigrated ones REMAIN;
 *   5. shutdown releases both paths.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	acquireSingleInstanceLock,
	DaemonAlreadyRunningError,
	LOCK_FILE_NAME,
	PID_FILE_NAME,
	releaseSingleInstanceLock,
} from "../../../../src/daemon/runtime/assemble.js";
import { runHoneycombStateMigration } from "../../../../src/daemon/runtime/state-migration/index.js";

let home: string;
const ENV = {} as NodeJS.ProcessEnv;
const PLATFORM: NodeJS.Platform = "linux";

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "hc-upgrade-seq-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const legacyDir = () => join(home, ".honeycomb");
const newDir = () => join(home, ".apiary", "honeycomb");

function write(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

/** Seed the "old install": populated legacy families + a graphs cache that deliberately never moves. */
function seedOldInstall(): void {
	write(join(legacyDir(), "registry.json"), '[{"honeycombId":"skill--ada"}]');
	write(join(legacyDir(), "graph-ignore.json"), '{"ignore":["vendor/"]}');
	write(join(legacyDir(), ".machine-key"), "a".repeat(64));
	write(join(legacyDir(), "telemetry", "honeycomb.sqlite"), "SQLITE-BYTES");
	write(join(legacyDir(), "graphs", "repo", "snapshots", "s.json"), "{}");
}

describe("PRD-072 index test plan — the in-place upgrade sequence (in-repo integration)", () => {
	it("AC-4 / AC-2 / AC-9: refuse while the old daemon runs, then migrate cleanly on the next boot", () => {
		// 1. The old install, with the OLD daemon still RUNNING (a live pid in the legacy lock).
		seedOldInstall();
		write(join(legacyDir(), LOCK_FILE_NAME), String(process.pid));
		write(join(legacyDir(), PID_FILE_NAME), String(process.pid));

		// 2. The upgraded build boots: it must REFUSE (no double-start, no double-bind of 3850).
		expect(() => acquireSingleInstanceLock(newDir(), { legacyDir: legacyDir() })).toThrow(DaemonAlreadyRunningError);
		expect(existsSync(join(newDir(), LOCK_FILE_NAME))).toBe(false);

		// 3. The old daemon stops (its shutdown removes the legacy lock + pid).
		rmSync(join(legacyDir(), LOCK_FILE_NAME), { force: true });
		rmSync(join(legacyDir(), PID_FILE_NAME), { force: true });

		// 4. The upgraded boot sequence: acquire the new lock (window-open: dual-stamp), then migrate
		//    (the same order `assembleDaemon`'s start path runs them for the real assembly).
		const { lockPath } = acquireSingleInstanceLock(newDir(), { legacyDir: legacyDir() });
		expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
		// The window dual-stamp: the legacy pid resolves the live process for an old doctor.
		expect(readFileSync(join(legacyDir(), PID_FILE_NAME), "utf8")).toBe(String(process.pid));

		const report = runHoneycombStateMigration({ home, env: ENV, platform: PLATFORM });
		expect(report.outcomes["asset-registry"]).toBe("migrated");
		expect(report.outcomes["graph-ignore"]).toBe("migrated");
		expect(report.outcomes["machine-key"]).toBe("migrated");
		expect(report.outcomes["telemetry-sqlite"]).toBe("migrated");

		// State landed under the new root; migrated legacy files are gone.
		expect(readFileSync(join(newDir(), "registry.json"), "utf8")).toBe('[{"honeycombId":"skill--ada"}]');
		expect(readFileSync(join(newDir(), ".machine-key"), "utf8")).toBe("a".repeat(64));
		expect(readFileSync(join(newDir(), "telemetry", "honeycomb.sqlite"), "utf8")).toBe("SQLITE-BYTES");
		expect(existsSync(join(legacyDir(), "registry.json"))).toBe(false);
		expect(existsSync(join(legacyDir(), ".machine-key"))).toBe(false);
		// Unmigrated legacy files REMAIN: the regenerable graphs cache is deliberately never moved.
		expect(existsSync(join(legacyDir(), "graphs", "repo", "snapshots", "s.json"))).toBe(true);

		// A second boot performs no further migration work (idempotent, AC-2).
		const second = runHoneycombStateMigration({ home, env: ENV, platform: PLATFORM });
		for (const outcome of Object.values(second.outcomes)) expect(outcome).toBe("already");

		// 5. Shutdown releases BOTH paths (AC-072a.2.4).
		releaseSingleInstanceLock(newDir(), { legacyDir: legacyDir() });
		expect(existsSync(join(newDir(), LOCK_FILE_NAME))).toBe(false);
		expect(existsSync(join(legacyDir(), PID_FILE_NAME))).toBe(false);
	});

	it("AC-3: a family whose destination was minted by a pre-fix build stays failed and retained", () => {
		seedOldInstall();
		// A conflicting minted file at the new path (differing content) for one family.
		write(join(newDir(), "graph-ignore.json"), '{"ignore":["minted/"]}');

		const report = runHoneycombStateMigration({ home, env: ENV, platform: PLATFORM });
		// That family stays failed + retained; every OTHER family migrates unaffected.
		expect(report.outcomes["graph-ignore"]).toBe("failed");
		expect(readFileSync(join(legacyDir(), "graph-ignore.json"), "utf8")).toBe('{"ignore":["vendor/"]}');
		expect(report.outcomes["asset-registry"]).toBe("migrated");
		expect(report.outcomes["machine-key"]).toBe("migrated");
	});
});
