/**
 * PRD-072 index AC-3 / AC-072b.1.2 (QA Critical 2) — the telemetry SQLite legacy fallback and the
 * defeat of the mover-failure stranding trap.
 *
 * The audited sequence: boot 1's mover fails (for example the legacy `.sqlite` is still locked by a
 * lingering old daemon); the store then minted a fresh EMPTY database at the new path; boot 2's
 * retry saw the destination exists, skipped, and marked the family complete — stranding the legacy
 * history forever. The fix under test:
 *   (a) `resolveTelemetryDbPathForOpen` retries the move at open time and, when the move still
 *       fails, opens the LEGACY database (fallback read/write) instead of minting fresh;
 *   (b) the movers distinguish migrated-vs-minted: a destination with DIFFERING content reports
 *       `failed` (retryable, legacy retained), never a silent complete; byte-identical content is
 *       verified-equivalent and completes.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { moveFile, moveSqliteWithSiblings } from "../../../../src/daemon/runtime/state-migration/move.js";
import { runHoneycombStateMigration } from "../../../../src/daemon/runtime/state-migration/index.js";
import {
	fleetTelemetryDbPath,
	legacyFleetTelemetryDbPath,
	openFleetTelemetryStore,
	resolveTelemetryDbPathForOpen,
} from "../../../../src/daemon/runtime/telemetry/fleet-store.js";

let home: string;
const ENV = {} as NodeJS.ProcessEnv;
const PLATFORM: NodeJS.Platform = "linux";

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "hc-store-mig-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const opts = () => ({ home, env: ENV, platform: PLATFORM }) as const;
const storeOpts = () => ({ homeDir: home, env: ENV, platform: PLATFORM }) as const;

/** Seed a REAL populated sqlite database at the LEGACY path (create at new, relocate, verify). */
function seedLegacyDatabase(): void {
	const store = openFleetTelemetryStore(storeOpts());
	store.upsertStatus({ name: "honeycomb", bindingTime: "t0", lastSeen: "t0", health: "ok" });
	store.close();
	const newPath = fleetTelemetryDbPath(opts());
	const legacyPath = legacyFleetTelemetryDbPath(home);
	mkdirSync(join(legacyPath, ".."), { recursive: true });
	renameSync(newPath, legacyPath);
	// Relocate WAL/SHM siblings too so the legacy layout is a faithful pre-upgrade install.
	for (const suffix of ["-wal", "-shm"]) {
		if (existsSync(`${newPath}${suffix}`)) renameSync(`${newPath}${suffix}`, `${legacyPath}${suffix}`);
	}
	expect(existsSync(newPath)).toBe(false);
	expect(existsSync(legacyPath)).toBe(true);
}

describe("QA Critical 2a — the store open path never mints fresh over an unmigrated legacy DB", () => {
	it("AC-3 an unmigrated legacy database is moved at open time and its rows read back", () => {
		seedLegacyDatabase();
		// The store open (no prior mover run) retries the move itself and lands on the new path.
		const store = openFleetTelemetryStore(storeOpts());
		expect(store.readStatus()?.health).toBe("ok");
		store.close();
		expect(existsSync(fleetTelemetryDbPath(opts()))).toBe(true);
		expect(existsSync(legacyFleetTelemetryDbPath(home))).toBe(false);
	});

	it("AC-3 when the move CANNOT land, the store opens the LEGACY database (fallback, no fresh mint)", () => {
		seedLegacyDatabase();
		// Block the new telemetry DIRECTORY with a file so the open-time move retry fails. (Seeding
		// left the empty dir behind after relocating the db; replace it with the blocking file.)
		const newDir = join(fleetTelemetryDbPath(opts()), "..");
		rmSync(newDir, { recursive: true, force: true });
		mkdirSync(join(newDir, ".."), { recursive: true });
		writeFileSync(newDir, "");

		expect(resolveTelemetryDbPathForOpen(opts())).toBe(legacyFleetTelemetryDbPath(home));
		const store = openFleetTelemetryStore(storeOpts());
		// The seeded history is READ, not stranded behind a fresh empty database.
		expect(store.readStatus()?.health).toBe("ok");
		store.upsertStatus({ name: "honeycomb", bindingTime: "t0", lastSeen: "t1", health: "ok" });
		store.close();
		// Nothing was minted at the (blocked) new path; the legacy file kept the writes.
		expect(existsSync(fleetTelemetryDbPath(opts()))).toBe(false);

		// The audited sequence's NEXT boot: the blocker is gone, the mover retry succeeds, and the
		// full history (including the fallback-era write) lands at the new path.
		rmSync(newDir, { force: true });
		const report = runHoneycombStateMigration({ home, env: ENV, platform: PLATFORM });
		expect(report.outcomes["telemetry-sqlite"]).toBe("migrated");
		const reopened = openFleetTelemetryStore(storeOpts());
		expect(reopened.readStatus()?.lastSeen).toBe("t1");
		reopened.close();
		expect(existsSync(legacyFleetTelemetryDbPath(home))).toBe(false);
	});
});

describe("QA Critical 2b — migrated-vs-minted: a minted destination never self-marks complete", () => {
	it("AC-072a.3.3 a fresh-minted new DB beside an unmigrated legacy DB keeps the family failed", () => {
		seedLegacyDatabase();
		// Emulate the pre-fix damage DIRECTLY: a fresh database minted at the new path (differing
		// content) while the legacy database still holds the history. (The fixed store can no longer
		// produce this state itself; the file stands in for one minted by a pre-fix build.)
		mkdirSync(join(fleetTelemetryDbPath(opts()), ".."), { recursive: true });
		writeFileSync(fleetTelemetryDbPath(opts()), "FRESH-MINTED-DIFFERENT-BYTES");

		const report = runHoneycombStateMigration({ home, env: ENV, platform: PLATFORM });
		// NEVER complete: the family reports failed (retryable) and the legacy database is retained.
		expect(report.outcomes["telemetry-sqlite"]).toBe("failed");
		expect(existsSync(legacyFleetTelemetryDbPath(home))).toBe(true);

		// And it KEEPS retrying on later boots (the marker did not self-mark complete).
		const second = runHoneycombStateMigration({ home, env: ENV, platform: PLATFORM });
		expect(second.outcomes["telemetry-sqlite"]).toBe("failed");
	});

	it("moveFile treats a byte-identical destination as verified-equivalent (complete, legacy cleared)", () => {
		const legacy = join(home, "legacy.bin");
		const dest = join(home, "dest.bin");
		writeFileSync(legacy, "SAME-BYTES");
		writeFileSync(dest, "SAME-BYTES");
		expect(moveFile(legacy, dest)).toBe("migrated");
		expect(existsSync(legacy)).toBe(false);
		expect(readFileSync(dest, "utf8")).toBe("SAME-BYTES");
	});

	it("moveFile fails (legacy retained) when the destination carries DIFFERENT content", () => {
		const legacy = join(home, "legacy.bin");
		const dest = join(home, "dest.bin");
		writeFileSync(legacy, "LEGACY-HISTORY");
		writeFileSync(dest, "MINTED-FRESH");
		expect(moveFile(legacy, dest)).toBe("failed");
		expect(readFileSync(legacy, "utf8")).toBe("LEGACY-HISTORY");
		expect(readFileSync(dest, "utf8")).toBe("MINTED-FRESH");
	});

	it("moveSqliteWithSiblings reports failed on a minted destination and leaves the legacy DB intact", () => {
		seedLegacyDatabase();
		mkdirSync(join(fleetTelemetryDbPath(opts()), ".."), { recursive: true });
		writeFileSync(fleetTelemetryDbPath(opts()), "MINTED");
		expect(moveSqliteWithSiblings(legacyFleetTelemetryDbPath(home), fleetTelemetryDbPath(opts()))).toBe("failed");
		expect(existsSync(legacyFleetTelemetryDbPath(home))).toBe(true);
	});
});
