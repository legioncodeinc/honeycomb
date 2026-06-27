/**
 * Ladder-integration tests for the 064c rungs: the registry runs the real rung 2 + 3,
 * each rung's before/after state is recorded into incidents.ndjson (AC-064c.6), and the
 * ladder's terminal escalate() hand-off is crash-safe.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createIncidentLog } from "../src/incidents.js";
import { createInstallLock } from "../src/install-lock.js";
import { silentLogger } from "../src/logger.js";
import { buildEscalationRecord, createRemediationLadder, type RungContext } from "../src/remediation.js";
import { createReinstallRung } from "../src/rungs/reinstall.js";
import { createUninstallHivemindRung } from "../src/rungs/uninstall-hivemind.js";
import { createFakeRunner } from "./helpers/fake-runner.js";

const ctx: RungContext = { classification: { kind: "unreachable-refused", detail: "x" }, logger: silentLogger };
const BLESSED = "0.1.9";

let dir: string;
let clock = 0;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hivedoctor-064c-"));
	clock = 1_700_000_000_000;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Read back the single incident line written. */
function readIncident(): { steps: Array<{ rung: number; action: string; outcome: string; detail?: string }> } {
	const raw = readFileSync(join(dir, "incidents.ndjson"), "utf8").trim();
	return JSON.parse(raw);
}

describe("ladder runs the 064c rungs + records before/after into incidents.ndjson (AC-064c.6)", () => {
	it("rung 2 reinstall: the incident step captures the verified outcome", async () => {
		const runner = createFakeRunner();
		const versions = ["0.1.7-stale", BLESSED];
		const reinstall = createReinstallRung({
			runner,
			installLock: createInstallLock({ workspaceDir: dir, logger: silentLogger }),
			blessedVersion: BLESSED,
			readInstalledVersion: async () => versions.shift() ?? BLESSED,
		});
		const ladder = createRemediationLadder({ rungs: [reinstall], restartGiveUpThreshold: 3, logger: silentLogger });
		const incidents = createIncidentLog({ workspaceDir: dir, logger: silentLogger, now: () => clock });

		const incident = incidents.open("unreachable", ctx.classification);
		const result = await ladder.run(2, ctx);
		incident.addStep({
			rung: 2,
			action: result.action,
			outcome: result.skipped === true ? "skipped" : result.ok ? "succeeded" : "failed",
			detail: result.detail,
		});
		incidents.write(incident.build());

		const step = readIncident().steps[0];
		expect(step).toMatchObject({ rung: 2, action: "reinstall-primary", outcome: "succeeded" });
		expect(step?.detail).toBe(`verified-${BLESSED}`);
	});

	it("rung 3 uninstall: the incident step captures the removed-version outcome", async () => {
		const runner = createFakeRunner();
		const uninstall = createUninstallHivemindRung({
			runner,
			detectHivemind: async () => "0.7.3",
			workspaceDir: dir,
			now: () => clock,
		});
		const ladder = createRemediationLadder({ rungs: [uninstall], restartGiveUpThreshold: 3, logger: silentLogger });
		const incidents = createIncidentLog({ workspaceDir: dir, logger: silentLogger, now: () => clock });

		const incident = incidents.open("unreachable", ctx.classification);
		const result = await ladder.run(3, ctx);
		incident.addStep({
			rung: 3,
			action: result.action,
			outcome: result.skipped === true ? "skipped" : result.ok ? "succeeded" : "failed",
			detail: result.detail,
		});
		incidents.write(incident.build());

		const step = readIncident().steps[0];
		expect(step).toMatchObject({ rung: 3, action: "uninstall-conflicting-hivemind", outcome: "succeeded" });
		expect(step?.detail).toBe("removed-0.7.3");
	});
});

describe("ladder.escalate() terminal hand-off", () => {
	it("hands the record to the injected hook and returns a succeeded result", async () => {
		const hook = vi.fn(async () => {});
		const ladder = createRemediationLadder({
			rungs: [],
			restartGiveUpThreshold: 3,
			logger: silentLogger,
			escalationHook: hook,
		});
		const record = buildEscalationRecord({
			diagnosis: "ladder exhausted",
			steps: [],
			recommendedAction: "manual-intervention",
			now: () => clock,
		});
		const result = await ladder.escalate(record);
		expect(result.ok).toBe(true);
		expect(hook).toHaveBeenCalledWith(record);
	});

	it("returns a skipped 'no-escalation-hook' result when no hook was injected (Wave-0 callers)", async () => {
		const ladder = createRemediationLadder({ rungs: [], restartGiveUpThreshold: 3, logger: silentLogger });
		const record = buildEscalationRecord({ diagnosis: "x", steps: [], recommendedAction: "investigate" });
		const result = await ladder.escalate(record);
		expect(result.skipped).toBe(true);
		expect(result.detail).toBe("no-escalation-hook");
	});
});
