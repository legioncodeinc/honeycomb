/** Incident log tests (episode model + defensive append + rotation + trigger mapping). */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HealthClassification } from "../src/health-probe.js";
import { createIncidentLog, triggerForClassification } from "../src/incidents.js";
import { silentLogger } from "../src/logger.js";

let dir: string;
let clock = 0;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hivedoctor-inc-"));
	clock = 1_000;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const refused: HealthClassification = { kind: "unreachable-refused", detail: "ECONNREFUSED" };
const degraded: HealthClassification = { kind: "degraded", reasons: { schema: "missing_table" } };

describe("incident log", () => {
	it("builds and writes a full episode as one NDJSON line", () => {
		const log = createIncidentLog({ workspaceDir: dir, logger: silentLogger, now: () => clock });
		const incident = log.open("unreachable", refused);
		incident.addStep({ rung: 1, action: "restart-daemon", outcome: "succeeded" });
		incident.markResolved();
		log.write(incident.build());

		const lines = readFileSync(join(dir, "incidents.ndjson"), "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0] as string);
		expect(parsed.trigger).toBe("unreachable");
		expect(parsed.healthKind).toBe("unreachable-refused");
		expect(parsed.steps[0]).toMatchObject({ action: "restart-daemon", outcome: "succeeded" });
		expect(parsed.resolved).toBe(true);
		expect(typeof parsed.id).toBe("string");
	});

	it("captures the per-subsystem reasons for a degraded episode", () => {
		const log = createIncidentLog({ workspaceDir: dir, logger: silentLogger, now: () => clock });
		const incident = log.open("degraded", degraded);
		log.write(incident.build());
		const parsed = JSON.parse(readFileSync(join(dir, "incidents.ndjson"), "utf8").trim());
		expect(parsed.healthReasons.schema).toBe("missing_table");
	});

	it("rotates the file to incidents.ndjson.1 once it exceeds the size cap", () => {
		const log = createIncidentLog({ workspaceDir: dir, logger: silentLogger, now: () => clock, maxBytes: 200 });
		// Write enough episodes to cross the tiny cap.
		for (let i = 0; i < 20; i++) {
			const incident = log.open("unreachable", refused);
			incident.addStep({ rung: 1, action: "restart-daemon", outcome: "failed", detail: "padding-".repeat(5) });
			log.write(incident.build());
		}
		expect(statSync(join(dir, "incidents.ndjson.1")).isFile()).toBe(true);
	});

	it("does not throw when the workspace dir is unwritable (defensive)", () => {
		// A path containing a NUL byte reliably fails mkdir/append on every platform, exercising
		// the swallow-and-log branch. The write must NOT throw (design principle 1).
		const log = createIncidentLog({ workspaceDir: "\0invalid-path", logger: silentLogger, now: () => clock });
		const incident = log.open("unreachable", refused);
		expect(() => log.write(incident.build())).not.toThrow();
	});
});

describe("triggerForClassification", () => {
	it("maps each classification kind to its trigger", () => {
		expect(triggerForClassification("unreachable-refused")).toBe("unreachable");
		expect(triggerForClassification("unreachable-timeout")).toBe("timeout");
		expect(triggerForClassification("degraded")).toBe("degraded");
		expect(triggerForClassification("ok")).toBe("unknown");
	});
});
