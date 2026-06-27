/**
 * Tests for the needs-attention store (PRD-064g).
 *
 * AC coverage:
 *   AC-064g.1 -- ladder-exhaust escalation -> structured needs-attention persisted
 *                (file + incident)
 *   AC-064g.2 -- after recovery, the read-seam file exposes the most recent report
 *                (assert file shape; live dashboard render is BLOCKED: the dashboard
 *                reads this file only when the daemon is running, which is out of
 *                scope for unit tests -- see BLOCKER note below)
 *   AC-064g.5 -- resolved escalation marked resolved (banner-clear semantics)
 *
 * BLOCKER (AC-064g.2): the live dashboard render of the needs-attention banner
 * depends on the daemon mounting a route that reads `needs-attention.json`. That
 * route has not been authored yet (it is a future task in the dashboard integration
 * wave). These tests assert the FILE SHAPE the dashboard will read, which is the
 * complete 064g contract on the HiveDoctor side.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createIncidentLog } from "../../src/incidents.js";
import { silentLogger } from "../../src/logger.js";
import type { EscalationRecord } from "../../src/rungs/escalation.js";
import {
	createNeedsAttentionStore,
	type NeedsAttentionFile,
} from "../../src/escalation/needs-attention-store.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

let dir: string;
let clockMs = 1_000;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hd-na-store-"));
	clockMs = 1_000;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function makeEscalation(overrides: Partial<EscalationRecord> = {}): EscalationRecord {
	return {
		diagnosis: "Ladder exhausted after 3 consecutive failed restarts.",
		steps: [
			{ rung: 1, action: "restart-daemon", outcome: "failed", at: "2026-01-01T00:00:01.000Z" },
			{ rung: 1, action: "restart-daemon", outcome: "failed", at: "2026-01-01T00:00:02.000Z" },
			{ rung: 1, action: "restart-daemon", outcome: "failed", at: "2026-01-01T00:00:03.000Z" },
		],
		recommendedAction: "reinstall-primary",
		at: "2026-01-01T00:00:03.000Z",
		...overrides,
	};
}

function makeStore(clockFn?: () => number) {
	const incidentLog = createIncidentLog({
		workspaceDir: dir,
		logger: silentLogger,
		now: clockFn ?? (() => clockMs),
	});
	return createNeedsAttentionStore({
		workspaceDir: dir,
		incidentLog,
		logger: silentLogger,
		now: clockFn ?? (() => clockMs),
	});
}

// ── AC-064g.1: ladder-exhaust escalation -> structured needs-attention persisted ──

describe("AC-064g.1: record() persists needs-attention.json + incident", () => {
	it("writes needs-attention.json with the correct shape on first record", () => {
		const store = makeStore();
		const escalation = makeEscalation();
		store.record(escalation);

		const filePath = join(dir, "needs-attention.json");
		const raw = readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw) as NeedsAttentionFile;

		expect(parsed.version).toBe(1);
		expect(parsed.resolved).toBe(false);
		expect(parsed.escalation.diagnosis).toBe(escalation.diagnosis);
		expect(parsed.escalation.recommendedAction).toBe("reinstall-primary");
		expect(parsed.escalation.steps).toHaveLength(3);
		expect(typeof parsed.recordedAt).toBe("string");
		expect(parsed.resolvedAt).toBeUndefined();
	});

	it("writes the recommended action and steps into the file", () => {
		const store = makeStore();
		const escalation = makeEscalation({
			recommendedAction: "clear-credentials",
			wouldHaveTaken: "would clear ~/.deeplake/credentials.json (DEFERRED - not performed in v1)",
		});
		store.record(escalation);

		const filePath = join(dir, "needs-attention.json");
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as NeedsAttentionFile;

		expect(parsed.escalation.recommendedAction).toBe("clear-credentials");
		expect(parsed.escalation.wouldHaveTaken).toContain("credentials.json");
	});

	it("appends a synthetic escalation step to incidents.ndjson", () => {
		const store = makeStore();
		store.record(makeEscalation());

		const raw = readFileSync(join(dir, "incidents.ndjson"), "utf8");
		const lines = raw.trim().split("\n").filter(Boolean);
		expect(lines.length).toBeGreaterThanOrEqual(1);

		// The last line should contain the escalation step.
		const incident = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
		const steps = incident["steps"] as Array<Record<string, unknown>>;
		const escalationStep = steps.find((s) => s["action"] === "escalate-needs-attention");
		expect(escalationStep).toBeDefined();
		expect(escalationStep?.["rung"]).toBe(4);
		expect(escalationStep?.["outcome"]).toBe("succeeded");
	});

	it("does not throw when the workspace is unwritable (defensive)", () => {
		const badIncidentLog = createIncidentLog({
			workspaceDir: "\0bad-path",
			logger: silentLogger,
		});
		const store = createNeedsAttentionStore({
			workspaceDir: "\0bad-path",
			incidentLog: badIncidentLog,
			logger: silentLogger,
		});
		expect(() => store.record(makeEscalation())).not.toThrow();
	});
});

// ── AC-064g.2: read-seam file exposes the most recent report after recovery ──

describe("AC-064g.2: read-seam file shape after escalation (dashboard integration BLOCKED)", () => {
	/**
	 * BLOCKER: The live dashboard render of the needs-attention banner requires a
	 * daemon route that reads this file. That route has not been authored yet and is
	 * a future task in the dashboard integration wave. These tests assert the FILE
	 * SHAPE the dashboard will read -- the full 064g contract from HiveDoctor's side.
	 */
	it("read() returns the escalation record with resolved:false before recovery", () => {
		const store = makeStore();
		const escalation = makeEscalation();
		store.record(escalation);

		const current = store.read();
		expect(current).not.toBeNull();
		expect(current?.version).toBe(1);
		expect(current?.resolved).toBe(false);
		expect(current?.escalation.diagnosis).toBe(escalation.diagnosis);
		expect(current?.resolvedAt).toBeUndefined();
	});

	it("read() returns null when no escalation has occurred", () => {
		const store = makeStore();
		expect(store.read()).toBeNull();
	});

	it("file is stable across multiple read() calls (idempotent read)", () => {
		const store = makeStore();
		store.record(makeEscalation());
		const first = store.read();
		const second = store.read();
		expect(first).toEqual(second);
	});

	it("second record() overwrites the file with the newer escalation", () => {
		const store = makeStore();
		store.record(makeEscalation({ diagnosis: "first escalation" }));
		clockMs = 2_000;
		store.record(makeEscalation({ diagnosis: "second escalation" }));

		const current = store.read();
		expect(current?.escalation.diagnosis).toBe("second escalation");
	});
});

// ── AC-064g.5: resolved escalation marked resolved (banner-clear semantics) ──

describe("AC-064g.5: resolve() marks the record resolved", () => {
	it("sets resolved:true and resolvedAt after resolve()", () => {
		const store = makeStore();
		store.record(makeEscalation());

		clockMs = 5_000;
		store.resolve();

		const current = store.read();
		expect(current?.resolved).toBe(true);
		expect(typeof current?.resolvedAt).toBe("string");
	});

	it("resolvedAt is after recordedAt", () => {
		const store = makeStore();
		store.record(makeEscalation());
		clockMs = 9_999;
		store.resolve();

		const current = store.read();
		expect(current).not.toBeNull();
		const recorded = new Date(current!.recordedAt).getTime();
		const resolved = new Date(current!.resolvedAt!).getTime();
		expect(resolved).toBeGreaterThanOrEqual(recorded);
	});

	it("resolve() is idempotent: a second call does not change resolvedAt", () => {
		const store = makeStore();
		store.record(makeEscalation());
		clockMs = 3_000;
		store.resolve();
		const afterFirst = store.read();

		clockMs = 9_000;
		store.resolve(); // second call -- should be a no-op
		const afterSecond = store.read();

		expect(afterFirst?.resolvedAt).toBe(afterSecond?.resolvedAt);
	});

	it("resolve() does not throw when no record exists (defensive)", () => {
		const store = makeStore();
		expect(() => store.resolve()).not.toThrow();
	});

	it("the file retains the original escalation data after resolve()", () => {
		const store = makeStore();
		const escalation = makeEscalation({ recommendedAction: "investigate" });
		store.record(escalation);
		store.resolve();

		const current = store.read();
		expect(current?.escalation.recommendedAction).toBe("investigate");
		expect(current?.escalation.diagnosis).toBe(escalation.diagnosis);
	});
});
