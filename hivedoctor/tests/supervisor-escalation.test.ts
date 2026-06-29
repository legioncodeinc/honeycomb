/**
 * Supervisor escalate-on-give-up test (PRD-064f wiring; PRD-064c rung 4).
 *
 * The prior wave's heal() advanced off rung 1 but never handed the episode to the
 * escalation hook when the higher rung also failed. This verifies the minimal wiring
 * added in 064f: once the ladder advances AND the higher rung genuinely fails, the
 * supervisor calls ladder.escalate() (the give-up hand-off), and the escalation step is
 * recorded in the incident. The escalation NEVER performs a deferred action.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createBackoff } from "../src/backoff.js";
import { createIncidentLog } from "../src/incidents.js";
import { silentLogger } from "../src/logger.js";
import {
	createRemediationLadder,
	createRestartRung,
	type EscalationHook,
	type Rung,
} from "../src/remediation.js";
import { createStateStore } from "../src/state.js";
import { createSupervisor } from "../src/supervisor.js";
import type { SupervisorClock } from "../src/supervisor.js";

function fixedClock(): SupervisorClock {
	return { now: () => 1_000, sleep: async () => undefined };
}

describe("supervisor escalate-on-give-up (PRD-064f wiring)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	function workspace(): string {
		const d = mkdtempSync(join(tmpdir(), "hivedoctor-escalate-"));
		dirs.push(d);
		return d;
	}

	it("calls the escalation hook when the advanced rung fails", async () => {
		const dir = workspace();
		const clock = fixedClock();
		const stateStore = createStateStore({ workspaceDir: dir, logger: silentLogger });
		const incidents = createIncidentLog({ workspaceDir: dir, logger: silentLogger, now: () => clock.now() });
		const backoff = createBackoff({ floorMs: 1_000, ceilingMs: 30_000, jitter: 0, random: () => 0.5 });

		// Pre-seed state so decide() immediately advances (failures >= threshold).
		stateStore.write({
			version: 1,
			lastKnownHealth: "unreachable",
			currentRung: 1,
			consecutiveRestartFailures: 3,
			backoffRung: 0,
			lastHealAt: null,
			lastRestartAt: null,
		});

		// A rung 2 that GENUINELY fails (not skipped) -> triggers the give-up escalation.
		const failingRung2: Rung = {
			rung: 2,
			name: "reinstall-primary",
			run: async () => ({ ok: false, action: "reinstall-primary", detail: "npm-failed" }),
		};
		const restartRung = createRestartRung({
			restart: async () => false,
			readDaemonPid: async () => null,
			isHealthy: async () => false,
			cooldownMs: 0,
			clock: { now: () => clock.now() },
			lastRestartAt: () => null,
			markRestarted: () => undefined,
		});

		const escalationHook = vi.fn<EscalationHook>(async () => undefined);
		const ladder = createRemediationLadder({
			rungs: [restartRung, failingRung2],
			restartGiveUpThreshold: 3,
			logger: silentLogger,
			escalationHook,
		});

		const supervisor = createSupervisor({
			probe: async () => ({ kind: "unreachable-refused", detail: "ECONNREFUSED" }),
			ladder,
			backoff,
			stateStore,
			incidents,
			logger: silentLogger,
			clock,
			probeIntervalMs: 30_000,
			startupGraceMs: 0,
		});

		await supervisor.tick();

		// The escalation hook was handed a record (the give-up hand-off fired).
		expect(escalationHook).toHaveBeenCalledTimes(1);
		const record = escalationHook.mock.calls[0]?.[0];
		expect(record?.recommendedAction).toBe("manual-intervention");
		// manual-intervention is NOT a deferred action -> no "would have taken" note.
		expect(record?.wouldHaveTaken).toBeUndefined();

		// The incident records BOTH the failed rung-2 step AND the escalation step.
		const raw = readFileSync(join(dir, "incidents.ndjson"), "utf8").trim();
		const incident = JSON.parse(raw) as { steps: Array<{ action: string; outcome: string }> };
		expect(incident.steps[0]).toMatchObject({ action: "reinstall-primary", outcome: "failed" });
		expect(incident.steps[1]).toMatchObject({ action: "escalate", outcome: "succeeded" });
	});

	it("does NOT escalate when the advanced rung succeeds", async () => {
		const dir = workspace();
		const clock = fixedClock();
		const stateStore = createStateStore({ workspaceDir: dir, logger: silentLogger });
		const incidents = createIncidentLog({ workspaceDir: dir, logger: silentLogger, now: () => clock.now() });
		const backoff = createBackoff({ floorMs: 1_000, ceilingMs: 30_000, jitter: 0, random: () => 0.5 });
		stateStore.write({
			version: 1,
			lastKnownHealth: "unreachable",
			currentRung: 1,
			consecutiveRestartFailures: 3,
			backoffRung: 0,
			lastHealAt: null,
			lastRestartAt: null,
		});

		const okRung2: Rung = {
			rung: 2,
			name: "reinstall-primary",
			run: async () => ({ ok: true, action: "reinstall-primary", detail: "verified" }),
		};
		const restartRung = createRestartRung({
			restart: async () => false,
			readDaemonPid: async () => null,
			isHealthy: async () => false,
			cooldownMs: 0,
			clock: { now: () => clock.now() },
			lastRestartAt: () => null,
			markRestarted: () => undefined,
		});
		const escalationHook = vi.fn<EscalationHook>(async () => undefined);
		const ladder = createRemediationLadder({
			rungs: [restartRung, okRung2],
			restartGiveUpThreshold: 3,
			logger: silentLogger,
			escalationHook,
		});
		const supervisor = createSupervisor({
			probe: async () => ({ kind: "unreachable-refused", detail: "ECONNREFUSED" }),
			ladder,
			backoff,
			stateStore,
			incidents,
			logger: silentLogger,
			clock,
			probeIntervalMs: 30_000,
			startupGraceMs: 0,
		});

		await supervisor.tick();
		// A successful advanced rung is not a give-up; no escalation.
		expect(escalationHook).not.toHaveBeenCalled();
	});
});
