/**
 * The auto-update transaction engine (PRD-064e AC-064e.1 / .3 / .5 / .6). Every npm /
 * registry / CDN / health call runs through a fake seam -- NO test runs npm or hits the
 * network. The real install-lock runs against a temp workspace so AC-064e.6 (serialized
 * with rung 2) is proven on the SAME mutex the supervisor uses.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInstallLock } from "../../src/install-lock.js";
import { silentLogger } from "../../src/logger.js";
import type { BlessedFetchResult } from "../../src/update/blessed-channel.js";
import { createUpdateEngine, PRIMARY_PACKAGE, type UpdateEngineDeps } from "../../src/update/update-engine.js";
import type { UpdateEmit, UpdateTelemetryEvent } from "../../src/update/update-telemetry.js";
import { createFakeRunner, type FakeRunner } from "../helpers/fake-runner.js";

const DEVICE = "device-abc";
const INSTALLED = "0.1.7";
const BLESSED = "0.1.9";

/** A blessed-channel fetch stub that returns a fixed manifest (no network). */
function blessedFetch(version: string): UpdateEngineDeps["blessedOptions"] {
	return {
		url: "https://cdn.test/blessed-version.json",
		fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ version }) }),
	};
}

/** A recording update-emit seam so AC-064e.5 can assert from/to/outcome. */
function recordingEmit(): { emit: UpdateEmit; events: UpdateTelemetryEvent[] } {
	const events: UpdateTelemetryEvent[] = [];
	return {
		events,
		emit: async (event) => {
			events.push(event);
		},
	};
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hivedoctor-update-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function lock() {
	return createInstallLock({ workspaceDir: dir, logger: silentLogger });
}

/** Build an engine with sensible defaults that each test overrides as needed. */
function buildEngine(overrides: Partial<UpdateEngineDeps>): {
	deps: UpdateEngineDeps;
	runner: FakeRunner;
	events: UpdateTelemetryEvent[];
} {
	const runner = overrides.runner ? (overrides.runner as FakeRunner) : createFakeRunner();
	const rec = recordingEmit();
	const deps: UpdateEngineDeps = {
		runner,
		installLock: overrides.installLock ?? lock(),
		readLatestVersion: overrides.readLatestVersion ?? (async () => BLESSED),
		readInstalledVersion: overrides.readInstalledVersion ?? (async () => INSTALLED),
		restartDaemon: overrides.restartDaemon ?? (async () => undefined),
		verifyHealthy: overrides.verifyHealthy ?? (async () => true),
		blessedOptions: overrides.blessedOptions ?? blessedFetch(BLESSED),
		optOut: overrides.optOut ?? { autoUpdateDisabled: false },
		deviceId: overrides.deviceId ?? DEVICE,
		emit: overrides.emit ?? rec.emit,
		logger: overrides.logger ?? silentLogger,
		now: overrides.now ?? (() => 1_700_000_000_000),
		...(overrides.installTimeoutMs !== undefined ? { installTimeoutMs: overrides.installTimeoutMs } : {}),
	};
	return { deps, runner, events: rec.events };
}

describe("update transaction happy path (AC-064e.1)", () => {
	it("installs the blessed version, restarts, verifies healthy, and reports updated", async () => {
		const restartDaemon = vi.fn(async () => undefined);
		const verifyHealthy = vi.fn(async () => true);
		const { deps, runner, events } = buildEngine({ restartDaemon, verifyHealthy });

		const engine = createUpdateEngine(deps);
		const result = await engine.runUpdateTransaction();

		expect(result.status).toBe("updated");
		expect(result.fromVersion).toBe(INSTALLED);
		expect(result.toVersion).toBe(BLESSED);
		// It ran exactly `npm install -g @legioncodeinc/honeycomb@<blessed>` (AC-064e.1).
		expect(runner.calls).toEqual([{ command: "npm", args: ["install", "-g", `${PRIMARY_PACKAGE}@${BLESSED}`] }]);
		expect(restartDaemon).toHaveBeenCalledTimes(1);
		// Health is probed twice now: once for the PRE-update baseline (FIX 2), once post-update.
		expect(verifyHealthy).toHaveBeenCalledTimes(2);
		// A single update telemetry event, from/to/outcome (AC-064e.5).
		expect(events).toEqual([
			{
				kind: "update",
				fromVersion: INSTALLED,
				toVersion: BLESSED,
				outcome: "updated",
				deviceId: DEVICE,
				timestampMs: 1_700_000_000_000,
			},
		]);
	});

	it("does not update when @latest is newer but NOT blessed (gate holds, AC-064e.2)", async () => {
		const { deps, runner } = buildEngine({
			readLatestVersion: async () => "0.2.0", // newer than blessed 0.1.9
			blessedOptions: blessedFetch(BLESSED),
		});
		const result = await createUpdateEngine(deps).runUpdateTransaction();
		expect(result.status).toBe("no_update");
		expect(result.noUpdateReason).toBe("latest_not_blessed");
		expect(runner.calls).toHaveLength(0); // npm never touched
	});

	it("fails closed (no update) when the blessed channel is unreachable (AC-064e.2)", async () => {
		const { deps, runner } = buildEngine({
			blessedOptions: {
				url: "https://cdn.test/blessed-version.json",
				fetch: async () => {
					throw new Error("ECONNREFUSED");
				},
			},
		});
		const result = await createUpdateEngine(deps).runUpdateTransaction();
		expect(result.status).toBe("no_update");
		expect(result.noUpdateReason).toBe("blessed_unavailable");
		expect(runner.calls).toHaveLength(0);
	});
});

describe("rollback on failed post-update health (AC-064e.3)", () => {
	it("reinstalls the prior version, restarts, and recovers healthy on the old version", async () => {
		// Health probes, in order: (1) pre-update baseline=HEALTHY (so a regression is real),
		// (2) post-update=fails, (3) post-rollback=succeeds. The healthy->unhealthy regression
		// on a supervised daemon is exactly the case that MUST roll back (AC-064e.3).
		const healthSeq = [true, false, true];
		const verifyHealthy = vi.fn(async () => healthSeq.shift() ?? true);
		const restartDaemon = vi.fn(async () => undefined);
		const { deps, runner, events } = buildEngine({ verifyHealthy, restartDaemon });

		const result = await createUpdateEngine(deps).runUpdateTransaction();

		expect(result.status).toBe("rolled_back");
		// Two installs: the forward install to blessed, then the rollback to the prior version.
		expect(runner.calls).toEqual([
			{ command: "npm", args: ["install", "-g", `${PRIMARY_PACKAGE}@${BLESSED}`] },
			{ command: "npm", args: ["install", "-g", `${PRIMARY_PACKAGE}@${INSTALLED}`] },
		]);
		// Restart fired for both the update and the rollback; health checked three times now
		// (baseline + post-update + post-rollback).
		expect(restartDaemon).toHaveBeenCalledTimes(2);
		expect(verifyHealthy).toHaveBeenCalledTimes(3);
		// Both an update (the failed forward) and a rollback event were emitted (AC-064e.5).
		const kinds = events.map((e) => e.outcome);
		expect(kinds).toContain("rolled_back");
		const rollbackEvent = events.find((e) => e.kind === "rollback");
		expect(rollbackEvent).toMatchObject({ fromVersion: BLESSED, toVersion: INSTALLED, outcome: "rolled_back" });
	});

	it("reports rollback_failed when even the prior version cannot be restored", async () => {
		// Baseline HEALTHY then every subsequent probe fails: the daemon was healthy before, so a
		// post-update regression rolls back, and the rollback reinstall also fails to recover.
		const healthSeq = [true, false, false];
		const verifyHealthy = vi.fn(async () => healthSeq.shift() ?? false);
		const { deps, events } = buildEngine({ verifyHealthy });
		const result = await createUpdateEngine(deps).runUpdateTransaction();
		expect(result.status).toBe("rollback_failed");
		const rollbackEvent = events.find((e) => e.kind === "rollback");
		expect(rollbackEvent?.outcome).toBe("rollback_failed");
	});

	it("emits install_failed (and does not restart) when the forward npm install fails", async () => {
		const restartDaemon = vi.fn(async () => undefined);
		const runner = createFakeRunner(() => ({ ok: false, code: 1, stdout: "", stderr: "EACCES", detail: "EACCES" }));
		const { deps, events } = buildEngine({ runner, restartDaemon });
		const result = await createUpdateEngine(deps).runUpdateTransaction();
		expect(result.status).toBe("install_failed");
		expect(restartDaemon).not.toHaveBeenCalled();
		expect(events).toEqual([
			expect.objectContaining({ kind: "update", outcome: "install_failed", fromVersion: INSTALLED, toVersion: BLESSED }),
		]);
	});
});

describe("opt-out + pin (AC-064e.4)", () => {
	it("does not update (and never polls npm) when auto-update is disabled", async () => {
		const { deps, runner } = buildEngine({ optOut: { autoUpdateDisabled: true } });
		const result = await createUpdateEngine(deps).runUpdateTransaction();
		expect(result.status).toBe("no_update");
		expect(result.noUpdateReason).toBe("opted_out");
		expect(runner.calls).toHaveLength(0);
	});

	it("does not update when a version is pinned", async () => {
		const { deps, runner } = buildEngine({ optOut: { autoUpdateDisabled: false, pinnedVersion: INSTALLED } });
		const result = await createUpdateEngine(deps).runUpdateTransaction();
		expect(result.status).toBe("no_update");
		expect(result.noUpdateReason).toBe("pinned");
		expect(runner.calls).toHaveLength(0);
	});
});

describe("telemetry from/to/outcome (AC-064e.5)", () => {
	it("records from-version, to-version, and outcome on a successful update", async () => {
		const { deps, events } = buildEngine({});
		await createUpdateEngine(deps).runUpdateTransaction();
		expect(events).toHaveLength(1);
		const e = events[0];
		expect(e?.fromVersion).toBe(INSTALLED);
		expect(e?.toVersion).toBe(BLESSED);
		expect(e?.outcome).toBe("updated");
	});
});

describe("serialization with the watch loop's rung 2 (AC-064e.6)", () => {
	it("skips when the shared install lock is already held (no concurrent npm install)", async () => {
		const shared = lock();
		// Simulate rung 2's reinstall holding the lock when the poll tick fires.
		const held = shared.acquire("reinstall");
		expect(held).not.toBeNull();

		const { deps, runner } = buildEngine({ installLock: shared });
		const result = await createUpdateEngine(deps).runUpdateTransaction();

		expect(result.status).toBe("skipped_lock_held");
		expect(result.detail).toBe("install-lock-held");
		// Crucially, the auto-update engine did NOT run npm while rung 2 held the lock.
		expect(runner.calls).toHaveLength(0);
	});

	it("releases the lock after a successful update so rung 2 can later acquire it", async () => {
		const shared = lock();
		const { deps } = buildEngine({ installLock: shared });
		await createUpdateEngine(deps).runUpdateTransaction();
		// The auto-update transaction freed the mutex; rung 2 can now take it.
		const after = shared.acquire("reinstall");
		expect(after).not.toBeNull();
	});
});

describe("installed = globally-installed PACKAGE version, not the daemon /health version", () => {
	it("proceeds to update when the daemon is DOWN but the package reader reports an installed version (the live bug)", async () => {
		// The reproduced failure: daemon down -> /health version null, yet npm shows 0.1.7 on disk
		// and 0.1.9 is blessed. With "installed" sourced from the PACKAGE (not /health), the engine
		// must reach the apply path and update, NOT bail with skip_unknown_installed.
		const restartDaemon = vi.fn(async () => undefined);
		const verifyHealthy = vi.fn(async () => true);
		const { deps, runner } = buildEngine({
			// readInstalledVersion is the engine's seam; production wires the package reader here.
			readInstalledVersion: async () => INSTALLED, // 0.1.7 on disk
			readLatestVersion: async () => BLESSED, // 0.1.9 @latest
			blessedOptions: blessedFetch(BLESSED), // 0.1.9 blessed
			restartDaemon,
			verifyHealthy,
		});

		const result = await createUpdateEngine(deps).runUpdateTransaction();

		// It reached the apply/blessed-gate decision and updated, rather than skipping.
		expect(result.status).toBe("updated");
		expect(result.fromVersion).toBe(INSTALLED);
		expect(result.toVersion).toBe(BLESSED);
		expect(runner.calls).toEqual([{ command: "npm", args: ["install", "-g", `${PRIMARY_PACKAGE}@${BLESSED}`] }]);
	});

	it("still skips correctly when the package reader ALSO returns null (no rollback target at all)", async () => {
		const { deps, runner } = buildEngine({ readInstalledVersion: async () => null });
		const result = await createUpdateEngine(deps).runUpdateTransaction();
		expect(result.status).toBe("no_update");
		expect(runner.calls).toHaveLength(0);
	});

	it("labels the installed-unknown skip `installed_unknown`, NOT the mislabeled `latest_unknown`", async () => {
		const { deps } = buildEngine({ readInstalledVersion: async () => null });
		const result = await createUpdateEngine(deps).runUpdateTransaction();
		expect(result.noUpdateReason).toBe("installed_unknown");
		expect(result.detail).toBe("installed-version-unknown");
	});
});

describe("previewUpdate is a pure dry-run (FIX 1: `update --check` must not mutate)", () => {
	/** Wrap a real lock so a test can assert acquire() was NEVER called by preview. */
	function spyLock(): { installLock: ReturnType<typeof lock>; acquire: ReturnType<typeof vi.fn> } {
		const real = lock();
		const acquire = vi.fn((holder: string) => real.acquire(holder));
		return { installLock: { acquire }, acquire };
	}

	it("returns eligible with from/to when installed < blessed and latest == blessed, touching NOTHING", async () => {
		const restartDaemon = vi.fn(async () => undefined);
		const verifyHealthy = vi.fn(async () => true);
		const { installLock, acquire } = spyLock();
		const { deps, runner } = buildEngine({
			installLock,
			restartDaemon,
			verifyHealthy,
			readInstalledVersion: async () => INSTALLED, // 0.1.7
			readLatestVersion: async () => BLESSED, // 0.1.9
			blessedOptions: blessedFetch(BLESSED), // 0.1.9
		});

		const preview = await createUpdateEngine(deps).previewUpdate();

		expect(preview.eligible).toBe(true);
		expect(preview.fromVersion).toBe(INSTALLED);
		expect(preview.toVersion).toBe(BLESSED);
		// The whole point: preview never installs, never locks, never restarts, never verifies.
		expect(runner.calls).toHaveLength(0);
		expect(acquire).not.toHaveBeenCalled();
		expect(restartDaemon).not.toHaveBeenCalled();
		expect(verifyHealthy).not.toHaveBeenCalled();
	});

	it("returns not-eligible `latest_not_blessed` when @latest is newer but not blessed", async () => {
		const { installLock, acquire } = spyLock();
		const { deps, runner } = buildEngine({
			installLock,
			readLatestVersion: async () => "0.2.0",
			blessedOptions: blessedFetch(BLESSED),
		});
		const preview = await createUpdateEngine(deps).previewUpdate();
		expect(preview.eligible).toBe(false);
		expect(preview.reason).toBe("latest_not_blessed");
		expect(preview.fromVersion).toBe(INSTALLED);
		expect(runner.calls).toHaveLength(0);
		expect(acquire).not.toHaveBeenCalled();
	});

	it("returns not-eligible `already_current` when blessed is not newer than installed", async () => {
		const { deps, runner } = buildEngine({
			readInstalledVersion: async () => BLESSED, // already on blessed
			readLatestVersion: async () => BLESSED,
			blessedOptions: blessedFetch(BLESSED),
		});
		const preview = await createUpdateEngine(deps).previewUpdate();
		expect(preview.eligible).toBe(false);
		expect(preview.reason).toBe("already_current");
		expect(runner.calls).toHaveLength(0);
	});

	it("returns not-eligible `installed_unknown` (from=null) when the installed read fails", async () => {
		const { deps, runner } = buildEngine({ readInstalledVersion: async () => null });
		const preview = await createUpdateEngine(deps).previewUpdate();
		expect(preview.eligible).toBe(false);
		expect(preview.reason).toBe("installed_unknown");
		expect(preview.fromVersion).toBeNull();
		expect(runner.calls).toHaveLength(0);
	});

	it("returns not-eligible `opted_out` when auto-update is disabled (no mutation)", async () => {
		const { installLock, acquire } = spyLock();
		const { deps, runner } = buildEngine({ installLock, optOut: { autoUpdateDisabled: true } });
		const preview = await createUpdateEngine(deps).previewUpdate();
		expect(preview.eligible).toBe(false);
		expect(preview.reason).toBe("opted_out");
		expect(runner.calls).toHaveLength(0);
		expect(acquire).not.toHaveBeenCalled();
	});

	it("is crash-safe: a throwing read seam resolves to a not-eligible preview, never throws", async () => {
		const { deps } = buildEngine({
			readLatestVersion: async () => {
				throw new Error("registry exploded");
			},
		});
		const preview = await createUpdateEngine(deps).previewUpdate();
		expect(preview.eligible).toBe(false);
		expect(preview.reason).toBe("latest_unknown");
	});
});

describe("FIX 2: verify rule keyed on the PRE-update health baseline", () => {
	it("pre-healthy + post-unhealthy + supervised restart -> ROLLS BACK (unchanged safety, AC-064e.3)", async () => {
		// verifyHealthy is called: (1) pre-update baseline=healthy, (2) post-update=unhealthy,
		// (3) post-rollback=healthy. The healthy->unhealthy regression must roll back.
		const healthSeq = [true, false, true];
		const verifyHealthy = vi.fn(async () => healthSeq.shift() ?? true);
		const restartDaemon = vi.fn(async () => undefined); // void -> assumed supervised
		const { deps, runner, events } = buildEngine({ verifyHealthy, restartDaemon });

		const result = await createUpdateEngine(deps).runUpdateTransaction();

		expect(result.status).toBe("rolled_back");
		expect(runner.calls).toEqual([
			{ command: "npm", args: ["install", "-g", `${PRIMARY_PACKAGE}@${BLESSED}`] },
			{ command: "npm", args: ["install", "-g", `${PRIMARY_PACKAGE}@${INSTALLED}`] },
		]);
		const rollbackEvent = events.find((e) => e.kind === "rollback");
		expect(rollbackEvent?.outcome).toBe("rolled_back");
	});

	it("pre-UNHEALTHY + post-still-unhealthy -> NO rollback, status `updated_unverified`, install KEPT", async () => {
		// Baseline unhealthy, post-update still unhealthy. The update cannot make an already-down
		// daemon worse, so it must NOT roll back: keep the new bits and report updated_unverified.
		const healthSeq = [false, false];
		const verifyHealthy = vi.fn(async () => healthSeq.shift() ?? false);
		const restartDaemon = vi.fn(async () => undefined);
		const { deps, runner, events } = buildEngine({ verifyHealthy, restartDaemon });

		const result = await createUpdateEngine(deps).runUpdateTransaction();

		expect(result.status).toBe("updated_unverified");
		expect(result.fromVersion).toBe(INSTALLED);
		expect(result.toVersion).toBe(BLESSED);
		// Only ONE install (the forward one); the rollback reinstall NEVER happened.
		expect(runner.calls).toEqual([
			{ command: "npm", args: ["install", "-g", `${PRIMARY_PACKAGE}@${BLESSED}`] },
		]);
		// An update event was emitted with the honest updated_unverified outcome.
		expect(events).toEqual([
			expect.objectContaining({ kind: "update", outcome: "updated_unverified", fromVersion: INSTALLED, toVersion: BLESSED }),
		]);
	});

	it("no OS service to restart through (restart reports false) + post-unhealthy -> `updated_unverified`, no rollback", async () => {
		// Baseline healthy, but the restart seam reports false (no registered service / no daemon),
		// and /health is still unhealthy afterward. With no supervised daemon, a destructive rollback
		// would only discard the new version: keep it, report updated_unverified.
		const healthSeq = [true, false];
		const verifyHealthy = vi.fn(async () => healthSeq.shift() ?? false);
		const restartDaemon = vi.fn(async () => false); // false = no service / nothing restarted
		const { deps, runner } = buildEngine({ verifyHealthy, restartDaemon });

		const result = await createUpdateEngine(deps).runUpdateTransaction();

		expect(result.status).toBe("updated_unverified");
		expect(runner.calls).toEqual([
			{ command: "npm", args: ["install", "-g", `${PRIMARY_PACKAGE}@${BLESSED}`] },
		]);
	});

	it("pre-healthy + post-healthy -> committed `updated` (the normal success path)", async () => {
		const healthSeq = [true, true]; // baseline healthy, post-update healthy
		const verifyHealthy = vi.fn(async () => healthSeq.shift() ?? true);
		const { deps, runner } = buildEngine({ verifyHealthy });

		const result = await createUpdateEngine(deps).runUpdateTransaction();

		expect(result.status).toBe("updated");
		expect(result.toVersion).toBe(BLESSED);
		expect(runner.calls).toEqual([
			{ command: "npm", args: ["install", "-g", `${PRIMARY_PACKAGE}@${BLESSED}`] },
		]);
	});
});

describe("crash-safety / unknown installed version", () => {
	it("refuses to update when the installed version is unknown (no rollback target)", async () => {
		const { deps, runner } = buildEngine({ readInstalledVersion: async () => null });
		const result = await createUpdateEngine(deps).runUpdateTransaction();
		expect(result.status).toBe("no_update");
		expect(runner.calls).toHaveLength(0);
	});

	it("an unexpected throw in a seam resolves to a failed result, never a thrown error", async () => {
		const { deps } = buildEngine({
			readLatestVersion: async () => {
				throw new Error("registry exploded");
			},
		});
		const result = await createUpdateEngine(deps).runUpdateTransaction();
		expect(result.status).toBe("install_failed");
		expect(result.detail).toBe("registry exploded");
	});
});
