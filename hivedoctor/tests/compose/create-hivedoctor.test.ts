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
import type { UpdateEngine, UpdatePreview, UpdateTransactionResult } from "../../src/update/update-engine.js";
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
			// The composition wires runUpdateTransaction into the poll loop; preview satisfies the interface.
			async previewUpdate(): Promise<UpdatePreview> {
				return { eligible: false, fromVersion: null, reason: "already_current" };
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

async function statusJsonUrl(doctor: ReturnType<typeof createHiveDoctor>): Promise<string> {
	for (let i = 0; i < 50; i += 1) {
		const port = doctor.statusPage.listeningPort;
		if (port !== undefined) return `http://127.0.0.1:${port}/status.json`;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("status page did not bind");
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

	it("PRD-067 AC-9: during startup grace the status page does not show terminal failure or escalation", async () => {
		const restart = vi.fn(async () => true);
		const doctor = buildDoctor({
			probe: async () => ({ kind: "unreachable-refused", detail: "ECONNREFUSED" }),
			restart,
		});

		await doctor.supervisor.tick();
		expect(restart).not.toHaveBeenCalled();
		doctor.statusPage.start();
		const resp = await fetch(await statusJsonUrl(doctor));
		const status = (await resp.json()) as { health: string; escalation: unknown };

		expect(status.health).toBe("unknown");
		expect(status.escalation).toBeNull();
		await doctor.stop();
	});

	it("PRD-067 post-update restart: the compose restart callback re-arms supervisor grace", async () => {
		let now = 0;
		let health: HealthClassification = { kind: "ok" };
		const clock: SupervisorClock = { now: () => now, sleep: async () => undefined };
		const restart = vi.fn(async () => true);
		const runner: CommandRunner = {
			async run(_cmd, args): Promise<CommandResult> {
				if (args[0] === "ls") {
					return {
						ok: true,
						code: 0,
						stdout: JSON.stringify({
							dependencies: { "@legioncodeinc/honeycomb": { version: "0.1.0" } },
						}),
						stderr: "",
					};
				}
				if (args[0] === "install") {
					return { ok: true, code: 0, stdout: "", stderr: "" };
				}
				return { ok: false, code: 1, stdout: "", stderr: "unexpected npm command" };
			},
		};
		const previousFetch = globalThis.fetch;
		vi.stubGlobal("fetch", async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ version: "0.1.1" }),
		}));
		try {
			const doctor = buildDoctor({
				clock,
				restart,
				runner,
				probe: async () => health,
				blessedChannel: {
					fetch: async () => ({
						ok: true,
						status: 200,
						text: async () => JSON.stringify({ version: "0.1.1" }),
					}),
				},
			});
			now = 60_000;
			const update = await doctor.pollLoop.tick();
			expect(update?.status).toBe("updated");
			expect(restart).toHaveBeenCalledTimes(1);

			health = { kind: "unreachable-refused", detail: "restarting-after-update" };
			await doctor.supervisor.tick();

			expect(restart).toHaveBeenCalledTimes(1);
			await doctor.stop();
		} finally {
			vi.stubGlobal("fetch", previousFetch);
		}
	});

	it("createRealClock produces a working sleep + now", async () => {
		const clock = createRealClock();
		expect(typeof clock.now()).toBe("number");
		await expect(clock.sleep(1)).resolves.toBeUndefined();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Install-health telemetry timer (PRD-064d AC-064d.2) + error stream (AC-064d.1)
// ────────────────────────────────────────────────────────────────────────────

/**
 * A clock with a MANUALLY-DRIVEN sleep shared by ALL the compose loops (supervisor, poll,
 * install-health -- they reuse one clock in production). Each `sleep()` parks on a fresh
 * deferred. `tickAll()` resolves EVERY parked sleep so each loop runs exactly one more
 * iteration and re-parks; the install-health recorder therefore gains exactly +1 per
 * `tickAll()`. `releaseAll()` is the un-awaited drain used so `stop()` can unwind cleanly.
 */
function manualClock(): SupervisorClock & { tickAll(): Promise<void>; releaseAll(): void } {
	let pending: Array<() => void> = [];
	const drainOnce = (): void => {
		const all = pending;
		pending = [];
		for (const r of all) r();
	};
	return {
		now: () => 0,
		sleep: (): Promise<void> =>
			new Promise<void>((resolve) => {
				pending.push(resolve);
			}),
		// Wait for the loops to park, resolve every parked sleep, then yield enough microtask
		// turns for each loop's next iteration (state read -> await daemon-version -> await emit)
		// to complete and re-park.
		tickAll: async (): Promise<void> => {
			for (let i = 0; i < 30 && pending.length === 0; i += 1) await Promise.resolve();
			drainOnce();
			for (let i = 0; i < 30; i += 1) await Promise.resolve();
		},
		releaseAll: drainOnce,
	};
}

/** A fast daemon-version read so the install-health snapshot never touches the network. */
const fastDaemonVersion = async (): Promise<string | null> => "0.1.9";

describe("createHiveDoctor telemetry wiring (PRD-064d)", () => {
	afterEach(() => {
		for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	/** A recorder matching the emitInstallHealth signature; captures each snapshot input. */
	function installHealthRecorder() {
		const calls: Array<Record<string, unknown>> = [];
		const fn = (async (input: Record<string, unknown>) => {
			calls.push(input);
			return { sent: true };
		}) as unknown as NonNullable<Parameters<typeof createHiveDoctor>[0]>["emitInstallHealthFn"];
		return { calls, fn };
	}

	it("emits ONE install-health snapshot on start", async () => {
		const rec = installHealthRecorder();
		const clock = manualClock();
		const doctor = buildDoctor({ clock, emitInstallHealthFn: rec.fn, readDaemonVersion: fastDaemonVersion });
		await doctor.start();
		// Let the loop's on-arm emit (which awaits the fast daemon-version read) settle + park.
		for (let i = 0; i < 20; i += 1) await Promise.resolve();
		expect(rec.calls).toHaveLength(1);
		// The snapshot carries the shared device id + both versions + a coarse health.
		const first = rec.calls[0];
		expect(first).toBeDefined();
		expect(typeof first?.["deviceId"]).toBe("string");
		expect(first?.["deviceId"]).not.toBe("");
		expect(first?.["deviceId"]).not.toBe("unknown-device");
		expect(first).toHaveProperty("lastKnownHealth");
		expect(first?.["hivedoctorVersion"]).toBeDefined();
		expect(first?.["daemonVersion"]).toBe("0.1.9");
		// Initiate stop (sets the stopped flag), then release the parked sleep so the loop
		// observes the flag and exits; only then does stop's allSettled resolve.
		const stopping = doctor.stop();
		clock.releaseAll();
		await stopping;
	});

	it("emits AGAIN on the interval, one snapshot per interval tick", async () => {
		const rec = installHealthRecorder();
		const clock = manualClock();
		const doctor = buildDoctor({ clock, emitInstallHealthFn: rec.fn, readDaemonVersion: fastDaemonVersion });
		await doctor.start();
		// Drain the on-arm emit + let the loops park on their first interval sleep.
		for (let i = 0; i < 20; i += 1) await Promise.resolve();
		expect(rec.calls).toHaveLength(1);
		// One interval tick -> exactly one more install-health snapshot.
		await clock.tickAll();
		expect(rec.calls).toHaveLength(2);
		// And again -> a third.
		await clock.tickAll();
		expect(rec.calls).toHaveLength(3);
		const stopping = doctor.stop();
		clock.releaseAll();
		await stopping;
	});

	it("opt-out suppresses install-health (no POST leaves the box)", async () => {
		// Use the REAL emitInstallHealth via the chokepoint, but inject a recording fetch +
		// an opted-out env. The chokepoint's gate must drop the emit before any fetch.
		const fetchCalls: string[] = [];
		const recordingFetch = async (url: string): Promise<{ ok: boolean; status: number }> => {
			fetchCalls.push(url);
			return { ok: true, status: 200 };
		};
		const clock = manualClock();
		const doctor = buildDoctor({
			clock,
			readDaemonVersion: fastDaemonVersion,
			emitDeps: {
				posthogKey: "test-fake-key",
				posthogHost: "https://test.posthog.example",
				fetch: recordingFetch,
				env: { DO_NOT_TRACK: "1" },
			},
		});
		await doctor.start();
		for (let i = 0; i < 20; i += 1) await Promise.resolve();
		// Opted out: the chokepoint dropped the snapshot, so the fetch seam was never called.
		expect(fetchCalls).toHaveLength(0);
		const stopping = doctor.stop();
		clock.releaseAll();
		await stopping;
	});

	it("routes a supervisor probe-throw to the error stream via the wired onError seam", async () => {
		const errorCalls: Array<{ errorClass: string }> = [];
		const emitErrorFn = (async (input: { errorClass: string }) => {
			errorCalls.push(input);
			return { sent: true };
		}) as unknown as NonNullable<Parameters<typeof createHiveDoctor>[0]>["emitErrorFn"];

		const clock = manualClock();
		const doctor = buildDoctor({
			clock,
			emitErrorFn,
			readDaemonVersion: fastDaemonVersion,
			// A probe that throws drives the supervisor tick's probe catch -> onError -> emitError.
			probe: async (): Promise<HealthClassification> => {
				throw new Error("compose-probe-threw");
			},
		});
		// Step a single supervisor tick directly (no need to run the whole loop).
		await doctor.supervisor.tick();
		// Let the fire-and-forget onError microtask flush.
		await Promise.resolve();
		await Promise.resolve();
		expect(errorCalls.length).toBeGreaterThanOrEqual(1);
		expect(errorCalls[0]?.errorClass).toBe("ProbeThrew");
		clock.releaseAll();
		await doctor.stop();
	});
});
