/**
 * PRD-072a US-072a.3 — the migration bootstrap loop + marker (`state-migration/migrate.ts`).
 *
 * Drives the engine with FAKE movers so the loop / marker / idempotence / fail-soft logic is proven
 * without touching disk beyond a temp state dir. Covers AC-072a.3.1 (each family runs, marker records
 * outcomes), AC-072a.3.2 (a completed family is skipped next run), and AC-072a.3.3 (a thrown mover is
 * fail-soft, marked retryable, and the run still returns).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type FamilyOutcome,
	MIGRATION_MARKER_FILE,
	type StateFamilyMover,
	runStateMigration,
} from "../../../../src/daemon/runtime/state-migration/migrate.js";

let stateDir: string;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "hc-migrate-"));
});
afterEach(() => {
	rmSync(stateDir, { recursive: true, force: true });
});

function mover(family: string, outcome: FamilyOutcome, calls: string[]): StateFamilyMover {
	return {
		family,
		run(): FamilyOutcome {
			calls.push(family);
			return outcome;
		},
	};
}

function readMarker(): { families: Record<string, { status: string; at: string }> } {
	return JSON.parse(readFileSync(join(stateDir, MIGRATION_MARKER_FILE), "utf8"));
}

describe("PRD-072a AC-072a.3.1 — each family runs once and the marker records outcomes", () => {
	it("AC-072a.3.1 runs every registered mover and marks migrated/skipped families complete", () => {
		const calls: string[] = [];
		const report = runStateMigration({
			stateDir,
			movers: [mover("a", "migrated", calls), mover("b", "skipped", calls)],
			now: () => "2026-07-04T00:00:00.000Z",
		});
		expect(calls).toEqual(["a", "b"]);
		expect(report.outcomes).toEqual({ a: "migrated", b: "skipped" });
		const marker = readMarker();
		expect(marker.families.a?.status).toBe("complete");
		expect(marker.families.b?.status).toBe("complete");
	});
});

describe("PRD-072a AC-072a.3.2 — a completed family is skipped on a later boot (idempotent)", () => {
	it("AC-072a.3.2 the second run does not re-invoke a mover marked complete", () => {
		const first: string[] = [];
		runStateMigration({ stateDir, movers: [mover("a", "migrated", first)] });
		expect(first).toEqual(["a"]);

		const second: string[] = [];
		const report = runStateMigration({ stateDir, movers: [mover("a", "migrated", second)] });
		expect(second).toEqual([]); // never re-invoked
		expect(report.outcomes.a).toBe("already");
	});

	it("AC-072a.3.2 the fully-migrated fast path performs ZERO writes (Warning 3: cheap per CLI verb)", () => {
		runStateMigration({ stateDir, movers: [mover("a", "migrated", [])] });
		const markerBytes = readFileSync(join(stateDir, MIGRATION_MARKER_FILE), "utf8");

		// The engine runs on EVERY CLI verb + daemon boot; once all families are complete it must not
		// rewrite the marker (one read, no writes).
		let writes = 0;
		runStateMigration({
			stateDir,
			movers: [mover("a", "migrated", [])],
			fs: {
				readText: (path: string): string => readFileSync(path, "utf8"),
				writeText: (): void => {
					writes += 1;
				},
				mkdirp: (): void => {
					writes += 1;
				},
			},
		});
		expect(writes).toBe(0);
		expect(readFileSync(join(stateDir, MIGRATION_MARKER_FILE), "utf8")).toBe(markerBytes);
	});
});

describe("PRD-072a AC-072a.3.3 — a failed mover is fail-soft, retryable, and never blocks boot", () => {
	it("AC-072a.3.3 a mover that returns failed is marked failed and retried next boot", () => {
		const first: string[] = [];
		const report1 = runStateMigration({ stateDir, movers: [mover("a", "failed", first)] });
		expect(report1.outcomes.a).toBe("failed");
		expect(readMarker().families.a?.status).toBe("failed");

		// Next boot RETRIES a failed family (marker status !== complete).
		const second: string[] = [];
		runStateMigration({ stateDir, movers: [mover("a", "migrated", second)] });
		expect(second).toEqual(["a"]);
		expect(readMarker().families.a?.status).toBe("complete");
	});

	it("AC-072a.3.3 a mover that THROWS degrades to failed and the run still returns (no crash)", () => {
		const throwing: StateFamilyMover = {
			family: "boom",
			run(): FamilyOutcome {
				throw new Error("simulated copy error");
			},
		};
		const other: string[] = [];
		let report!: ReturnType<typeof runStateMigration>;
		expect(() => {
			report = runStateMigration({ stateDir, movers: [throwing, mover("ok", "migrated", other)] });
		}).not.toThrow();
		expect(report.outcomes.boom).toBe("failed");
		expect(report.outcomes.ok).toBe("migrated"); // a sibling failure never blocks other families
		expect(other).toEqual(["ok"]);
	});
});
