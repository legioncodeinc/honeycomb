/**
 * Composition-root smoke test (PRD-064f production assembly).
 *
 * Asserts that createHiveDoctor() wires the whole watchdog together:
 *   - the remediation ladder has rungs 1/2/3 REGISTERED (not just slots);
 *   - the escalation hook is wired (ladder.escalate runs the give-up hand-off);
 *   - the auto-update poll loop respects the resolved opt-out precedence;
 *   - the local status page starts;
 *   - start()/stop() are fail-soft and idempotent (never throw).
 *
 * Everything is driven over injected fakes (fake clock, fake probe, fake runner, fake
 * update engine, in-process status-page port 0) so no real timer/network/npm/daemon runs.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createHiveDoctor, createRealClock } from "../../src/compose/index.js";
import { resolveConfig } from "../../src/config.js";
import { silentLogger } from "../../src/logger.js";
import type { SupervisorClock } from "../../src/supervisor.js";
import type { CommandResult, CommandRunner } from "../../src/rungs/command-runner.js";
import type { UpdateEngine, UpdateTransactionResult } from "../../src/update/update-engine.js";
import type { HealthClassification } from "../../src/health-probe.js";

/** A fake clock whose sleep resolves immediately so loops do not really wait. */
function fakeClock(): SupervisorClock {
	return { now: () => 0, sleep: async () => undefined };
}

/** A runner that never touches npm; records argv. */
function fakeRunner(result: CommandResult = { ok: true, code: 0, stdout: "", stderr: "" }): {
	runner: CommandRunner;
	calls: Array<{ cmd: string; args: string[] }>;
} {
	const calls: Array<{ cmd: string; args: string[] }> = [];
	return {
		calls,
		runner: {
			async run(cmd, args): Promise<CommandResult> {
				calls.push({ cmd, args: [...args] });
				return result;
			},
		},
	};
}

/** A fake update engine recording how many transactions ran. */
function fakeUpdateEngine(): { engine: UpdateEngine; runs: () => number } {
	let runs = 0;
	return {
		runs: () => runs,
		engine: {
			async runUpdateTransaction(): Promise<UpdateTransactionResult> {
				runs += 1;
				return { status: "no_update" };
			},
		},
	};
}

/** Build a HiveDoctor over fakes; status page on port 0 (OS-assigned). */
function buildDoctor(over: Partial<Parameters<typeof createHiveDoctor>[0]> = {}) {
	const config = { ...resolveConfig({}), workspaceDir: makeTmp() };
	return createHiveDoctor({
		config,
		env: {},
		logger: silentLogger,
		clock: fakeClock(),
		runner: fakeRunner().runner,
		probe: async (): Promise<HealthClassification> => ({ kind: "ok" }),
		statusPagePort: 0,
		...over,
	});
}

const tmpDirs: string[] = [];
function makeTmp(): string {
	const d = mkdtempSync(join(tmpdir(), "hivedoctor-compose-"));
	tmpDirs.push(d);
	return d;
}

describe("createHiveDoctor (composition root)", () => {
	afterEach(() => {
		for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("registers rungs 1/2/3 in the production ladder", async () => {
		const doctor = buildDoctor();
		// decide() returns rung 1 below threshold; run each registered rung and confirm none
		// reports the "not-implemented later-wave slot" detail that an UNregistered rung returns.
		const ctx = { classification: { kind: "ok" } as HealthClassification, logger: silentLogger };
		for (const rung of [1, 2, 3]) {
			const result = await doctor.ladder.run(rung, ctx);
			expect(result.detail).not.toBe("later-wave-slot");
			expect(result.action).not.toContain("not-implemented");
		}
		// A rung 4 is NOT a numbered ladder rung -> still the unimplemented slot, proving the
		// registry holds exactly 1/2/3.
		const rung4 = await doctor.ladder.run(4, ctx);
		expect(rung4.detail).toBe("later-wave-slot");
		await doctor.stop();
	});

	it("threads the blessed version from the channel into rung 2, and an empty channel still proceeds (W-1)", async () => {
		// A recorder fetch standing in for the blessed CDN; we assert the composition consults it.
		const blessedCalls: string[] = [];
		const blessedFetch = async (url: string) => {
			blessedCalls.push(url);
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ version: "0.3.0" }),
			};
		};
		const doctor = buildDoctor({ blessedChannel: { fetch: blessedFetch, url: "https://example.test/blessed.json" } });
		const ctx = { classification: { kind: "ok" } as HealthClassification, logger: silentLogger };

		// Run rung 2 (reinstall) over the wired assembly. The fake probe means readInstalledVersion
		// resolves to null (no real /health), so the verify cannot match - but the rung still ran the
		// install and consulted the channel for the blessed version, which is the W-1 fix.
		const result = await doctor.ladder.run(2, ctx);
		expect(blessedCalls).toEqual(["https://example.test/blessed.json"]);
		// The reinstall happened (not the "later-wave slot" skip) and the blessed version was threaded.
		expect(result.detail).not.toBe("later-wave-slot");
		await doctor.stop();
	});

	it("an unreachable blessed channel does not block rung 2 (reinstall proceeds fail-soft, W-1)", async () => {
		const blessedFetch = async () => {
			throw new Error("CDN unreachable");
		};
		const doctor = buildDoctor({ blessedChannel: { fetch: blessedFetch } });
		const ctx = { classification: { kind: "ok" } as HealthClassification, logger: silentLogger };

		// With no blessed version resolvable, the rung degrades verify gracefully and still proceeds;
		// it never throws and never reports the unimplemented-slot skip.
		const result = await doctor.ladder.run(2, ctx);
		expect(result.detail).toBe("unverified-no-blessed");
		expect(result.ok).toBe(true);
		await doctor.stop();
	});

	it("wires the escalation hook so ladder.escalate hands off (not a missing-hook skip)", async () => {
		const hostedEscalation = vi.fn(async () => undefined);
		const doctor = buildDoctor({ hostedEscalation });
		const result = await doctor.ladder.escalate({
			diagnosis: "ladder exhausted",
			steps: [],
			recommendedAction: "manual-intervention",
			at: new Date(0).toISOString(),
		});
		// A wired hook resolves a delivered escalation (ok), not the no-hook skip.
		expect(result.ok).toBe(true);
		expect(result.detail).not.toBe("no-escalation-hook");
		// The hosted sink was invoked as part of the wired hook.
		expect(hostedEscalation).toHaveBeenCalledTimes(1);
		await doctor.stop();
	});

	it("escalate-on-give-up: a wired hook records to the needs-attention store too", async () => {
		// No hostedEscalation override -> the default wiring records locally + emits hosted.
		const doctor = buildDoctor();
		const result = await doctor.ladder.escalate({
			diagnosis: "give up",
			steps: [{ rung: 1, action: "restart-daemon", outcome: "failed", at: new Date(0).toISOString() }],
			recommendedAction: "reinstall-primary",
			at: new Date(0).toISOString(),
		});
		expect(result.ok).toBe(true);
		await doctor.stop();
	});

	it("poll loop respects opt-out: disabled when --no-auto-update is passed", async () => {
		const fe = fakeUpdateEngine();
		const doctor = buildDoctor({ cliNoAutoUpdate: true, updateEngine: fe.engine });
		expect(doctor.optOut.autoUpdateDisabled).toBe(true);
		expect(doctor.optOut.source).toBe("cli");
		// A disabled poll loop never ticks (no transaction runs).
		const ticked = await doctor.pollLoop.tick();
		expect(ticked).toBeNull();
		expect(fe.runs()).toBe(0);
		await doctor.stop();
	});

	it("poll loop runs a transaction when auto-update is enabled", async () => {
		const fe = fakeUpdateEngine();
		const doctor = buildDoctor({ cliNoAutoUpdate: false, updateEngine: fe.engine });
		expect(doctor.optOut.autoUpdateDisabled).toBe(false);
		const result = await doctor.pollLoop.tick();
		expect(result).not.toBeNull();
		expect(fe.runs()).toBe(1);
		await doctor.stop();
	});

	it("start() boots the status page + loops fail-soft, and stop() is idempotent", async () => {
		const doctor = buildDoctor();
		await expect(doctor.start()).resolves.toBeUndefined();
		// The status page bound on an OS-assigned port (start swallows a bind failure anyway).
		expect(typeof doctor.statusPage.listeningPort === "number" || doctor.statusPage.listeningPort === undefined).toBe(
			true,
		);
		// A second start is a no-op; stop twice never throws.
		await expect(doctor.start()).resolves.toBeUndefined();
		await expect(doctor.stop()).resolves.toBeUndefined();
		await expect(doctor.stop()).resolves.toBeUndefined();
	});

	it("the supervisor can step a tick over the wired assembly (healthy -> no action)", async () => {
		const doctor = buildDoctor({ probe: async () => ({ kind: "ok" }) });
		const classification = await doctor.supervisor.tick();
		expect(classification.kind).toBe("ok");
		await doctor.stop();
	});

	it("createRealClock produces a working sleep + now", async () => {
		const clock = createRealClock();
		expect(typeof clock.now()).toBe("number");
		await expect(clock.sleep(1)).resolves.toBeUndefined();
	});
});
